'use strict';
/*
 * 轮播调度器（确定性、可重放；浏览器与 Node 共用）
 *
 * 调度规则（与 README/验收测试一致）：
 *  1) 时间轴按 SLOT_MS（默认 8s）切槽，切换只发生在槽边界 => 每条上屏通知至少完整展示一个槽。
 *  2) 槽 [s, s+SLOT_MS) 只选取在整个槽区间内都有效的通知（start<=s 且 end>=s+SLOT_MS），
 *     因此生效区间跨过午夜天然连续；到期通知允许演完当前槽，之后立刻撤下，绝不补播。
 *  3) 紧急(urgent)通知可插播：在槽边界优先取紧急通知；但受防饥饿闸约束——
 *     任一普通有效通知距离上次上屏（首次为生效起点）已等待 >= ANTI_STARVE_MS(30s) 时，
 *     该普通通知强制占用本槽（等待最久者优先）。
 *  => 普通通知最长等待上界 = ANTI_STARVE_MS + SLOT_MS = 38s，不会被紧急流永久饥饿。
 *  4) 同组内按“最久未上屏”轮转，平局以 id 升序，保证可复现。
 *  5) 没有任何可播通知时输出 idle 槽（仅背景+时钟），不留黑屏。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Scheduler = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const SLOT_MS = 8000;
  const ANTI_STARVE_MS = 30000;
  const BG_MS = 20000;

  function slotGridStart(t, slotMs = SLOT_MS) { return Math.floor(t / slotMs) * slotMs; }

  function covers(n, s, e, communityId) {
    if (communityId != null && n.communityId != null && n.communityId !== communityId) return false;
    return n.start <= s && n.end >= e;
  }

  /**
   * 计算一个槽播什么。state.lastShown 会被原地更新。
   * active: [{id, urgent, start, end, communityId?}]
   */
  function slotAt(active, s, communityId, state, opts = {}) {
    const slotMs = opts.slotMs || SLOT_MS;
    const anti = opts.antiStarveMs != null ? opts.antiStarveMs : ANTI_STARVE_MS;
    const e = s + slotMs;
    const elig = active.filter(n => covers(n, s, e, communityId));
    if (!elig.length) { state.lastSlot = { kind: 'idle', s, e }; return state.lastSlot; }

    const ls = (n) => (state.lastShown[n.id] != null ? state.lastShown[n.id] : Math.min(n.start, s));
    const normals = elig.filter(n => !n.urgent);
    const urgents = elig.filter(n => n.urgent);

    // 防饥饿：找出已到等待上限的普通通知（最久未上屏优先）
    const starved = normals
      .map(n => ({ n, wait: s - ls(n) }))
      .filter(x => x.wait >= anti)
      .sort((a, b) => (b.wait - a.wait) || (a.n.id - b.n.id));

    let pick;
    if (starved.length) pick = starved[0].n;
    else if (urgents.length) pick = urgents.sort((a, b) => (ls(a) - ls(b)) || (a.id - b.id))[0];
    else pick = normals.sort((a, b) => (ls(a) - ls(b)) || (a.id - b.id))[0];

    state.lastShown[pick.id] = s;
    state.lastSlot = { kind: pick.urgent ? 'urgent' : 'normal', id: pick.id, s, e };
    return state.lastSlot;
  }

  /** 计算窗口 [from,to) 的完整排期。 */
  function computePlan(active, from, to, communityId, opts = {}) {
    const slotMs = opts.slotMs || SLOT_MS;
    const state = { lastShown: {}, lastSlot: null };
    const slots = [];
    for (let s = slotGridStart(from, slotMs); s < to; s += slotMs) {
      slots.push(slotAt(active, s, communityId, state, opts));
    }
    return { slots, slotMs, antiStarveMs: opts.antiStarveMs || ANTI_STARVE_MS };
  }

  /** 背景轮播索引：背景独立按 BG_MS 轮转，与通知槽叠加（通知是叠加层，背景是底图）。 */
  function bgIndexAt(t, count, bgMs = BG_MS, offset = 0) {
    if (!count) return -1;
    return (Math.floor(t / bgMs) + offset) % count;
  }

  /** 校验给定槽序列是否满足最低展示/防饥饿/到期规则（测试与设备自检用）。 */
  function auditPlan(slots, active, opts = {}) {
    const slotMs = opts.slotMs || SLOT_MS;
    const anti = opts.antiStarveMs || ANTI_STARVE_MS;
    const issues = [];
    const lastShown = {};
    for (const sl of slots) {
      if (sl.s % slotMs !== 0 || (sl.e - sl.s) !== slotMs) issues.push(`bad_slot_grid@${sl.s}`);
      if (sl.kind === 'idle') continue;
      const n = active.find(x => x.id === sl.id);
      if (!n) { issues.push(`missing_notice#${sl.id}@${sl.s}`); continue; }
      if (n.start > sl.s || n.end < sl.e) issues.push(`shown_outside_interval#${n.id}@${sl.s}`);
      if (!n.urgent) {
        const prev = lastShown[n.id] != null ? lastShown[n.id] : n.start;
        if (sl.s - prev > anti + slotMs) issues.push(`starved#${n.id} gap=${sl.s - prev}`);
      }
      lastShown[n.id] = sl.s;
    }
    return { ok: issues.length === 0, issues };
  }

  return { SLOT_MS, ANTI_STARVE_MS, BG_MS, slotGridStart, slotAt, computePlan, bgIndexAt, auditPlan };
});
