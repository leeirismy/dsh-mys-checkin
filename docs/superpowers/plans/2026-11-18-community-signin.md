# Community Sign-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有插件中交付默认分区为大别野与原神的可选社区签到，隔离游戏状态与调度消费，仅离线验证。

**Architecture:** 原生 ESM 社区协议模块 + 增量配置/持久化 + Host 共用执行锁与组合调度 + 独立社区 UI 卡片。不引入 Python、运行时依赖或新服务器。保留游戏入口契约，把游戏日期从自动尝试消费中解耦。

**Tech Stack:** Node.js >=22、内建 fetch/crypto/node:test、浏览器现有 React ModuleLoader。

**Spec:** `../specs/2026-11-18-community-signin-design.md`（用户已在 2026-11-18 回复“开始”批准）。

## Global Constraints

- `community.enabled: false`、`gids: ['5', '2']`；只支持 1/2/3/4/5/6/8，禁止读帖/点赞/分享/解验证码。
- 社区 App `2.117.0`、DS2 salt `t0qEgfub6cvueAPgR5m9aQWWVciEer7v`，不能覆盖游戏 client 参数。
- 社区 POST `retries: 0`；签名与发送使用同一 JSON 字符串；结果不明不当轮重试、不报成功。
- 只读源码，不读真实 `~/.dsh/mys-checkin/state.json`；测试必须临时 DSH_HOME + fail-closed fake fetch，禁止真实请求。
- 不升级包、不动 profile 链接、不自动重启、不推送代码；保持 Node 22/24 CI。
- 每次请求前/等待后/回写前检查账号 generation，关闭社区后停止后续社区写操作；已发请求不可撤销。
- 国内社区去重日期固定 Asia/Shanghai，调度日期遵循 config.timezone。
- 文档修改、实现隔离、提交和集成都必须保留已有未提交文件，不丢弃用户改动。

## Review Focus

1. SToken_v2 Cookie 规范化和缺 mid 不误伤游戏认证（Task 2/3）。
2. POST 已送达但返回丢失，不重试也不靠任务 58 猜分区成功（Task 2/3）。
3. 手动社区、定时执行和游戏日期的交叉消费，busy 不吞机会（Task 4）。
4. 换号、退出、续期/昵称回调与关功能之间的竞态（Task 3/4）。
5. 时区日界线、迁移/重启后丢社区状态与旧账号 UI 泄漏（Task 1/4/5）。

## File Map

- Modify `lib/config.js`：社区配置默认值/白名单规范化；导出 `COMMUNITIES`。
- Modify `lib/store.js`：state v2、独立社区状态与自动尝试迁移。
- Create `lib/community.js`：最小凭据、社区头、DS2 签到、余额归一化；无调度/持久化。
- Create `lib/run-policy.js`：纯函数判断 scope 是否已完成与调度消费日期。
- Modify `lib/service.js`：独立社区 route、共享锁、账号 generation、组合自动执行。
- Modify `lib/scheduler.js` only if needed：保留纯 planNext；busy 重规划优先放 service。
- Modify `client.js`：独立社区开关/分区/执行/结果卡，不新引入 UI primitives。
- Create `test/community-state.test.mjs`、`test/community.test.mjs`、`test/community-service.test.mjs`、`test/run-policy.test.mjs`、`test/client-community.test.mjs`；extend `test/service.test.mjs` where regression needs it。
- Modify `.github/workflows/ci.yml`、`README.md`：新增测试命令及社区能力、开关/风控/单实例/未验证边界。
- Create `THIRD_PARTY_NOTICES.md` if reference code/constants are adapted：保留 MihoyoBBSTools MIT notice。

## Execution Setup

- [x] 加载 using-git-worktrees，确认隔离目录和分支；把本次已批准 spec/plan 带入隔离树，不修改当前安装链接。
- [x] 检查基线 git status，读取即将修改的文件；记录已有 `docs/` 未追踪状态。
- [x] 使用已验证运行时，shell 无 node PATH 时执行 `NODE=$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`；本会话已验证 v24.21.0。CI 用矩阵 node。
- [x] 审阅原有四组测试确认均使用临时目录/fake network 后，执行 `"$NODE" test/protocol.test.mjs && "$NODE" test/schedule.test.mjs && "$NODE" test/qr.test.mjs && "$NODE" test/service.test.mjs`，失败则先调查，不归因给新功能。

## Task 1: Community configuration and restart-safe state

**Files:** `lib/config.js`, `lib/store.js`, `test/community-state.test.mjs`。

**Interfaces:**
- `COMMUNITIES: Array<{id: string, label: string}>`，顺序 1,2,3,4,5,6,8。
- `normalizeConfig(raw).community = {enabled, gids, client: {appVersion, salt}}`。
- `runtime.scheduleLastAttemptDate: string|null`；原游戏字段不删除。
- `runtime.community = {accountId:null|string, lastRunAt:null|number, lastResult:null|CommunityRecord, lastError:null|SafeError, balance:null|BalanceSnapshot, balanceError:null|SafeError, signedDays:{[gid]: {day:string, at:number}}}`。
- `CommunityRecord = {at, finishedAt, reason, results, ok}`；结果 `{gid,label,day,at,outcome,retcode?,message}`。
- `BalanceSnapshot = {totalPoints:number|null, todayReceived:number|null, todayRemaining:number|null, at:number, day:string}`；只接收有限非负数字。

- [x] 写失败测试 `defaults-and-explicit-empty`：断言 `community.enabled===false`、gids 深等于 `['5','2']`；显式 [] 保持 []；输入 [5,'2','2',999] 输出 ['5','2']；不改变游戏 client 默认值。
- [x] 写失败测试 `v1-migration-and-v2-roundtrip`：临时状态 v1 保留 auth/游戏结果，旧 lastRunDate 迁到 scheduleLastAttemptDate；v2 写入社区结果、signedDays 和余额后 close/load 完全保留；v2 的 null 不从旧字段重新填回。
- [x] Run `"$NODE" test/community-state.test.mjs`，应因缺配置/字段 FAIL，确认不是测试环境失败。
- [x] 最小实现白名单规范化、v2 初始状态与显式字段迁移；不把畸形原始对象直接暴露到状态响应。
- [x] 同命令复测 PASS，再跑 protocol/schedule 原有测试；阶段提交 `feat: persist opt-in community configuration and state`。

## Task 2: Community protocol adapter

**Files:** `lib/community.js`, `test/community.test.mjs`, `THIRD_PARTY_NOTICES.md`。

**Interfaces:**
- `communityCapability(auth) -> {available:boolean, accountId:string|null, reason:null|'no-stoken'|'missing-mid'|'missing-account'}`，内部规范化，不返回秘密。
- `signCommunity({config, deviceId, auth, gid}) -> Promise<{outcome, retcode?, message}>`，消费 Task 1 配置。
- `getCommunityBalance({config, deviceId, auth, now=Date.now()}) -> Promise<{ok:boolean, snapshot?:BalanceSnapshot, error?:SafeError, outcome?:string}>`。
- SafeError 只含 `{code,message,at?}`；任何出站 Cookie 不得出现在返回结果/异常消息。

- [x] 写失败测试 `stoken-cookie-and-exact-ds-body`：用人工 auth 检查 V1/V2、V2 缺 mid；捕获真实发送的 body 深等于 `{"gids":"5"}`；用 DS 头的 t/r 和实际 body 计算 MD5 复核；只有 stuid/stoken/(mid) 最小签到 Cookie，原 auth 不被修改。
- [x] 写失败测试 `safe-outcomes-and-zero-retry`：code0 最小结构 success；1034 captcha、-100 expired、-5003 error、字符串 '0'/数组/非JSON/HTTP500 为 unknown；fetch 在写后抛错时调用次数严格等于 1。
- [x] 写失败测试 `balance-is-account-information`：规范化 total_points/already_received_points/can_get_points，任务58或剩余0不生成分区成功；畸形数值变 null；错误不包含伪造的 token、mid 或 URL。
- [x] Run `"$NODE" test/community.test.mjs` 观察 FAIL。
- [x] 实现端点专用头/精确 body DS2。查询用原普通凭据 Cookie，无 DS；签名前能力检查，POST 禁重试。成功结构遵循 spec §4；不构造不存在的签到字段，不用任务58幂等。
- [x] 加入参考 MIT notice；复测 community/protocol PASS；阶段提交 `feat: add conservative community sign-in protocol adapter`。

## Task 3: Isolated manual community execution and account lifecycle

**Files:** `lib/service.js`, `test/community-service.test.mjs`, 必要时 extend `test/service.test.mjs`。

**Interfaces:**
- 保留 `/api/mys/run` 与 `run(reason, onlyGame=null)` 的游戏手动语义。
- 新 `POST /api/mys/community/run`，owner-only，空 body，以保存配置分区运行；成功接收返回现有格式 status，disabled/empty/auth/busy 返回固定安全错误码。
- `runCommunity(reason='manual')` 和游戏 run 共用 `runPromise`，不嵌套获取锁。
- `executeCommunity(context) -> Promise<{fatal:null|'captcha', ok:boolean}>` 在锁内调用；context 含 `{generation,accountId,auth,config,reason}` 的开跑快照。
- `authGeneration` 只在退出/新登录（含同账号重登）递增；普通同会话 token 续期不递增；`isCurrentSession(context)` 同时检查 generation/账号。
- `statusPayload().community = {enabled, communities, capability, running, lastResult, lastError, balance, balanceError}`；community running 按当前 scope 区分，整体仍有共享 busy。

- [x] 建立此测试文件独立临时 DSH_HOME、fake owner route ctx 与严格 mock；未匹配 URL 记 unexpected 并在测试结尾 assert 无 unexpected，不能被业务 catch 静默吞掉。
- [x] 写失败测试 `manual-community-only`：关闭所有游戏后默认社区可运行；POST body 顺序 5→2；游戏 lastResult/lastError/lastRunDate 和 scheduleLastAttemptDate 不变；第二次同业务日不再次 POST 已成功分区；新增分区可单独执行。
- [x] 写失败测试 `partial-unknown-captcha-and-balance-failure`：5成功/2失败保留两项；超时 unknown 不重发；余额查询失败不阻断签到，查询返回1034则禁止写；签到1034停止余下分区；SToken失效不删除共享 auth。
- [x] 写失败测试 `session-generation`：用可控 Promise 卡住 sign/resolveRole/refresh/enrichProfile，退出或换号后释放；断言无后续旧账号请求、无旧结果/凭据写回新账号。运行中关闭社区则阻止下一个分区 POST。
- [x] 写失败测试 `disabled-missing-token-and-redaction`：Host 不依赖 UI 检查；缺 STtoken/mid 不影响游戏状态；序列化 status/logs 不含测试秘密或完整请求 URL。
- [x] Run `"$NODE" test/community-service.test.mjs` 观察 FAIL。
- [x] 实现 route、能力状态、串行协议编排和社区结果/余额的独立回写。所有异步认证回调（登录轮询、profile、手动 refresh/verify、游戏自动续期）补 generation 检查，退出/换号清 scope/日期缓存并重新规划。
- [x] 复测 community-service 与原 service PASS；阶段提交 `feat: isolate community runs and guard account generation`。

## Task 4: Shared schedule with scope-specific completion

**Files:** 新 `lib/run-policy.js`, `lib/service.js`, `test/run-policy.test.mjs`, `test/community-service.test.mjs`；仅在测试证明必要时改 `lib/scheduler.js`。

**Interfaces:**
- `communityDay(now) -> string` 使用 dayKey(now, 'Asia/Shanghai')。
- `completedScopes({config,runtime,accountId,now}) -> {games:boolean,community:boolean}`；仅已启用范围参与，社区须所有当前选中 gid 在当前社区业务日成功，且完成发生于当前调度日。
- `effectiveLastRunDate({config,runtime,accountId,now}) -> string|null`：优先当前账号 scheduleLastAttemptDate；否则所有已启用范围都明确完成才返回当前调度日；无启用范围不制造“成功”。
- scheduled run 的 scope=all；游戏手动=games；社区手动=community；内部游戏执行返回 fatal/ok，使验证码能阻止本轮跨 scope 后续写操作。

- [x] 写失败测试 `separate-calendar-boundaries`：同一时间 Shanghai 已次日而 America/Los_Angeles 仍前日；断言调度日期与 communityDay 分离；跨午夜不命中上一日 signedDays。
- [x] 写失败测试 `manual-scope-does-not-consume-other`：只社区成功不能抑制游戏计划，反之亦然；所有启用范围完成才抑制；只有社区启用时其完成足够；改变选中 gid 后需要补新增分区。
- [x] 写失败测试 `scheduled-lock-and-attempt-marker`：手动任务占锁时触发 schedule，不改变标记；释放后重规划可补跑；成功取得锁的自动尝试即使部分失败也只运行一次；匿名跳过记尝试避免定时忙循环。
- [x] 写失败测试 `both-scopes-and-global-captcha-stop`：零游戏/开社区仍自动运行；常规游戏失败不覆盖社区状态；验证码停止本轮所有余下写请求（可保留只读信息回查），未执行目标 skipped。
- [x] Run `"$NODE" test/run-policy.test.mjs && "$NODE" test/community-service.test.mjs` 观察新断言 FAIL。
- [x] 实现纯策略及 scheduler callback 接线；锁在入口统一管理，busy 只重规划，不记尝试。保留原游戏状态格式，将 scheduler getLastRunDate 改为 effectiveLastRunDate；每次发社区请求前重算业务日。旧自动尝试日期迁移行为由 Task1 固定。
- [x] 复测 run-policy/community-service/service/schedule PASS；阶段提交 `feat: coordinate game and community schedules without scope interference`。

## Task 5: Community panel and full offline delivery

**Files:** `client.js`, `test/client-community.test.mjs`, `.github/workflows/ci.yml`, `README.md`，更新 spec 状态与计划勾选项。

**Interfaces:** 仅消费 Task3 status.community、现有 config 更新 route、新 community/run；不能导入 Host 模块或把 Cookie/原始响应塞 UI。

- [x] 写失败的轻量 VM 测试：用 node:vm.runInNewContext 加载现有浏览器脚本，fake ModuleLoader/React，捕获 slot 注册与组件树；hooks/fetch 只用内存假数据。禁止安装前端测试依赖。
- [x] 断言 `community-panel-states`：开关默认关闭且保存 false/true；多选提交 gids 保留显式 []；disabled/无token/missing-mid/empty/busy 时按钮禁用；部分成功、验证码、unknown 和余额查询失败分别显示，不把旧余额当今日值；零游戏时社区卡仍可见。
- [x] 断言 `community-button-routing`：点击只调用 `/api/mys/community/run`，不调用游戏 `/run`；原游戏按钮不变；余额文本不写“本次赚取”或固定每日积分上限。
- [x] Run `"$NODE" test/client-community.test.mjs` 观察 FAIL；若 VM 无法模拟完整面板，只抽取闭包内纯渲染函数测试，不把复杂手写 React 运行时变成新项目。
- [x] 实现独立卡片、可访问 label/开关/忙态与状态说明；复用现有 fallback 原生控件/主题，不扩大 primitives 导入。README 写清开关、分区、SToken能力、验证码手动处理、单实例、线上未验证与重载边界。
- [x] CI 加入五个新测试文件；跑所有九组测试及 `"$NODE" --check client.js`、`git diff --check`，预期 0 failures/exit0。完成 verification-before-completion 后才宣称离线测试通过。
- [ ] 按 requesting-code-review 请求一次独立全分支审阅，重点参考 Review Focus；修复关键问题并复测；阶段提交 `feat: expose community sign-in controls and offline coverage`。
- [ ] 检查最终 diff 与工作树，不自动 push/merge/重启；用 finishing-a-development-branch 给出将隔离改动整合回本地链接源码的选择。经用户选定整合后再次离线回归；GUI/真实账号未验收必须明确说明。

## Self-review

- 覆盖 spec §1–3：Task1 配置、Task5 UI/文档；§4：Task2 协议、Task3 编排；§5：Task1 持久化、Task3 会话、Task4 调度；§6–7：各测试 + Task5 全量验证；§8：不扩展范围。
- 接口名在任务间一致；结果与余额只用 Task1 定义，协议不依赖 service/store，UI 不依赖协议模块。
- 风控/unknown 与测试真实程度已明确，无需捏造接口兼容性证据。发现实现需偏离上述用户行为时暂停说明，不自行扩展。
