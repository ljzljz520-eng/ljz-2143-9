'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

require('./lib/seed').ensure();
const db = require('./lib/db');
const domain = require('./lib/domain');
const devices = require('./lib/devices');
const { now, jsonOr400 } = require('./lib/util');

const PORT = process.env.PORT || 8080;
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };

const sseClients = new Set();
function broadcast(kind, data) {
  const msg = `event: change\ndata: ${JSON.stringify({ kind, data, at: now() })}\n\n`;
  // SSE 写入是异步的：先复制客户端集合，避免与同步事务/其它广播交错
  const clients = [...sseClients];
  for (const res of clients) { try { res.write(msg); } catch (_) { sseClients.delete(res); } }
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Server-Time': String(now()) });
  res.end(body);
}
function auth(req) {
  const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!tok) return null;
  return db.find('users', u => u.username === tok) || null;
}
function requireActor(req, roles) {
  const u = auth(req);
  if (!u) throw Object.assign(new Error('unauthorized'), { status: 401 });
  if (roles && !roles.includes(u.role)) throw Object.assign(new Error('forbidden'), { status: 403 });
  return u;
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    const status = err.status || 500;
    if (status >= 500) console.error('[ERR]', err.stack);
    send(res, status, { error: err.message || 'server_error' });
  });
});

async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  req.query = Object.fromEntries(u.searchParams);
  if (req.method === 'GET' && p === '/api/events') return sse(req, res);
  if (req.method !== 'GET') req._body = await readBody(req);

  // ---- API ----
  const m = req.method;
  if (p === '/api/me' && m === 'GET') { const a = auth(req); return send(res, 200, { user: a || null }); }
  if (p === '/api/users' && m === 'GET') return send(res, 200, { users: db.all('users').map(x => ({ id: x.id, username: x.username, name: x.name, role: x.role })) });
  if (p === '/api/meta' && m === 'GET') return send(res, 200, {
    communities: db.all('communities'),
    types: domain.TYPES,
    serverTime: now(),
    slotMs: require('./public/scheduler.js').SLOT_MS,
    antiStarveMs: require('./public/scheduler.js').ANTI_STARVE_MS,
    bgMs: require('./public/scheduler.js').BG_MS,
  });

  if (p === '/api/notices' && m === 'GET') {
    return send(res, 200, { notices: domain.listNotices({ communityId: req.query.communityId }) });
  }
  if (p === '/api/notices' && m === 'POST') {
    const actor = requireActor(req, ['editor', 'admin']);
    const created = domain.createNotice(actor, jsonOr400(req));
    broadcast('notice', { id: created.id });
    return send(res, 201, { notice: created });
  }
  let mm;
  if ((mm = p.match(/^\/api\/notices\/(\d+)$/))) {
    const id = Number(mm[1]);
    if (m === 'GET') { const n = domain.getNotice(id); return n ? send(res, 200, { notice: n }) : send(res, 404, { error: 'not_found' }); }
    if (m === 'POST') { // 提交修订（改期/改文），带 expectedVersion 乐观锁
      const actor = requireActor(req, ['editor', 'admin']);
      const body = jsonOr400(req);
      const rev = domain.submitRevision(actor, id, body, body.expectedVersion);
      broadcast('revision', { noticeId: id, revisionId: rev.id });
      return send(res, 200, { revision: rev });
    }
  }
  if ((mm = p.match(/^\/api\/notices\/(\d+)\/draft$/))) {
    const actor = requireActor(req, ['editor', 'admin']);
    const rev = domain.saveDraft(actor, Number(mm[1]), jsonOr400(req));
    return send(res, 200, { revision: rev });
  }
  if ((mm = p.match(/^\/api\/notices\/(\d+)\/withdraw$/)) && m === 'POST') {
    const actor = requireActor(req, ['approver', 'admin']);
    const body = jsonOr400(req);
    const n = domain.withdrawNotice(actor, Number(mm[1]), body.reason);
    broadcast('withdraw', { id: n.id });
    return send(res, 200, { notice: n });
  }
  if ((mm = p.match(/^\/api\/revisions\/(\d+)\/decision$/)) && m === 'POST') {
    const actor = requireActor(req, ['approver', 'admin']);
    const body = jsonOr400(req);
    const rev = domain.decideRevision(actor, Number(mm[1]), !!body.approve, body.note || '');
    broadcast(rev.status === 'approved' ? 'approval' : 'rejection', { revisionId: rev.id, noticeId: rev.noticeId });
    return send(res, 200, { revision: rev });
  }
  if (p === '/api/events-log' && m === 'GET') {
    const after = Number(req.query.after || 0);
    return send(res, 200, { events: domain.eventsAfter(after) });
  }

  // ---- 背景 ----
  if (p === '/api/backgrounds' && m === 'GET') return send(res, 200, { backgrounds: domain.activeBackgrounds() });
  if (p === '/api/backgrounds' && m === 'POST') {
    const actor = requireActor(req, ['admin']);
    const bg = domain.createBackground(actor, jsonOr400(req));
    broadcast('bg', {});
    return send(res, 201, { background: bg });
  }
  if ((mm = p.match(/^\/api\/backgrounds\/(\d+)$/)) && m === 'DELETE') {
    const actor = requireActor(req, ['admin']);
    domain.removeBackground(actor, Number(mm[1]));
    broadcast('bg', {});
    return send(res, 200, { ok: true });
  }

  // ---- 计划（服务端权威排期，供设备核对） ----
  if (p === '/api/schedule' && m === 'GET') {
    const S = require('./public/scheduler.js');
    const communityId = req.query.communityId == null ? null : Number(req.query.communityId);
    const from = Number(req.query.from || S.slotGridStart(now()));
    const to = Number(req.query.to || from + 12 * 60 * 60 * 1000);
    const defs = domain.currentActiveDefs(from)
      .filter(d => d.communityId == null || d.communityId === communityId);
    const plan = S.computePlan(defs, from, to, communityId);
    return send(res, 200, { from, to, slotMs: plan.slotMs, slots: plan.slots });
  }

  // ---- 设备 ----
  if (p === '/api/screens' && m === 'GET') return send(res, 200, { screens: db.all('screens') });
  if (p === '/api/fleet' && m === 'GET') return send(res, 200, { fleet: devices.fleetStatus() });
  if ((mm = p.match(/^\/screen\/([^/]+)\/sync$/)) && m === 'GET') {
    const sc = screenByCode(mm[1]);
    const since = Number(req.query.sinceEventId || 0);
    const serverTime = now();
    const pkg = since > 0
      ? domain.deltaPackage(sc.id, since, serverTime)
      : domain.fullPackage(sc.id, serverTime);
    return send(res, 200, pkg);
  }
  if ((mm = p.match(/^\/screen\/([^/]+)\/hb$|^\/api\/screens\/(\d+)\/heartbeat$/)) && m === 'POST') {
    const sc = mm[1] ? screenByCode(mm[1]) : db.get('screens', Number(mm[2]));
    const out = devices.heartbeat(sc.id, jsonOr400(req));
    broadcast('fleet', {});
    return send(res, 200, out);
  }
  if ((mm = p.match(/^\/screen\/([^/]+)\/ack$|^\/api\/screens\/(\d+)\/ack$/)) && m === 'POST') {
    const sc = mm[1] ? screenByCode(mm[1]) : db.get('screens', Number(mm[2]));
    const out = devices.acknowledge(sc.id, jsonOr400(req));
    broadcast('fleet', {});
    return send(res, 200, out);
  }
  if ((mm = p.match(/^\/screen\/([^/]+)\/snapshot$|^\/api\/screens\/(\d+)\/snapshot$/)) && m === 'POST') {
    const sc = mm[1] ? screenByCode(mm[1]) : db.get('screens', Number(mm[2]));
    const out = devices.reportSnapshot(sc.id, jsonOr400(req));
    broadcast('snapshot', {});
    return send(res, 200, out);
  }
  if ((mm = p.match(/^\/api\/screens\/(\d+)\/snapshots$/)) && m === 'GET') {
    return send(res, 200, { snapshots: devices.listSnapshots(Number(mm[1]), Number(req.query.limit || 50)) });
  }
  if (p === '/api/clock-incidents' && m === 'GET')
    return send(res, 200, { incidents: devices.listClockIncidents(req.query.screenId ? Number(req.query.screenId) : null) });

  // ---- 静态（放在最后，避免吞掉 /screen/<code>/* 数据接口） ----
  if (req.method === 'GET') {
    if (p === '/') return serveFile(res, 'admin.html');
    if (p === '/screen') return serveFile(res, 'screen.html');
    if (p === '/scheduler.js') return serveFile(res, 'scheduler.js');
    if (p === '/app.js') return serveFile(res, 'app.js');
    if (p === '/styles.css') return serveFile(res, 'styles.css');
  }
  send(res, 404, { error: 'not_found', path: p });
}

function screenByCode(code) {
  const sc = db.find('screens', x => x.code === code);
  if (!sc) throw Object.assign(new Error('screen_not_found'), { status: 404 });
  return sc;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 2e6) reject(Object.assign(new Error('body_too_large'), { status: 413 })); });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}
function serveFile(res, name) {
  const fp = path.join(PUB, path.basename(name));
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
}
function sse(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(`: connected ${now()}\n\n`);
  const ka = setInterval(() => res.write(': ka\n\n'), 15000);
  sseClients.add(res);
  req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
}

server.listen(PORT, () => console.log(`community notice platform on http://localhost:${PORT}`));
module.exports = server;
