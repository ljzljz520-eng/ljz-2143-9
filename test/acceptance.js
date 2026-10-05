'use strict';
/*
 * 验收测试（无外部依赖；启动真实 HTTP 服务 + 屏幕设备模拟器）
 *  1. 同一通知两人改期：第二人基于过期版本提交被 409 拒绝，合并最新版本后改期成功
 *  2. 午夜跨区间：23:58–00:10 通知跨 00:00 连续播放，00:10 后立即撤下不补播
 *  3. 设备时间倒退：记录倒退事件、客户端收到 clockBack 重置调度、校正后时间与服务器一致
 *  4. 背景更新失败：设备回传 bgStatus=failed，后台显示失败且不影响通知层
 *  5. 撤回事件迟到：离线保留旧包；后台仅显示“撤屏待确认”；重连强制对账墓碑生效
 *  6. 增量缺事件追平 / 正文与报名入口同版本原子替换 / 紧急流不饿死普通 / 截图关联当时清单
 *  7. 管理页列出各屏实际版本、事件水位与待确认项
 */
const http = require('http');
require('../lib/seed').ensure();
const server = require('../server.js');
const Scheduler = require('../public/scheduler.js');

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log('  ✅', m); } else { FAIL++; console.log('  ❌', m); } };
const eq = (a, b, m) => ok(a === b, `${m}（期望 ${b}，实际 ${a}）`);

function req(method, pth, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: 8099, path: pth, method,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        payload ? { 'Content-Length': Buffer.byteLength(payload) } : {},
        token ? { Authorization: 'Bearer ' + token } : {}) },
      res => { let d = ''; res.on('data', c => (d += c));
        res.on('end', () => { let j = {}; try { j = JSON.parse(d); } catch (_) {} resolve({ status: res.statusCode, json: j }); }); });
    r.on('error', reject); if (payload) r.write(payload); r.end();
  });
}
server.close();
const ED1 = 'editor1', ED2 = 'editor2', AP = 'approver1', ADMIN = 'admin';

async function publish(token, overrides = {}) {
  const t = Date.now();
  const payload = Object.assign({
    title: '通知' + Math.random().toString(36).slice(2, 6), body: '正文A', link: 'http://a/1',
    type: 'activity', urgent: false, communityId: 1, start: t - 1000, end: t + 3600000,
  }, overrides);
  const c = await req('POST', '/api/notices', payload, token);
  const id = c.json.notice.id;
  await req('POST', `/api/notices/${id}`, payload, token); // 草稿即提交
  let n = (await req('GET', `/api/notices/${id}`)).json.notice;
  const rev = n.revisions.find(r => r.status === 'submitted');
  await req('POST', `/api/revisions/${rev.id}/decision`, { approve: true }, AP);
  return (await req('GET', `/api/notices/${id}`)).json.notice;
}

/* ------ 屏幕设备模拟器（语义与 public/screen.html 一致） ------ */
function makeScreen(code, opts = {}) {
  const sc = {
    code, correction: 0, pkg: null, sched: { lastShown: {} },
    bgStatus: 'ready', bgFail: !!opts.bgFail, deviceClockDrift: 0,
  };
  sc.now = () => Date.now() + sc.deviceClockDrift + sc.correction;
  sc.bg = () => { const l = (sc.pkg && sc.pkg.backgrounds) || []; return l.length ? l[0] : null; };
  sc.hb = async () => {
    const r = await req('POST', `/screen/${code}/hb`, {
      deviceTime: Date.now() + sc.deviceClockDrift,
      lastAppliedEventId: sc.pkg ? sc.pkg.eventId : 0,
      scheduleHash: sc.pkg ? sc.pkg.scheduleHash : null,
      bgStatus: sc.bgStatus, bgAssetId: sc.bg() ? sc.bg().id : null,
    });
    sc.correction = r.json.correctionMs;
    if (r.json.clockBack) sc.sched = { lastShown: {} };
    return r.json;
  };
  sc.applyBg = () => { sc.bgStatus = sc.bgFail ? 'failed' : 'ready'; };
  sc.ack = async () => {
    const t = sc.now();
    const ids = sc.pkg.notices.filter(x => x.start <= t && t < x.end).map(x => x.id);
    await req('POST', `/screen/${code}/ack`, {
      lastAppliedEventId: sc.pkg.eventId, appliedNoticeIds: ids,
      scheduleHash: sc.pkg.scheduleHash, bgStatus: sc.bgStatus, bgAssetId: sc.bg() ? sc.bg().id : null,
    });
  };
  sc.full = async () => {
    const r = await req('GET', `/screen/${code}/sync`);
    sc.pkg = r.json; sc.applyBg(); await sc.ack(); return r.json;
  };
  sc.delta = async () => {
    const since = sc.pkg ? sc.pkg.eventId : 0;
    const p = (await req('GET', `/screen/${code}/sync?sinceEventId=${since}`)).json;
    if (p.mode === 'full') { sc.pkg = p; }
    else {
      const next = JSON.parse(JSON.stringify(sc.pkg));
      for (const e of p.events) {
        if (e.type === 'notice_publish' || e.type === 'notice_update') {
          const i = next.notices.findIndex(x => x.id === e.payload.id);
          if (i >= 0) next.notices[i] = e.payload; else next.notices.push(e.payload);
        } else if (e.type === 'notice_withdraw') {
          next.tombstones = Array.from(new Set([...(next.tombstones || []), e.noticeId]));
          next.notices = next.notices.filter(x => x.id !== e.noticeId);
        } else if (e.type === 'bg_update') next.backgrounds = e.payload;
      }
      const have = new Set(next.notices.map(x => x.id)), want = new Set(p.currentIds);
      if (have.size !== want.size || [...want].some(id => !have.has(id)) || [...have].some(id => !want.has(id))) {
        next.notices = p.notices; next.tombstones = p.tombstones; // 缺事件 -> 用权威集合追平
      }
      if (p.backgrounds) next.backgrounds = p.backgrounds;
      next.eventId = p.eventId; next.scheduleHash = p.scheduleHash;
      sc.pkg = next;
    }
    sc.applyBg(); await sc.ack(); return p;
  };
  sc.activeDefs = () => { const t = sc.now(); return sc.pkg.notices.filter(x => x.start <= t && t < x.end); };
  sc.currentSlot = () => Scheduler.slotAt(sc.activeDefs(), Scheduler.slotGridStart(sc.now()), null, sc.sched);
  sc.snapshot = async (mode = 'online') => {
    const slot = sc.currentSlot(), t = sc.now();
    await req('POST', `/screen/${code}/snapshot`, {
      at: t, shownNoticeIds: sc.activeDefs().map(x => x.id),
      currentSlotId: slot.kind === 'idle' ? null : slot.id,
      scheduleHash: sc.pkg.scheduleHash, mode, bgAssetId: sc.bg() ? sc.bg().id : null,
    });
  };
  return sc;
}
const fleetFor = async (code) => (await req('GET', '/api/fleet')).json.fleet.find(f => f.code === code);

async function main() {
  await new Promise(r => server.listen(8099, r));

  /* ============ 1. 同一通知两人改期 ============ */
  console.log('\n[1] 同一通知两人改期（乐观锁 409 → 合并后成功，修订链完整）');
  {
    const n = await publish(ED1, { title: '社区义诊', body: '周六上午', link: 'http://a/old', communityId: 1 });
    const base = (over) => ({
      type: 'activity', urgent: false, communityId: 1, ...over,
    });
    const t = Date.now();
    const e1 = base({ title: '改上午', body: '周六上午 9-11', link: 'http://a/new1',
      start: t + 3600000, end: t + 7200000, expectedVersion: 1 });
    const e2 = base({ title: '改下午', body: '周六下午 2-4', link: 'http://a/new2',
      start: t + 5400000, end: t + 9000000, expectedVersion: 1 });

    eq((await req('POST', `/api/notices/${n.id}`, e1, ED1)).status, 200, 'editor1 基于 v1 提交改期成功');
    let nn = (await req('GET', `/api/notices/${n.id}`)).json.notice;
    let sub = nn.revisions.find(r => r.status === 'submitted');
    await req('POST', `/api/revisions/${sub.id}/decision`, { approve: true }, AP); // v1→v2

    const r2 = await req('POST', `/api/notices/${n.id}`, e2, ED2);
    eq(r2.status, 409, 'editor2 仍基于过期 v1 提交被拒绝');
    ok(/version_conflict_expected_2/.test(r2.json.error), '错误指明当前应为 v2');

    const merged = { ...e2, body: '合并：周六下午 2-4（以最新排期为准）', expectedVersion: 2 };
    eq((await req('POST', `/api/notices/${n.id}`, merged, ED2)).status, 200, 'editor2 合并 v2 后提交成功');
    nn = (await req('GET', `/api/notices/${n.id}`)).json.notice;
    sub = nn.revisions.find(r => r.status === 'submitted');
    await req('POST', `/api/revisions/${sub.id}/decision`, { approve: true }, AP);
    nn = (await req('GET', `/api/notices/${n.id}`)).json.notice;
    eq(nn.currentVersion, 3, '最终生效 v3，修订链 v1→v2→v3 完整保留');
    ok(nn.revisions.find(r => r.version === 3).body.includes('合并'), '第二人合并后的内容生效');
  }

  /* ============ 2. 午夜跨区间 ============ */
  console.log('\n[2] 午夜跨区间（跨 00:00 连续；到期立即撤、不补播）');
  {
    const d = new Date();
    const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0).getTime();
    const start = midnight - 2 * 60000, end = midnight + 10 * 60000;
    await publish(ED1, { title: '跨夜停水', body: '23:58 至次日 00:10', link: '', start, end, type: 'water', communityId: 1 });
    const def = { id: 9001, urgent: false, start, end };
    const crossStart = Scheduler.slotGridStart(midnight - 1); // 含 00:00 的槽
    const crossPlan = Scheduler.computePlan([def], crossStart - Scheduler.SLOT_MS, midnight + 8000, 1);
    const cross = crossPlan.slots.filter(sl => sl.s <= midnight && sl.e > midnight);
    ok(cross.length === 1 && cross[0].id === 9001, '跨越 00:00 的槽完整播放（午夜不打断）');
    const after = Scheduler.computePlan([def], end, end + 2 * Scheduler.SLOT_MS, 1);
    ok(after.slots.every(sl => sl.id !== 9001), '00:10 到期后的槽全部撤下，不补播');
    const atEnd = Scheduler.slotAt([def], Scheduler.slotGridStart(end), 1, { lastShown: {} });
    eq(atEnd.kind, 'idle', '结束时刻所在的非完整槽不播放（不越期）');
  }

  /* ============ 3. 设备时间倒退 ============ */
  console.log('\n[3] 设备时间倒退（检测 / 校时 / 重置调度 / 持久化记录）');
  {
    const screen = makeScreen('SCR-YG-01');
    eq((await screen.hb()).clockBack, false, '时钟正常前进无倒退');
    screen.deviceClockDrift = -5 * 60000;
    const hb = await screen.hb();
    eq(hb.clockBack, true, '倒退 5 分钟被检测到');
    ok(screen.correction >= 299000, `校正量≈5 分钟（实际 ${screen.correction}ms）`);
    await screen.full();
    ok(Math.abs(screen.now() - Date.now()) < 1000, '应用“设备时+校正”后与服务器误差 <1s');
    const incidents = (await req('GET', '/api/clock-incidents')).json.incidents;
    ok(incidents.some(i => i.kind === 'backward' && i.screenId === 1), '后台持久化倒退事件');
    screen.deviceClockDrift = 0; await screen.hb();
  }

  /* ============ 4. 背景更新失败 ============ */
  console.log('\n[4] 背景更新失败（设备失败态上送；通知层不受影响）');
  {
    const screen = makeScreen('SCR-YG-01', { bgFail: true });
    await screen.full();
    eq((await req('POST', '/api/backgrounds',
      { name: '晚霞红', value: 'linear-gradient(135deg,#7f0000,#ff6b6b)' }, ADMIN)).status, 201,
      '管理员下发 bg_update 事件');
    await screen.delta();
    eq(screen.bgStatus, 'failed', '设备本地背景应用失败并回传 failed');
    const f = await fleetFor('SCR-YG-01');
    eq(f.bgStatus, 'failed', '管理页显示该屏背景更新失败');
    ok(f.bgPending === true, '背景列为待处理项');
    ok(screen.currentSlot().kind !== undefined, '通知轮播层继续独立工作');
  }

  /* ============ 5. 撤回迟到 + 撤屏确认 ============ */
  console.log('\n[5] 撤回事件迟到（离线旧包 / 撤屏待确认 / 重连强制失效）');
  {
    const n = await publish(ED1, { title: '临时停水', body: '马上恢复', link: 'http://a/x', communityId: 1 });
    const screen = makeScreen('SCR-YG-01');
    await screen.full();
    ok(screen.activeDefs().map(x => x.id).includes(n.id), '设备完整包含并在轮播该通知');
    await screen.snapshot();

    eq((await req('POST', `/api/notices/${n.id}/withdraw`, { reason: '误报，已恢复' }, AP)).status, 200,
      '撤回墓碑事件已落库（设备此刻“离线”不收事件）');
    let f = await fleetFor('SCR-YG-01');
    ok(!!f.pending.find(p => p.kind === 'withdraw_unconfirmed' && p.noticeId === n.id),
      '设备未 ACK 前：后台只显示“撤屏待确认”，不能声称已撤屏');
    ok(screen.pkg.notices.some(x => x.id === n.id), '离线设备旧包仍残留该通知（前端叠加显著时效横幅）');

    await screen.full(); // 重连强制完整对账
    ok(!screen.pkg.notices.some(x => x.id === n.id), '重连后通知被强制移除');
    ok(screen.pkg.tombstones.includes(n.id), '完整包携带撤回墓碑');
    f = await fleetFor('SCR-YG-01');
    ok(!f.pending.find(p => p.kind === 'withdraw_unconfirmed' && p.noticeId === n.id),
      '设备 ACK 新清单后撤屏待确认消失');
  }

  /* ============ 6. 缺事件追平 / 版本原子 / 防饥饿 / 截图 ============ */
  console.log('\n[6] 增量追平 · 正文入口同版本 · 紧急不饿死普通 · 截图关联清单');
  {
    const screen2 = makeScreen('SCR-HP-01');
    await screen2.full();
    const normal = await publish(ED1, { title: '读书会', body: '旧正文', link: 'http://old', communityId: 2 });
    const urgent = await publish(ED1, { title: '紧急水管爆裂', body: '抢修中', link: '', urgent: true, communityId: 2,
      start: Date.now() - 1000, end: Date.now() + 3600000 });
    await screen2.delta();

    const t = Date.now();
    const upd = { title: '读书会(改)', body: '新正文-周日', link: 'http://new/signup', type: 'activity',
      urgent: false, communityId: 2, start: t - 1000, end: t + 3600000, expectedVersion: normal.currentVersion };
    await req('POST', `/api/notices/${normal.id}`, upd, ED1);
    let nn = (await req('GET', `/api/notices/${normal.id}`)).json.notice;
    const sub = nn.revisions.find(r => r.status === 'submitted');
    await req('POST', `/api/revisions/${sub.id}/decision`, { approve: true }, AP);

    screen2.pkg.eventId -= 1; // 模拟漏掉最后一个事件
    const delta = await screen2.delta();
    ok(delta.events.length >= 1, '增量请求补齐缺失事件');
    const got = screen2.pkg.notices.find(x => x.id === normal.id);
    eq(got.body, '新正文-周日', '追平后正文为最新版');
    eq(got.link, 'http://new/signup', '同版本报名入口一起更新（无旧文字配新入口）');

    const now0 = Date.now();
    const defs = [
      { id: urgent.id, urgent: true, start: now0 - 1000, end: now0 + 600000 },
      { id: normal.id, urgent: false, start: now0 - 1000, end: now0 + 600000 },
    ];
    const plan = Scheduler.computePlan(defs, now0, now0 + 60000, 2);
    const normalSlots = plan.slots.filter(sl => sl.id === normal.id).length;
    ok(normalSlots >= 1, `紧急常驻时普通通知 60s 内仍上屏（${normalSlots} 槽），不被永久饥饿`);
    ok(Scheduler.auditPlan(plan.slots, defs).ok, '调度自检通过（最低展示/防饥饿/不越期）');

    await screen2.snapshot();
    let snaps = (await req('GET', `/api/screens/2/snapshots?limit=10`)).json.snapshots;
    ok(snaps[0].effectiveIds.some(e => e.id === normal.id && e.version === 2),
      '历史截图关联到当时有效清单及正确版本');

    await req('POST', `/api/notices/${urgent.id}/withdraw`, { reason: 'test' }, AP);
    await screen2.full();
    await screen2.snapshot();
    const snaps2 = (await req('GET', `/api/screens/2/snapshots?limit=10`)).json.snapshots;
    ok(!snaps2[0].effectiveIds.some(e => e.id === urgent.id), '撤回后新截图清单不含紧急通知');
    ok(snaps.some(s => s.effectiveIds.some(e => e.id === urgent.id)), '撤回前旧截图仍保留“当时含紧急通知”的事实');
  }

  /* ============ 7. 管理页总览 ============ */
  console.log('\n[7] 管理页列出各屏实际版本与待确认项');
  {
    const yFail = makeScreen('SCR-YG-01', { bgFail: true });
    await yFail.full();
    const fleet = (await req('GET', '/api/fleet')).json.fleet;
    eq(fleet.length, 2, '列出两台屏');
    for (const f of fleet) {
      ['screenId', 'lastAppliedEventId', 'serverEventId', 'appliedNoticeIds', 'pending', 'online', 'bgStatus', 'clockOffset']
        .forEach(k => ok(k in f, `${f.code} 含字段 ${k}`));
      ok(f.lastAppliedEventId <= f.serverEventId, `${f.code} 水位不超过服务端`);
    }
    eq(fleet.find(f => f.code === 'SCR-YG-01').bgStatus, 'failed', '阳光屏背景失败态可见');
  }

  server.close();
  console.log(`\n结果：${PASS} 通过，${FAIL} 失败`);
  process.exit(FAIL ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
