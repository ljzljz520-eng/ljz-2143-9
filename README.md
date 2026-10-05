# 社区公告发布与大屏轮播平台

零外部依赖（仅 Node.js 内置模块）。包含：Web 编辑/审批后台、持久化后端、确定性轮播调度器、
大屏客户端（校时 / 完整+增量同步 / 离线 TTL / 撤回强制失效）、以及 54 项端到端验收。

## 运行

```bash
node server.js              # 默认 http://localhost:8080
PORT=8080 DATA_DIR=./data node server.js
npm test                    # 或 node test/run.js（真实 HTTP + 双屏设备模拟器，54 项）
```

- 管理后台：`http://localhost:8080/`（右上角可切换 editor / approver / admin 角色，演示用 Bearer 登录）
- 大屏：`http://localhost:8080/screen?screen=SCR-YG-01`（另一台 `SCR-HP-01`）
  - `&bgfail=1` 可模拟设备背景更新失败。

种子数据：2 个小区（阳光花园 / 和平里）、2 台大屏、4 个用户（editor1、editor2、approver1、admin）。

## 数据模型与持久化

`lib/db.js` 是崩溃原子写的嵌入式表存储：

- `data/db.wal` 仅追加写前日志，每次提交 `write` 后 `fsync`；`data/db.json` 为周期快照
  （temp → fsync → rename → fsync 目录）。已通过 SIGKILL 恢复验证。
- 表：`notices / revisions / events / bg_assets / screens / screen_state / event_acks /
  screen_snapshots / clock_incidents / users / communities`。

核心领域规则（`lib/domain.js`）：

- **通知修订版本化**：一次发布是一条不可变 `revision`，包含 `title/body/link/type/urgent/
  communityId/start/end`，整体进入审批。**报名链接与正文属于同一发布版本**，设备端在副本上
  折叠完一批事件后一次性替换展示状态，杜绝“旧文字配新入口”。
- **改期乐观锁**：提交带 `expectedVersion`；两人同时改期时，基于过期版本的第二人收到
  `409 version_conflict_expected_N`，必须合并最新版本后再提交。修订链 v1→v2→v3 完整保留。
- **撤回 = 墓碑**：`notice_withdraw` 事件生效后，任意时点（含 `defsAt` 历史重建）都不会再出现该通知。

## 轮播调度（`public/scheduler.js`，前后端同构）

- 时间轴按 **SLOT_MS=8s** 切槽，切换只发生在槽边界 → 每条通知至少完整展示一个槽（最低展示时间）。
- 槽只选取**覆盖整个槽区间**的通知（`start<=槽始 && end>=槽末`）。因此跨午夜区间天然连续；
  到期通知演完当前完整槽后立刻撤下、绝不补播，结束点落在槽中间时宁可提前撤也不越期。
- **紧急插播但防饥饿**：槽边界优先紧急通知；一旦任一普通有效通知等待
  **≥ ANTI_STARVE_MS=30s**，强制由等待最久的普通通知占槽。
  => 普通通知最长等待上界 `30s + 8s = 38s`，不可能被紧急流永久饥饿。
- 背景（BG_MS=20s 轮转）是独立底图层，通知为叠加层；背景失败不影响通知撤下。
- `auditPlan` 对任何排期做越期/饥饿/槽网格自检。

## 下发：完整排期 vs 增量事件

- 首次连接 / 重连 / 对账失败：`GET /screen/<code>/sync` 返回**完整包**（当前定义 + 全部事件 +
  墓碑 + 背景 + 清单指纹）。
- 常态：`GET /screen/<code>/sync?sinceEventId=N` 返回增量事件，并附带服务端当前权威 id 集合
  (`currentIds`) 与完整定义。设备折叠后若集合对不上（缺事件/跳号），直接用权威集合**追平**。
- 设备每应用一批事件回 `POST /screen/<code>/ack`（事件水位 + 当前轮播 id 集合 + 背景状态）。

## 离线、校时、撤回迟到

- 心跳 `POST /screen/<code>/hb` 回 `serverTime/correctionMs`；设备统一用
  `校正时间 = 本地时钟 + correction` 调度。检测到设备时钟倒退（>2s）记录
  `clock_incidents` 并下發 `clockBack`，客户端重置槽状态。
- 离线时显示本地缓存包，但**顶部红色断连横幅 + 底部时效说明**（事件水位、指纹、缓存时刻、
  “内容可能已过期”）。超过 **30 分钟 TTL** 强制撤下缓存公告内容。
- **撤回事件迟到**：设备旧离线包中仍可能残留该通知 —— 前端显著时效声明；重连一律强制完整对账，
  墓碑生效立即移除。
- **后台不能凭“已发送”声称已撤屏**：只有设备 ACK 的清单中不再含该通知，
  `GET /api/fleet` 中该项 `withdraw_unconfirmed` 待确认才消失。

## 管理页（“大屏与同步”）

逐屏列出：在线/离线与离线时刻、设备时钟偏移、**事件水位（设备/服务端/落后数）**、
当前 ACK 清单、清单指纹、背景状态（失败显式标红）、以及**待确认项**
（撤屏待确认 / 发布改期待确认）。每屏“详情”展示历史截图，且每条截图都关联
`defsAt(at)` 重建出的**当时有效清单（id@version）**，可审计撤回前/撤回后的真实上屏事实。

## 验收场景（`test/acceptance.js`，54 项全过）

1. 同一通知两人改期：过期提交 409，合并 v2 后成功，修订链完整。
2. 午夜跨区间：23:58–00:10 跨 00:00 连续播放，到期即撤、不补播、不越期。
3. 设备时间倒退 5 分钟：检测、持久化记录、校正后误差 <1s、调度状态重置。
4. 背景更新失败：设备 `bgStatus=failed` 上送并在后台可见，通知层不受影响。
5. 撤回事件迟到：离线旧包残留 + 待确认；重连完整对账后强制失效，ACK 后待确认消除。
6. 增量缺事件追平、正文/入口同版本原子替换、紧急不饿死普通、截图关联当时有效清单。
7. 管理页列出各屏实际版本、水位与待确认项。

## 主要接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST/GET | `/api/notices` | 新建（草稿）/ 列表 |
| POST | `/api/notices/:id` | 提交修订（带 `expectedVersion`） |
| POST | `/api/notices/:id/draft` | 保存草稿 |
| POST | `/api/revisions/:rid/decision` | 审批 `{approve,note}` |
| POST | `/api/notices/:id/withdraw` | 撤回（墓碑） |
| GET | `/api/schedule?from&to&communityId` | 服务端权威排期 |
| GET/POST | `/api/backgrounds` | 背景素材（admin） |
| GET | `/api/events-log?after=N` | 事件日志 |
| GET | `/api/fleet` | 各屏实际版本与待确认项 |
| GET | `/screen/:code/sync[?sinceEventId=N]` | 完整 / 增量下发 |
| POST | `/screen/:code/hb` `/ack` `/snapshot` | 校时 / 应用确认 / 截图 |
| GET | `/api/events` | SSE 变更推送（后台实时刷新） |
