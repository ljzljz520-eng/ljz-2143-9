'use strict';
/*
 * 设备侧状态与“已撤屏”确认：
 *  - 心跳返回服务器时间用于时钟校正；记录设备自报时钟偏移、倒退事件。
 *  - 设备每应用一批事件必须回 ACK(lastAppliedEventId, appliedNoticeIds)。
 *  - 撤回确认依据：该屏最后一次 ACK 的快照里不再含该通知。
 *    => 后台只能在设备确认后标记“已撤屏”，不能凭“已发送事件”声称撤屏。
 *  - 截图(快照)带时间戳，关联当时有效清单 defsAt，可事后审计。
 */
const db = require('./db');
const domain = require('./domain');
const { now } = require('./util');

const ONLINE_GRACE_MS = 20000;

function getState(screenId) { return db.get('screen_state', screenId); }

function heartbeat(screenId, body = {}) {
  const st = getState(screenId);
  if (!st) throw Object.assign(new Error('screen_not_found'), { status: 404 });
  const serverTime = now();
  const deviceTime = Number(body.deviceTime);
  const offset = Number.isFinite(deviceTime) ? deviceTime - serverTime : (st.clockOffset || 0);
  const clockBack = Number.isFinite(deviceTime) && st.lastDeviceTime != null && deviceTime < st.lastDeviceTime - 2000;
  return db.transaction(t => {
    const patch = {
      online: 1, lastHb: serverTime,
      lastDeviceTime: Number.isFinite(deviceTime) ? deviceTime : st.lastDeviceTime,
      clockOffset: offset, offlineSince: null,
    };
    if (body.scheduleHash != null) patch.scheduleHash = body.scheduleHash;
    if (body.bgStatus != null) patch.bgStatus = body.bgStatus;
    if (body.bgAssetId != null) patch.bgAssetId = body.bgAssetId;
    if (body.lastAppliedEventId != null) patch.lastAppliedEventId = body.lastAppliedEventId;
    if (clockBack) {
      t.insert('clock_incidents', {
        id: t.nextId('clock_incidents'), screenId, at: serverTime,
        from: st.lastDeviceTime, to: deviceTime, kind: 'backward', handled: 1,
      });
    }
    t.update('screen_state', screenId, patch);
    return {
      serverTime,
      // 设备应用：correctedNow = deviceNow + (-offset)
      correctionMs: -offset,
      clockBack,
      onlineGraceMs: ONLINE_GRACE_MS,
      authoritativeHash: domain.scheduleHash(serverTime, db.get('screens', screenId).communityId),
    };
  });
}

/** 设备确认已应用事件；appliedIds 为设备当前正在轮播的权威通知 id 集合。 */
function acknowledge(screenId, body = {}) {
  const st = getState(screenId);
  if (!st) throw Object.assign(new Error('screen_not_found'), { status: 404 });
  const eventId = Number(body.lastAppliedEventId || 0);
  const appliedIds = Array.isArray(body.appliedNoticeIds) ? body.appliedNoticeIds.map(Number) : null;
  const serverTime = now();
  return db.transaction(t => {
    t.insert('event_acks', {
      id: t.nextId('event_acks'), screenId, eventId,
      appliedIds: appliedIds ? JSON.stringify(appliedIds) : null,
      scheduleHash: body.scheduleHash || null, at: serverTime,
    });
    const patch = { lastAppliedEventId: eventId };
    if (appliedIds) patch.lastAppliedIds = JSON.stringify(appliedIds);
    if (body.bgStatus != null) { patch.bgStatus = body.bgStatus; patch.bgAssetId = body.bgAssetId || st.bgAssetId; }
    if (body.scheduleHash != null) patch.scheduleHash = body.scheduleHash;
    t.update('screen_state', screenId, patch);
    return { ok: true, serverTime };
  });
}

/**
 * 设备上报一帧截图/显示状态。服务端把“当时有效清单（事件流 as-of 重建）”一起归档，
 * 使历史截图能关联到当时有效清单。
 */
function reportSnapshot(screenId, body = {}) {
  const st = getState(screenId);
  if (!st) throw Object.assign(new Error('screen_not_found'), { status: 404 });
  const at = Number(body.at || now());
  const shownIds = Array.isArray(body.shownNoticeIds) ? body.shownNoticeIds.map(Number) : [];
  const effective = domain.defsAt(at)
    .filter(d => {
      const sc = db.get('screens', screenId);
      return d.communityId == null || d.communityId === sc.communityId;
    });
  return db.transaction(t => {
    const row = t.insert('screen_snapshots', {
      id: t.nextId('screen_snapshots'), screenId, at,
      shownIds: JSON.stringify(shownIds),
      effectiveIds: JSON.stringify(effective.map(d => ({ id: d.id, version: d.version }))),
      currentSlotId: body.currentSlotId == null ? null : Number(body.currentSlotId),
      scheduleHash: body.scheduleHash || null,
      mode: body.mode || 'online',
      bgAssetId: body.bgAssetId == null ? st.bgAssetId : Number(body.bgAssetId),
    });
    t.update('screen_state', screenId, { lastSnapshotId: row.id });
    return { id: row.id, effective: effective.map(d => ({ id: d.id, version: d.version, title: d.title })) };
  });
}

function listSnapshots(screenId, limit = 50) {
  return db.all('screen_snapshots', s => s.screenId === screenId)
    .sort((a, b) => b.at - a.at).slice(0, limit)
    .map(s => Object.assign({}, s, {
      shownIds: JSON.parse(s.shownIds || '[]'),
      effectiveIds: JSON.parse(s.effectiveIds || '[]'),
    }));
}

function markOfflineIfStale() {
  const t = now();
  for (const st of db.all('screen_state')) {
    if (st.online && (!st.lastHb || t - st.lastHb > ONLINE_GRACE_MS)) {
      db.transaction(tx => tx.update('screen_state', st.screenId, {
        online: 0, offlineSince: st.offlineSince || st.lastHb || t,
      }));
    }
  }
}

/**
 * 各屏“实际版本 + 待确认项”。
 * 撤回待确认：撤回通知仍出现在该屏最后 ACK 的 appliedIds 中。
 * 发布/改期待确认：设备应用的事件水位落后于该通知发布事件 id。
 */
function fleetStatus() {
  markOfflineIfStale();
  const t = now();
  const lastEvent = domain.lastEventId();
  return db.all('screens').map(sc => {
    const st = getState(sc.id);
    const ackRows = db.all('event_acks', a => a.screenId === sc.id).sort((a, b) => b.id - a.id);
    const lastAck = ackRows[0] || null;
    const applied = lastAck && lastAck.appliedIds ? JSON.parse(lastAck.appliedIds) : [];
    const pending = [];

    for (const n of db.all('notices')) {
      const targetComm = n.communityId == null || n.communityId === sc.communityId;
      if (!targetComm) continue;
      if (n.status === 'withdrawn') {
        const evt = db.find('events', e => e.type === 'notice_withdraw' && e.noticeId === n.id);
        if (applied.includes(n.id)) {
          pending.push({ kind: 'withdraw_unconfirmed', noticeId: n.id,
            title: _title(n.id), eventId: evt ? evt.id : null });
        }
      } else if (n.status === 'published') {
        const rev = db.all('revisions', r => r.noticeId === n.id && r.status === 'approved')
          .sort((a, b) => b.version - a.version)[0];
        const evt = rev && db.find('events', e => e.revisionId === rev.id);
        const onVersion = applied.includes(n.id) && st.lastAppliedEventId >= (evt ? evt.id : 0);
        if (!onVersion) {
          pending.push({ kind: 'publish_unconfirmed', noticeId: n.id, title: _title(n.id),
            version: rev ? rev.version : null, eventId: evt ? evt.id : null });
        }
      }
    }
    const bgPending = st.bgStatus !== 'ready';
    return {
      screenId: sc.id, code: sc.code, name: sc.name, communityId: sc.communityId,
      online: !!st.online, lastHb: st.lastHb,
      lastDeviceTime: st.lastDeviceTime || null, clockOffset: st.clockOffset || 0,
      lastAppliedEventId: st.lastAppliedEventId || 0,
      serverEventId: lastEvent,
      behindEvents: Math.max(0, lastEvent - (st.lastAppliedEventId || 0)),
      appliedNoticeIds: applied,
      scheduleHash: st.scheduleHash || null,
      bgAssetId: st.bgAssetId, bgStatus: st.bgStatus, bgPending,
      offlineSince: st.offlineSince || null,
      lastAckAt: lastAck ? lastAck.at : null,
      pending,
    };
  });
}
function _title(noticeId) {
  const n = db.get('notices', noticeId);
  if (!n) return '#' + noticeId;
  const rev = db.all('revisions', r => r.noticeId === noticeId)
    .sort((a, b) => b.version - a.version)[0];
  return rev ? rev.title : ('#' + noticeId);
}

function listClockIncidents(screenId) {
  return db.all('clock_incidents', c => !screenId || c.screenId === screenId)
    .sort((a, b) => b.at - a.at);
}

module.exports = {
  ONLINE_GRACE_MS,
  getState, heartbeat, acknowledge, reportSnapshot, listSnapshots,
  fleetStatus, markOfflineIfStale, listClockIncidents,
};
