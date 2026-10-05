'use strict';
/*
 * 领域服务：通知修订 / 审批 / 生效区间 / 覆盖小区 / 事件日志 / 时点清单重建
 *
 * 不变量：
 *  - 一次“发布/改期/撤回/背景更新”在单个事务内完成状态更新与事件追加：
 *    事件已落库即权威变更；“已发送给设备”绝不代表已撤屏。
 *  - 报名链接(link)与正文(body)在同一条 revision 上，整体审批、整体生效，
 *    屏幕端一个事件同时替换，杜绝“旧文字配新入口”。
 *  - 撤回 = UPSERT(tombstone) 生效区间：之后任何时点/as-of 重建都不可能再出现该通知。
 */
const db = require('./db');
const { now, hashStr } = require('./util');

const TYPES = ['water', 'power', 'activity', 'notice'];
const REVISION_DRAFT = 'draft', REVISION_SUBMITTED = 'submitted',
      REVISION_APPROVED = 'approved', REVISION_REJECTED = 'rejected',
      REVISION_SUPERSEDED = 'superseded';

function bad(msg, status = 400) { throw Object.assign(new Error(msg), { status }); }

function noticeView(n) {
  const revs = db.all('revisions', r => r.noticeId === n.id).sort((a, b) => b.version - a.version);
  return Object.assign({}, n, { revisions: revs.map(r => publicRevision(r)) });
}
function publicRevision(r) {
  return {
    id: r.id, version: r.version, status: r.status,
    title: r.title, body: r.body, link: r.link, type: r.type, urgent: !!r.urgent,
    communityId: r.communityId, start: r.start, end: r.end,
    editorId: r.editorId, approverId: r.approverId,
    createdAt: r.createdAt, submittedAt: r.submittedAt, decidedAt: r.decidedAt,
    decideNote: r.decideNote || '',
  };
}

function listNotices({ communityId, status } = {}) {
  let rows = db.all('notices');
  if (communityId) rows = rows.filter(n => n.communityId === communityId || n.communityId == null);
  const views = rows.map(noticeView);
  if (status) return views.filter(v => v.status === status);
  return views.sort((a, b) => b.updatedAt - a.updatedAt);
}
function getNotice(id) { const n = db.get('notices', id); return n ? noticeView(n) : null; }

function validatePayload(p) {
  if (!p || !String(p.title || '').trim()) bad('title_required');
  if (!String(p.body || '').trim()) bad('body_required');
  if (p.type && !TYPES.includes(p.type)) bad('bad_type');
  let start = Number(p.start), end = Number(p.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) bad('interval_required');
  if (end <= start) bad('interval_invalid');
  return {
    title: String(p.title).trim(),
    body: String(p.body).trim(),
    link: p.link ? String(p.link).trim() : '',
    type: p.type || 'notice',
    urgent: !!p.urgent,
    communityId: p.communityId == null ? null : Number(p.communityId),
    start, end,
  };
}

/* ---------- 编辑：新建 / 保存草稿 / 提交 ---------- */

function createNotice(actor, p) {
  const data = validatePayload(p);
  const nid = db.transaction(t => {
    const id = t.nextId('notices');
    const n = t.insert('notices', {
      id, currentVersion: 0, status: 'draft',
      communityId: data.communityId, type: data.type, urgent: data.urgent,
      createdAt: now(), updatedAt: now(), createdBy: actor.id,
    });
    addRevision(t, actor, n, data, REVISION_DRAFT);
    return id;
  });
  return getNotice(nid);
}

// 保存草稿：若已有待审批版本则不允许覆盖（防止绕过审批）
function saveDraft(actor, noticeId, p) {
  const n = db.get('notices', noticeId);
  if (!n) bad('not_found', 404);
  if (n.status === 'withdrawn') bad('notice_withdrawn_readonly');
  const data = validatePayload(p);
  return db.transaction(t => {
    const latest = latestRevision(n.id);
    let rev;
    if (latest && latest.status === REVISION_DRAFT) {
      rev = t.update('revisions', latest.id, Object.assign(data, { updatedAt: now() }));
    } else {
      if (latest && latest.status === REVISION_SUBMITTED) bad('pending_approval_exists', 409);
      rev = addRevision(t, actor, n, data, REVISION_DRAFT);
    }
    t.update('notices', n.id, {
      communityId: data.communityId, type: data.type, urgent: data.urgent, updatedAt: now(),
    });
    return publicRevision(rev);
  });
}

/**
 * 提交修订（创建新通知的首次提交，或已发布通知的改期/改文）。
 * expectedVersion：编辑所基于的最新版本；两人同时改期时后提交者会收到 409，必须先合并。
 */
function submitRevision(actor, noticeId, p, expectedVersion) {
  const n = db.get('notices', noticeId);
  if (!n) bad('not_found', 404);
  if (n.status === 'withdrawn') bad('notice_withdrawn_readonly');
  const latest = latestRevision(n.id);
  if (latest && latest.status === REVISION_SUBMITTED) bad('pending_approval_exists', 409);
  if (expectedVersion != null && n.currentVersion !== Number(expectedVersion))
    bad('version_conflict_expected_' + n.currentVersion, 409);
  const data = validatePayload(p);
  return db.transaction(t => {
    let rev;
    if (latest && latest.status === REVISION_DRAFT) {
      // 草稿提交 = 该候选修订进入审批，保留其版本号（首个发布版本即 v1）
      rev = t.update('revisions', latest.id, Object.assign({}, data, {
        status: REVISION_SUBMITTED, submittedAt: now(), updatedAt: now(), editorId: actor.id,
      }));
    } else {
      rev = addRevision(t, actor, n, data, REVISION_SUBMITTED, { submittedAt: now() });
    }
    t.update('notices', n.id, { updatedAt: now() });
    return publicRevision(rev);
  });
}

function addRevision(t, actor, n, data, status, extra) {
  const version = t.nextSeq('notice_' + n.id); // 每个通知内部从 1 递增
  const rev = t.insert('revisions', Object.assign({
    id: t.nextId('revisions'), noticeId: n.id, version, status,
    editorId: actor.id, createdAt: now(), updatedAt: now(),
  }, data, extra || {}));
  return rev;
}
function latestRevision(noticeId) {
  return db.all('revisions', r => r.noticeId === noticeId)
    .sort((a, b) => b.version - a.version)[0] || null;
}

/* ---------- 审批 ---------- */

function decideRevision(actor, revId, approve, note) {
  const rev = db.get('revisions', revId);
  if (!rev || rev.status !== REVISION_SUBMITTED) bad('revision_not_decisionable', 409);
  const n = db.get('notices', rev.noticeId);
  db.transaction(t => {
    if (approve) {
      // 同一通知的旧已批准版本随新版本生效而终结（事件层 UPSERT 覆盖其区间）
      t.update('revisions', revId, {
        status: REVISION_APPROVED, approverId: actor.id, decidedAt: now(), decideNote: note || '',
      });
      const noticePatch = {
        currentVersion: rev.version, status: 'published',
        communityId: rev.communityId, type: rev.type, urgent: rev.urgent, updatedAt: now(),
      };
      t.update('notices', n.id, noticePatch);
      appendEvent(t, {
        type: n.currentVersion === 0 ? 'notice_publish' : 'notice_update',
        noticeId: n.id, version: rev.version, revisionId: rev.id,
        payload: {
          id: n.id, version: rev.version, title: rev.title, body: rev.body, link: rev.link,
          type: rev.type, urgent: rev.urgent, communityId: rev.communityId,
          start: rev.start, end: rev.end,
        },
      }, actor);
    } else {
      t.update('revisions', revId, {
        status: REVISION_REJECTED, approverId: actor.id, decidedAt: now(), decideNote: note || '',
      });
      t.update('notices', n.id, { updatedAt: now() });
    }
  });
  return publicRevision(db.get('revisions', revId));
}

/* ---------- 撤回（强制失效） ---------- */

function withdrawNotice(actor, noticeId, reason) {
  const n = db.get('notices', noticeId);
  if (!n) bad('not_found', 404);
  if (n.status === 'withdrawn') bad('already_withdrawn', 409);
  const at = now();
  db.transaction(t => {
    t.update('notices', noticeId, { status: 'withdrawn', withdrawnAt: at, updatedAt: at });
    // 作废任何在途待审批版本
    db.all('revisions', r => r.noticeId === noticeId && r.status === REVISION_SUBMITTED)
      .forEach(r => t.update('revisions', r.id, { status: REVISION_SUPERSEDED, decidedAt: at }));
    appendEvent(t, { type: 'notice_withdraw', noticeId, version: n.currentVersion, payload: { reason: reason || '' } }, actor);
  });
  return getNotice(noticeId);
}

/* ---------- 背景资产 ---------- */

function activeBackgrounds() { return db.all('bg_assets', b => b.active === 1).sort((a, b) => a.id - b.id); }
function createBackground(actor, bg) {
  if (!bg || !bg.value) bad('bg_value_required');
  return db.transaction(t => {
    const row = t.insert('bg_assets', {
      id: t.nextId('bg_assets'), name: bg.name || ('背景' + Date.now()),
      kind: bg.kind || 'gradient', value: bg.value, active: 1, createdAt: now(),
    });
    appendEvent(t, { type: 'bg_update', bgAssetId: row.id, payload: listBgPayload() }, actor);
    return row;
  });
}
function listBgPayload() {
  return activeBackgrounds().map(b => ({ id: b.id, name: b.name, kind: b.kind, value: b.value }));
}
function removeBackground(actor, id) {
  return db.transaction(t => {
    t.update('bg_assets', id, { active: 0 });
    appendEvent(t, { type: 'bg_update', bgAssetId: id, payload: listBgPayload() }, actor);
  });
}

/* ---------- 事件日志 ---------- */

function appendEvent(t, e, actor) {
  const id = t.nextId('events');
  const row = t.insert('events', {
    id, type: e.type, noticeId: e.noticeId || null, version: e.version || null,
    revisionId: e.revisionId || null, bgAssetId: e.bgAssetId || null,
    payload: e.payload, actorId: actor ? actor.id : null, createdAt: now(),
  });
  return row;
}
const eventsAfter = (id) => db.all('events', e => e.id > id).sort((a, b) => a.id - b.id);
const lastEventId = () => db.all('events').reduce((m, e) => Math.max(m, e.id), 0);

/** 调度所需的“当前生效定义”：每个通知仅其当前已批准版本的区间；撤回即墓碑（不出现）。 */
function currentActiveDefs(at = now()) {
  const out = [];
  for (const n of db.all('notices', x => x.status === 'published')) {
    const rev = db.all('revisions', r => r.noticeId === n.id && r.status === REVISION_APPROVED)
      .sort((a, b) => b.version - a.version)[0];
    if (!rev) continue;
    if (rev.start <= at && at < rev.end) {
      out.push({
        id: n.id, version: rev.version, title: rev.title, body: rev.body, link: rev.link,
        type: rev.type, urgent: rev.urgent, communityId: rev.communityId,
        start: rev.start, end: rev.end,
      });
    }
  }
  return out;
}

/**
 * 时点(as-of)清单重建：从事件流折叠出某时刻大屏“应当显示”的通知定义。
 * 用于把历史截图关联到“当时真正有效的清单”，审计撤屏是否到位。
 */
function defsAt(at) {
  const state = new Map(); // noticeId -> version def
  for (const e of db.all('events').sort((a, b) => a.id - b.id)) {
    if (e.createdAt > at) break;
    if (e.type === 'notice_publish' || e.type === 'notice_update') {
      state.set(e.noticeId, Object.assign({ _event: e.id }, e.payload));
    } else if (e.type === 'notice_withdraw') {
      state.delete(e.noticeId);
    }
  }
  return [...state.values()].filter(d => d.start <= at && at < d.end);
}

/* ---------- 下发包：完整 / 增量 ---------- */

function fullPackage(screenId, serverTime) {
  const sc = db.get('screens', screenId);
  const defs = currentActiveDefs(serverTime)
    .filter(d => d.communityId == null || d.communityId === sc.communityId);
  const events = db.all('events').sort((a, b) => a.id - b.id);
  return {
    mode: 'full', serverTime, eventId: lastEventId(),
    notices: defs,
    tombstones: db.all('notices', n => n.status === 'withdrawn').map(n => n.id),
    backgrounds: listBgPayload(),
    events,
    scheduleHash: scheduleHash(serverTime, sc.communityId),
  };
}

function deltaPackage(screenId, fromEventId, serverTime) {
  const sc = db.get('screens', screenId);
  const evs = eventsAfter(fromEventId);
  const defs = currentActiveDefs(serverTime)
    .filter(d => d.communityId == null || d.communityId === sc.communityId);
  const tombstones = db.all('notices', n => n.status === 'withdrawn').map(n => n.id);
  let backgrounds = null;
  if (evs.some(e => e.type === 'bg_update')) backgrounds = listBgPayload();
  return {
    mode: 'delta', serverTime, fromEventId, eventId: lastEventId(),
    events: evs,
    // 附带当前权威集合，设备可据此做对账与追平（防止中间事件丢失）
    currentIds: defs.map(d => d.id),
    notices: defs,
    tombstones,
    backgrounds,
    scheduleHash: scheduleHash(serverTime, sc.communityId),
    resyncRequired: evs.length === 0 && lastEventId() > fromEventId ? false : undefined,
  };
}

function scheduleHash(serverTime, communityId) {
  const defs = currentActiveDefs(serverTime)
    .filter(d => d.communityId == null || d.communityId === communityId);
  const s = defs.map(d => `${d.id}@${d.version}:${d.start}-${d.end}${d.urgent ? 'U' : ''}`).sort().join('|');
  return hashStr(s + '#' + listBgPayload().map(b => b.id).join(','));
}

module.exports = {
  TYPES, REVISION_DRAFT, REVISION_SUBMITTED, REVISION_APPROVED, REVISION_REJECTED, REVISION_SUPERSEDED,
  listNotices, getNotice, createNotice, saveDraft, submitRevision, decideRevision, withdrawNotice,
  activeBackgrounds, listBgPayload, createBackground, removeBackground,
  eventsAfter, lastEventId, currentActiveDefs, defsAt,
  fullPackage, deltaPackage, scheduleHash,
};
