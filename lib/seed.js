'use strict';
const db = require('./db');
const { now } = require('./util');

function ensure() {
  if (db.get('meta', 1)) return;
  db.transaction(t => {
    t.put('meta', 1, { id: 1, seededAt: now(), version: 1 });
    for (const u of [
      { id: 1, username: 'editor1', name: '编辑员甲', role: 'editor' },
      { id: 2, username: 'editor2', name: '编辑员乙', role: 'editor' },
      { id: 3, username: 'approver1', name: '审批员', role: 'approver' },
      { id: 4, username: 'admin', name: '管理员', role: 'admin' },
    ]) t.insert('users', u);
    for (const c of [
      { id: 1, name: '阳光花园小区' },
      { id: 2, name: '和平里小区' },
    ]) t.insert('communities', c);
    // 两台大屏，分别归属两个小区
    for (const s of [
      { id: 1, code: 'SCR-YG-01', name: '阳光花园东门大屏', communityId: 1, createdAt: now() },
      { id: 2, code: 'SCR-HP-01', name: '和平里中心大屏', communityId: 2, createdAt: now() },
    ]) t.insert('screens', s);
    for (const bg of [
      { id: 1, name: '清晨蓝', kind: 'gradient',
        value: 'linear-gradient(135deg,#0f2027 0%,#203a43 50%,#2c5364 100%)', active: 1, createdAt: now() },
    ]) t.insert('bg_assets', bg);
    for (const id of [1, 2]) t.insert('screen_state', {
      screenId: id, online: 0, lastHb: null, clockOffset: 0, lastAppliedEventId: 0,
      scheduleHash: null, lastFullSync: null, bgAssetId: 1, bgStatus: 'ready',
      offlineSince: null, ttlMs: 30 * 60 * 1000, lastSnapshotId: null,
    });
  });
}
module.exports = { ensure };
