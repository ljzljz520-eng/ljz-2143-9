'use strict';
/* 管理台 SPA（原生 JS） */
const $ = (s, r = document) => r.querySelector(s);
const api = async (path, opts = {}) => {
  const h = { 'Content-Type': 'application/json' };
  if (state.me) h.Authorization = 'Bearer ' + state.me.username;
  const res = await fetch(path, Object.assign({}, opts, { headers: h }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
};
const state = { me: null, meta: null, notices: [], tab: 'notices', communities: [] };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (ms) => ms == null ? '—' : new Date(ms).toLocaleString('zh-CN', { hour12: false });
const toLocalInput = (ms) => {
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocalInput = (v) => v ? new Date(v).getTime() : NaN;
const TYPE_NAME = { water: '停水', power: '停电', activity: '活动', notice: '通知' };
const STATUS_NAME = { draft: '草稿', published: '已发布', withdrawn: '已撤回' };
const REV_STATUS = { draft: '草稿', submitted: '待审批', approved: '已批准', rejected: '已驳回', superseded: '已作废' };

async function boot() {
  const { user } = await api('/api/me');
  const { users } = await api('/api/users');
  state.meta = (await api('/api/meta'));
  state.communities = state.meta.communities;
  const sel = $('#userSel');
  sel.innerHTML = users.map(u => `<option value="${u.username}">${esc(u.name)}（${u.role}）</option>`).join('');
  sel.value = user ? user.username : 'editor1';
  state.me = users.find(u => u.username === sel.value);
  sel.onchange = () => { state.me = users.find(u => u.username === sel.value); render(); };
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => {
    state.tab = b.dataset.tab;
    document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('active', x === b));
    render();
  });
  await render();
  const es = new EventSource('/api/events');
  es.addEventListener('change', () => render());
  setInterval(() => render(true), 5000);
}

let renderSeq = 0;
async function render(tickOnly) {
  const seq = ++renderSeq;
  const view = $('#view');
  try {
    if (state.tab === 'notices') await renderNotices(view);
    else if (state.tab === 'fleet') await renderFleet(view);
    else if (state.tab === 'plan') await renderPlan(view);
    else if (state.tab === 'bg') await renderBg(view);
    else if (state.tab === 'events') await renderEvents(view);
  } catch (e) {
    if (!tickOnly) view.innerHTML = `<div class="banner err">加载失败：${esc(e.message)}</div>`;
  }
  void seq;
}

/* ---------------- 通知与审批 ---------------- */
async function renderNotices(view) {
  const { notices } = await api('/api/notices');
  state.notices = notices;
  const canEdit = ['editor', 'admin'].includes(state.me.role);
  const canApprove = ['approver', 'admin'].includes(state.me.role);
  const pending = notices.flatMap(n => n.revisions.filter(r => r.status === 'submitted').map(r => [n, r]));
  view.innerHTML = `
    <div class="row" style="justify-content:space-between;margin-bottom:12px">
      <div>共 ${notices.length} 条 · <b>${pending.length}</b> 个待审批修订
        ${pending.length ? '<span class="tag warn">审批队列</span>' : ''}</div>
      ${canEdit ? '<button class="btn" id="newBtn">＋ 新建通知（Web 编辑器）</button>' : '<span class="mut">当前角色仅可查看</span>'}
    </div>
    <div class="grid" style="grid-template-columns:${pending.length ? '1.4fr 1fr' : '1fr'}">
      <div class="card"><h3>通知列表</h3><div id="noticeList"></div></div>
      ${pending.length ? `<div class="card"><h3>待审批</h3><div id="approvalList"></div></div>` : ''}
    </div>`;
  $('#newBtn', view).onclick = () => openEditor(null);
  $('#noticeList', view).innerHTML = notices.length ? notices.map(n => {
    const cur = n.revisions.find(r => r.version === n.currentVersion) || n.revisions[0];
    const stTag = n.status === 'withdrawn' ? '<span class="tag bad">已撤回</span>'
      : n.status === 'published' ? '<span class="tag ok">已发布 v' + n.currentVersion + '</span>'
      : '<span class="tag">草稿</span>';
    const urg = cur && cur.urgent ? '<span class="tag urg">紧急插播</span>' : '';
    const comm = cur && cur.communityId ? commName(cur.communityId) : '全部小区';
    return `<div class="notice-item" data-id="${n.id}">
      <div class="notice-main">
        <div class="title">${esc(cur ? cur.title : '（未命名）')} ${stTag} ${urg}</div>
        <div class="mut small">${esc(TYPE_NAME[cur ? cur.type : 'notice'] || '通知')} · ${esc(comm)} · ${esc(fmt(cur ? cur.start : null))} ~ ${esc(fmt(cur ? cur.end : null))}</div>
        ${n.status === 'withdrawn' ? `<div class="small" style="color:var(--bad)">撤回于 ${esc(fmt(n.withdrawnAt))}</div>` : ''}
      </div>
      <div class="row">
        ${canEdit && n.status !== 'withdrawn' ? `<button class="btn ghost act" data-a="edit">改期/编辑</button>` : ''}
        ${canApprove && n.status !== 'withdrawn' ? `<button class="btn danger act" data-a="withdraw">撤回</button>` : ''}
      </div>
    </div>`;
  }).join('') : '<div class="mut">暂无通知</div>';
  $('#noticeList', view).querySelectorAll('.notice-item').forEach(el => {
    const id = Number(el.dataset.id);
    const n = notices.find(x => x.id === id);
    el.querySelector('[data-a="edit"]')?.addEventListener('click', (e) => { e.stopPropagation(); openEditor(n); });
    el.querySelector('[data-a="withdraw"]')?.addEventListener('click', (e) => { e.stopPropagation(); openWithdraw(n); });
    el.addEventListener('click', () => openDetail(n));
  });
  if (pending.length) {
    $('#approvalList', view).innerHTML = pending.map(([n, r]) => `
      <div class="rev" data-rid="${r.id}">
        <div><b>${esc(r.title)}</b> <span class="tag ${r.urgent ? 'urg' : ''}">${r.urgent ? '紧急' : '普通'}</span>
          <span class="mut small">v${r.version} · ${esc(TYPE_NAME[r.type])} · ${esc(commName(r.communityId) || '全部小区')}</span></div>
        <div class="small mut">编辑人 #${r.editorId} 提交于 ${esc(fmt(r.submittedAt))} · 生效 ${esc(fmt(r.start))} ~ ${esc(fmt(r.end))}</div>
        <div class="pre body">${esc(r.body)}</div>
        ${r.link ? `<div class="small">报名入口：<a href="${esc(r.link)}" target="_blank">${esc(r.link)}</a></div>` : ''}
        <div class="row" style="margin-top:8px">
          <button class="btn ok act" data-a="ok">批准并发布</button>
          <button class="btn ghost act" data-a="no">驳回</button>
        </div>
      </div>`).join('');
    $('#approvalList', view).querySelectorAll('.rev').forEach(el => {
      const rid = Number(el.dataset.rid);
      el.querySelector('[data-a="ok"]').onclick = async () => {
        try { await api(`/api/revisions/${rid}/decision`, { method: 'POST', body: JSON.stringify({ approve: true }) }); toast('已批准发布'); }
        catch (e) { toast(e.message, true); }
      };
      el.querySelector('[data-a="no"]').onclick = async () => {
        const note = prompt('驳回原因（可选）') || '';
        try { await api(`/api/revisions/${rid}/decision`, { method: 'POST', body: JSON.stringify({ approve: false, note }) }); toast('已驳回'); }
        catch (e) { toast(e.message, true); }
      };
    });
  }
}
const commName = (id) => (state.communities.find(c => c.id === id) || {}).name;

function editorForm(n) {
  const cur = n && n.revisions.find(r => r.version === n.currentVersion);
  const draft = n && n.revisions.find(r => r.status === 'draft');
  const base = draft || cur || { title: '', body: '', link: '', type: 'notice', urgent: false, communityId: null, start: Date.now() + 3600000, end: Date.now() + 7200000 };
  const expVer = n ? n.currentVersion : 0;
  return `
    <div id="edErr"></div>
    <input type="hidden" id="f_exp" value="${expVer}"/>
    <div class="two">
      <div><label>标题</label><input id="f_title" style="width:100%" value="${esc(base.title)}"/></div>
      <div><label>类型</label><select id="f_type">
        ${['water', 'power', 'activity', 'notice'].map(t => `<option value="${t}" ${base.type === t ? 'selected' : ''}>${TYPE_NAME[t]}</option>`).join('')}
      </select></div>
    </div>
    <div class="three">
      <div><label>覆盖小区</label><select id="f_comm">
        <option value="">全部小区</option>
        ${state.communities.map(c => `<option value="${c.id}" ${base.communityId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select></div>
      <div><label>生效开始（本地）</label><input id="f_start" type="datetime-local" value="${toLocalInput(base.start)}" step="60"/></div>
      <div><label>生效结束（本地）</label><input id="f_end" type="datetime-local" value="${toLocalInput(base.end)}" step="60"/></div>
    </div>
    <label style="margin-top:8px"><input type="checkbox" id="f_urgent" ${base.urgent ? 'checked' : ''}/> 紧急通知（可在槽边界插播，仍受防饥饿约束）</label>
    <label>正文（与报名入口属于同一发布版本，整体生效）</label>
    <textarea id="f_body">${esc(base.body)}</textarea>
    <label>报名链接（随正文同一版本上屏，不会错配）</label>
    <input id="f_link" style="width:100%" value="${esc(base.link)}" placeholder="https://..."/>
    ${n ? `<div class="small mut" style="margin-top:6px">基于已发布版本 v${expVer} 提交；若期间他人已改期，提交将返回 409 需重新合并。</div>` : ''}
  `;
}
function readEditor() {
  return {
    title: $('#f_title').value.trim(), body: $('#f_body').value.trim(),
    link: $('#f_link').value.trim(), type: $('#f_type').value,
    urgent: $('#f_urgent').checked,
    communityId: $('#f_comm').value === '' ? null : Number($('#f_comm').value),
    start: fromLocalInput($('#f_start').value), end: fromLocalInput($('#f_end').value),
    expectedVersion: Number($('#f_exp').value),
  };
}
function openEditor(n) {
  const isEdit = !!n;
  modal(`
    <h2>${isEdit ? '改期 / 编辑：' + esc(n.revisions[0] ? (n.revisions.find(r => r.version === n.currentVersion) || n.revisions[0]).title : '') : '新建通知'}</h2>
    ${editorForm(n)}
    <div class="row" style="margin-top:14px;justify-content:flex-end">
      <button class="btn ghost" id="mCancel">取消</button>
      ${isEdit ? '' : '<button class="btn ghost" id="mDraft">仅保存草稿</button>'}
      <button class="btn" id="mSubmit">提交审批</button>
    </div>`);
  $('#mCancel').onclick = closeModal;
  const submit = async () => {
    const p = readEditor();
    try {
      if (isEdit) await api(`/api/notices/${n.id}`, { method: 'POST', body: JSON.stringify(p) });
      else {
        // 新建即草稿，再对同一草稿执行提交（不会产生两条通知）
        const r = await api('/api/notices', { method: 'POST', body: JSON.stringify(p) });
        await api(`/api/notices/${r.notice.id}`, { method: 'POST', body: JSON.stringify({ ...p, expectedVersion: 0 }) });
      }
      closeModal(); toast('已提交审批');
    } catch (e) {
      $('#edErr').innerHTML = `<div class="banner err">${esc(e.message)}${e.message.startsWith('version_conflict') ? '：他人已改期，请关闭后重新打开合并最新版本' : ''}</div>`;
    }
  };
  $('#mSubmit').onclick = submit;
  const dBtn = $('#mDraft');
  if (dBtn) dBtn.onclick = async () => {
    const p = readEditor();
    await api('/api/notices', { method: 'POST', body: JSON.stringify(p) }); // 创建后停留在草稿
    closeModal(); toast('草稿已保存');
  };
}
function openWithdraw(n) {
  modal(`<h2>撤回通知</h2>
    <p>撤回将生成 <b>notice_withdraw</b> 墓碑事件，大屏重连/下一次同步后强制失效。<br>
    <span class="mut">后台在设备 ACK 确认其清单已不含该通知前，只显示“撤屏待确认”，不能声称已撤屏。</span></p>
    <label>撤回原因</label><input id="w_reason" style="width:100%"/>
    <div class="row" style="justify-content:flex-end;margin-top:12px">
      <button class="btn ghost" id="mCancel">取消</button>
      <button class="btn danger" id="wOk">确认撤回</button>
    </div>`);
  $('#mCancel').onclick = closeModal;
  $('#wOk').onclick = async () => {
    try { await api(`/api/notices/${n.id}/withdraw`, { method: 'POST', body: JSON.stringify({ reason: $('#w_reason').value }) }); closeModal(); toast('撤回已下发，等待各屏确认'); }
    catch (e) { toast(e.message, true); }
  };
}
function openDetail(n) {
  modal(`<h2>${esc((n.revisions.find(r => r.version === n.currentVersion) || n.revisions[0] || {}).title || '')}
    <span class="tag ${n.status === 'withdrawn' ? 'bad' : n.status === 'published' ? 'ok' : ''}">${STATUS_NAME[n.status]}${n.status === 'published' ? ' v' + n.currentVersion : ''}</span></h2>
    <div class="small mut" style="margin-bottom:8px">通知 #${n.id} · 创建于 ${esc(fmt(n.createdAt))}</div>
    <h3 style="margin:6px 0">修订历史（正文与报名链接整体版本化）</h3>
    ${n.revisions.sort((a, b) => b.version - a.version).map(r => `
      <div class="rev">
        <div class="row"><b>v${r.version}</b> <span class="tag ${r.urgent ? 'urg' : ''}">${esc(REV_STATUS[r.status])}</span>
          <span class="mut small">${esc(TYPE_NAME[r.type])} · ${esc(commName(r.communityId) || '全部小区')}</span></div>
        <div class="small mut">${esc(fmt(r.start))} ~ ${esc(fmt(r.end))} · 编辑 #${r.editorId}${r.approverId ? ' · 审批 #' + r.approverId : ''}</div>
        <div class="pre body">${esc(r.body)}</div>
        <div class="small">报名：${r.link ? `<a href="${esc(r.link)}">${esc(r.link)}</a>` : '无'}</div>
        ${r.decideNote ? `<div class="small mut">审批意见：${esc(r.decideNote)}</div>` : ''}
      </div>`).join('')}
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn ghost" id="mCancel">关闭</button></div>`);
  $('#mCancel').onclick = closeModal;
}

/* ---------------- 大屏与同步 ---------------- */
async function renderFleet(view) {
  const [{ fleet }, { incidents }] = await Promise.all([
    api('/api/fleet'), api('/api/clock-incidents').catch(() => ({ incidents: [] })),
  ]);
  state._fleet = fleet;
  view.innerHTML = `<div class="card"><h3>各屏实际版本与待确认项</h3><div class="grid" id="fleetGrid"></div>
    <h3 style="margin-top:18px">时钟异常（倒退/校时记录）</h3>
    <table><thead><tr><th>屏</th><th>类型</th><th>设备时(前)</th><th>设备时(后)</th><th>服务器记录时间</th></tr></thead>
    <tbody>${incidents.length ? incidents.map(c => `<tr><td>#${c.screenId}</td><td><span class="tag warn">${c.kind}</span></td><td>${esc(fmt(c.from))}</td><td>${esc(fmt(c.to))}</td><td>${esc(fmt(c.at))}</td></tr>`).join('') : '<tr><td colspan="5" class="mut">无</td></tr>'}</tbody></table>
  </div>`;
  $('#fleetGrid').innerHTML = fleet.map(f => {
    const hashMatch = true; // 服务端权威 hash 已在心跳返回；这里展示设备上报值
    return `<div class="screen-card">
      <div class="screen-head"><span class="dot ${f.online ? 'on' : 'off'}"></span>
        <b>${esc(f.name)}</b><span class="tag">${esc(f.code)}</span>
        <span class="mut small">${esc(commName(f.communityId))}</span>
        <span style="flex:1"></span>
        <button class="btn ghost small" data-detail="${f.screenId}">详情/历史截图</button></div>
      <div style="padding:12px 14px">
        <div class="kv">
          <div>在线状态</div><div>${f.online ? '<span style="color:var(--ok)">在线</span>' : '<span style="color:var(--bad)">离线</span>'} ${f.offlineSince ? '· 离线于 ' + esc(fmt(f.offlineSince)) : ''} · 心跳 ${esc(fmt(f.lastHb))}</div>
          <div>时钟偏移</div><div>${f.clockOffset} ms ${Math.abs(f.clockOffset) > 5000 ? '<span class="tag warn">偏差较大</span>' : ''} <span class="mut">（设备时钟 - 服务器时钟）</span></div>
          <div>事件水位</div><div>设备 ${f.lastAppliedEventId} / 服务端 ${f.serverEventId} ${f.behindEvents ? `<span class="tag warn">落后 ${f.behindEvents} 个事件</span>` : '<span class="tag ok">已追平</span>'}</div>
          <div>当前清单(ACK)</div><div>${f.appliedNoticeIds.length ? f.appliedNoticeIds.map(i => '#' + i).join(', ') : '（空）'}</div>
          <div>清单指纹</div><div><code>${esc(f.scheduleHash || '—')}</code></div>
          <div>背景下发</div><div>${f.bgStatus === 'ready' ? '<span class="tag ok">就绪 #' + f.bgAssetId + '</span>' : '<span class="tag bad">背景更新失败：' + esc(f.bgStatus) + '</span>'}</div>
        </div>
        <div style="margin-top:10px"><b>待确认项：</b>
        ${f.pending.length ? `<table><thead><tr><th>类型</th><th>通知</th><th>版本/事件</th></tr></thead><tbody>
          ${f.pending.map(p => `<tr><td>${p.kind === 'withdraw_unconfirmed'
              ? '<span class="tag bad">撤屏待确认</span>' : '<span class="tag warn">发布/改期待确认</span>'}</td>
            <td>#${p.noticeId} ${esc(p.title)}</td><td>${p.version ? 'v' + p.version + ' / ' : ''}事件 #${p.eventId}</td></tr>`).join('')}
        </tbody></table>` : '<span class="tag ok">无 · 显示集合与服务端一致</span>'}
        </div>
      </div>
    </div>`;
  }).join('');
  void hashMatch;
  $('#fleetGrid').querySelectorAll('[data-detail]').forEach(b => b.onclick = () => openScreen(Number(b.dataset.detail)));
}
async function openScreen(screenId) {
  const [{ snapshots }] = await api(`/api/screens/${screenId}/snapshots?limit=30`);
  const f = state._fleet || null;
  modal(`<h2>大屏 #${screenId} 历史截图与当时有效清单</h2>
    <div class="small mut" style="margin-bottom:8px">每帧截图均关联“当时事件流重建出的有效清单(id@version)”，可核对撤回是否真的撤屏、正文与入口是否同版。</div>
    <div id="snaps">${snapshots.length ? snapshots.map(s => `
      <div class="rev">
        <div class="row"><b>${esc(fmt(s.at))}</b> <span class="tag">${s.mode}</span>
          <span class="small mut">槽内通知 #${s.currentSlotId ?? '—'}</span> <code class="small">${esc(s.scheduleHash || '')}</code></div>
        <div class="small">上屏集合：${s.shownIds.length ? s.shownIds.map(x => '#' + x).join(', ') : '空/idle'}</div>
        <div class="small">当时有效清单：${s.effectiveIds.map(x => '#' + x.id + '@v' + x.version).join(', ') || '空'}</div>
      </div>`).join('') : '<div class="mut">该屏尚未上报截图（运行大屏页面或验收测试后出现）</div>'}</div>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn ghost" id="mCancel">关闭</button></div>`);
  $('#mCancel').onclick = closeModal;
  void f;
}

/* ---------------- 排期 ---------------- */
async function renderPlan(view) {
  const allNotices = (await api('/api/notices')).notices;
  state._nm = {};
  for (const n of allNotices) { const r = n.revisions.find(x => x.version === n.currentVersion); if (r) state._nm[n.id] = r; }
  const from = Scheduler.slotGridStart(Date.now());
  const to = from + 60 * 60 * 1000;
  const { slots } = await api(`/api/schedule?from=${from}&to=${to}`);
  const audit = Scheduler.auditPlan(slots, (await api('/api/notices')).notices
    .filter(n => n.status === 'published')
    .map(n => { const r = n.revisions.find(x => x.version === n.currentVersion); return { id: n.id, urgent: r.urgent, start: r.start, end: r.end }; })
    .filter(d => d.end > from && d.start < to));
  view.innerHTML = `<div class="card"><h3>未来 60 分钟权威轮播排期（槽 ${state.meta.slotMs}ms · 防饥饿 ${state.meta.antiStarveMs}ms · 最低展示=1槽）</h3>
    <div class="banner ${audit.ok ? 'info' : 'err'}">自检：${audit.ok ? '通过：无饥饿、无越区间播放、每条至少完整一槽' : esc(audit.issues.join('；'))}</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;max-height:340px;overflow:auto">
    ${slots.map(sl => {
      const n = sl.kind === 'idle' ? null : state._nm && state._nm[sl.id];
      return `<div title="${esc(fmt(sl.s))}~${esc(fmt(sl.e))}" style="min-width:120px;padding:8px;border-radius:8px;border:1px solid var(--line);background:${sl.kind === 'urgent' ? 'rgba(251,113,133,.16)' : sl.kind === 'idle' ? '#101826' : '#16233a'}">
        <div class="small">${new Date(sl.s).toLocaleTimeString('zh-CN', { hour12: false })}</div>
        <div class="small">${sl.kind === 'idle' ? '<span class="mut">idle（仅背景）</span>' : (sl.kind === 'urgent' ? '🔴 紧急 #' : '普通 #') + sl.id}</div>
      </div>`;
    }).join('')}</div></div>`;
}

/* ---------------- 背景 ---------------- */
async function renderBg(view) {
  const { backgrounds } = await api('/api/backgrounds');
  const isAdmin = state.me.role === 'admin';
  view.innerHTML = `<div class="card"><h3>背景轮播素材（底图每 ${state.meta.bgMs / 1000}s 轮转；通知为叠加层）</h3>
    ${isAdmin ? `<div class="row" style="margin-bottom:10px">
      <input id="bg_name" placeholder="名称" style="width:160px"/>
      <input id="bg_val" placeholder="CSS 渐变，如 linear-gradient(135deg,#1e3a8a,#0ea5e9)" style="flex:1;min-width:280px"/>
      <button class="btn" id="bgAdd">新增并下发 bg_update</button></div>` : '<div class="mut small" style="margin-bottom:10px">仅管理员可更新背景</div>'}
    <div class="swatches">${backgrounds.map(b => `<div class="swatch" style="background:${esc(b.value)}"><span>#${b.id} ${esc(b.name)}</span>
      ${isAdmin ? `<button class="btn danger small" data-del="${b.id}" style="position:absolute;top:3px;right:3px;padding:1px 6px">×</button>` : ''}</div>`).join('')}</div>
    <div class="small mut" style="margin-top:10px">设备若无法应用新背景，会保持旧背景并回传 bgStatus=failed，后台显示“背景更新失败”，不影响通知层撤下。</div>
  </div>`;
  if (isAdmin) $('#bgAdd').onclick = async () => {
    try { await api('/api/backgrounds', { method: 'POST', body: JSON.stringify({ name: $('#bg_name').value, value: $('#bg_val').value }) }); toast('背景更新事件已下发'); }
    catch (e) { toast(e.message, true); }
  };
  view.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    await api(`/api/backgrounds/${b.dataset.del}`, { method: 'DELETE' }); render();
  });
}

/* ---------------- 事件与审计 ---------------- */
async function renderEvents(view) {
  const [{ events }] = await api('/api/events-log');
  view.innerHTML = `<div class="card"><h3>事件日志（持久化，设备增量同步的唯一事实源）</h3>
    <table><thead><tr><th>#</th><th>类型</th><th>通知/版本</th><th>载荷摘要</th><th>时间</th><th>操作人</th></tr></thead>
    <tbody>${events.slice().reverse().map(e => `<tr>
      <td>${e.id}</td><td><span class="tag ${e.type.includes('withdraw') ? 'bad' : e.type.includes('bg') ? 'warn' : 'ok'}">${esc(e.type)}</span></td>
      <td>${e.noticeId ? '#' + e.noticeId + (e.version ? ' v' + e.version : '') : '—'}</td>
      <td class="small"><code>${esc(JSON.stringify(e.payload).slice(0, 110))}</code></td>
      <td class="small">${esc(fmt(e.createdAt))}</td><td>#${e.actorId || '—'}</td></tr>`).join('')}
    </tbody></table></div>`;
}

/* ---------------- 通用 UI ---------------- */
function modal(html) {
  $('#modalHost').innerHTML = `<div class="modal-bg"><div class="modal">${html}</div></div>`;
  $('.modal-bg').addEventListener('click', (e) => { if (e.target.classList.contains('modal-bg')) closeModal(); });
}
function closeModal() { $('#modalHost').innerHTML = ''; }
let toastTimer;
function toast(msg, bad) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast';
    el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:10px 18px;border-radius:10px;z-index:99;border:1px solid';
    document.body.appendChild(el); }
  el.textContent = msg;
  el.style.background = bad ? 'rgba(248,113,113,.95)' : 'rgba(52,211,153,.95)';
  el.style.color = bad ? '#2a0606' : '#05231a';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.remove(), 3200);
}
boot().catch(e => $('#view').innerHTML = '<div class="banner err">启动失败：' + esc(e.message) + '</div>');
