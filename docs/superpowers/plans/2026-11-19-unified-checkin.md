# 游戏与大别野统一签到 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一张「签到项目」卡和一个「立即签到」按钮管理游戏及唯一社区大别野。

**Architecture:** 配置仅存大别野启用位，`5` 由宿主固定；手动入口用新的路由和已保存项目比对，避免旧 UI 在重载窗口里悄悄扩大操作范围。定时和手动共用串行执行器/锁，继续分别记录游戏与社区结果。

**Tech Stack:** DSH Desktop；ESM Node >=22、React ModuleLoader、Node `--test`，零运行时依赖。

**Spec:** [已确认短设计](../specs/2026-11-19-unified-checkin-design.md)。

## Global Constraints

- 仅在 `$HOME/.dsh/profiles/.worktrees/dsh-mys-unified` 的 `feat/unified-checkin` 工作，基线 `ec07003`。不得更改已安装目录、profile、链接、旧 Git 引用或读取生产状态文件；不安装/重载，不发真实短信、验证或签到。
- 社区只写大别野 `gid="5"`。不新增账号操作、读帖/点赞/发帖、自动验证码或新的后台任务。SMS 路由、短信协议、凭据形状不改；关闭/未选择任何旧社区时绝不自动打开大别野。
- 总定时开关、窗口和时区沿用；纯手动不写 `scheduleLastAttemptDate`；现有账号代际隔离、今日去重及风险停写保留。运行时测试使用假接口与临时 DSH_HOME。
- `NODE=$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`；每个功能任务先运行失败测试，再通过；整体离线验证与独立工程/UI 审查后保留隔离分支。浏览器/视觉测试不可用时只报告真实证据。

## Review Focus

- 旧版启用但只选原神社区、不选任何社区或分区列表损坏：必须迁移为大别野关闭；保存新版配置再次启动仍不继承旧 Host 选择器（任务 1）。
- 旧记录混有大别野成功与已移除分区失败：恢复后只展示大别野，不重发当日大别野成功、不借其他社区成功冒充（任务 1）。
- 旧客户端仍提交原来两个手动请求，或者新版提交已过时/被篡改的目标：绝不产生写请求（任务 1）。
- 合并签到游戏触发验证码（包括派生刷新端点）或在两阶段间退出/换号：大别野不发写请求；普通游戏失败不吞掉大别野（任务 1）。
- 两次编辑的异步保存乱序、保存失败、其他页面改过范围：手动按钮不能跑过时项目或自动重发，只对确认为已保存且一致的选择发起（任务 1/2）。

---

### Task 1: Host 固定分区、迁移和统一执行

**Files:** 修改 `lib/config.js`, `lib/store.js`, `lib/community.js`, `lib/run-policy.js`, `lib/service.js`; 更新 `test/community-state.test.mjs`, `test/community.test.mjs`, `test/community-service.test.mjs`, `test/run-policy.test.mjs`, `test/service.test.mjs`, `test/sms-service.test.mjs`（仅调用契约或配置夹具）。

**Interfaces:** `DABIEYE = {id:'5',label:'大别野'}`；配置输出 `community:{enabled:boolean,client:{appVersion,salt}}`；`checkinTargets(config) -> {gameIds:string[],dabieye:boolean}`，游戏 ID 按 `GAMES` 顺序。`signCommunity({config,deviceId,auth})` 不接受分区选择，序列化 `{gids:'5'}`。`POST /api/mys/run/checkin` 接收 `{gameIds:string[],dabieye:boolean}`；严格比对请求快照与已保存配置，返回既有 started/error 结构；旧 `/api/mys/run` 与 `/api/mys/community/run` 不注册。`status.community` 保留 enabled/capability/running/outcomes/balance，不保留 `communities` 选择器。`run(reason)` 无 `onlyGame`；共享 `startCheckin(context,{games,community})` 负责注册同一运行锁并依次执行两范围。

- [ ] **RED 迁移与协议：** `旧社区名单仅保留已有大别野授权` 断言 `{enabled:true,gids:['2']}`、`[]`、`null` → `enabled:false`；`['2',5,'5']` → `true` 且无 `gids`；`{enabled:false,gids:['5']}` 保持 false；新版 `{enabled:true}` 在旧 Host `gids:['2']` 下仍为 true。`旧社区记录只恢复大别野` 覆盖混合失败/成功与只有旧分区两种，年度日期使用合成数据；`签名仅使用固定字符串 5` 捕获 write body 精确等于 `{"gids":"5"}`，传入旧 `gid:'2'` 也不能发其他分区。
- [ ] **RED 运行契约：** 测试旧路由不存在、`{}`／额外字段／未知或重复游戏 ID → `bad-request`，合法但不同的目标 → `targets-changed`，无项目 → `no-targets`，以上无 upstream；`scheduled` and `manual` 共用互斥。游戏-only、大别野-only、合并、登录缺失、定时总开关关闭仍可手动、同日已签到不重写均用假接口验证调用序列，断言纯手动不写 `scheduleLastAttemptDate`。加合并手动的普通游戏失败继续大别野、刷新 CAPTCHA 不触发大别野、两阶段间 logout／换号无旧写回、结果不明单次写；保留原定时策略与 SMS 原账号回归断言。
- [ ] **执行 RED：** `$NODE --test test/community-state.test.mjs test/community.test.mjs test/community-service.test.mjs test/run-policy.test.mjs test/service.test.mjs test/sms-service.test.mjs`，核实新行为断言先失败。旧多分区用例改成单分区等价风险用例，不仅删除。
- [ ] **实现配置与写入限制：** `normalizeConfig` 对存在 `community.gids` 的原始输入只承认精确的 `5`/`'5'`，异常值关闭而非默认启用；输出移除该字段。`StateStore` 合并 Host/保存配置时，用户有新版 `enabled` 且不选 gid 时不继承 Host 的旧 `gids`；`routeConfig` 拒绝 API 更新分区名单。存档只投影可证明属于 `5` 的记录，混合结果重新计算大别野是否成功；没有大别野结果时清理旧 lastResult/lastRunAt/lastError，仍保留独立账户余额及有效大别野当日去重。收窄 `signCommunity` 的 HTTP body 为固定 `5`。
- [ ] **实现统一运行：** 新路由仅允许明确的快照，两范围至少一种且已登录才开始；比对在同一同步段完成，执行器持有账户/config 快照；不在旧 URL 隐式拓宽写范围。`run('manual')` 处理所有已保存项，`runScheduled()` 保留已有机会账本和按范围跳过已完成；`executeRun` 移除单游戏入参，`executeCommunity` 只执行一个项目，保留余额预／后查、在运行中关闭社区时阻止其尚未发出的写入、CAPTCHA 停写和不重试结果不明。缺社区凭据只记录该项失败，不妨碍可执行的游戏；跨阶段执行前检查代际，保护运行锁与清理。
- [ ] **GREEN 和提交：** 运行上述针对性命令。若全量仍只有待迁移的旧 UI 契约用例失败，明确记录，不算全量绿。提交 `feat: unify check-in execution and restrict community to Dabieye`。

### Task 2: 一张卡、一个按钮、可靠保存与离线验收

**Files:** 修改 `client.js`, `test/client-community.test.mjs`, `README.md`, `package.json` 描述（若仍称分别操作）；必要时添加一份简短验收记录。

**Interfaces:** 宿主来自任务 1。客户端用已确认配置的 `{gameIds,dabieye}` 调用 `run/checkin`；`createConfigSaveQueue({save,changed})` 可注入，`submit(next)` 串行最新提交，`view()` 提供 `{pending,failed,confirmed}`；现有 650ms 防抖在队列外保留，同一编辑过程中按钮从本地草稿变化起即不可执行，失败时不能沿用旧目标。

- [ ] **RED UI 与竞态：** 在现有 VM 回调／元素描述单元测试里断言只有一个签到动作，游戏和大别野同在「签到项目」，不显示旧分区，不发 `community/run` 或旧 `run`；一键 POST 的路径与 JSON 精确匹配、无勾选和未保存不提交、被 Host 拒绝不自动重试。用可控 Promise 单测 A/B 快速保存，确认 A 完成而 B 尚未保存按钮仍禁用，B 失败仍禁用，新的确认后提交只带确认范围；旧账号缺社区能力时面板仍可从原短信 CTA 修复，游戏不被社区凭据阻挡。运行 `$NODE --test test/client-community.test.mjs test/client-sms.test.mjs` 见预计失败。
- [ ] **实现界面与状态：** 把大别野开关置于游戏行同级、结果和米游币快照作为独立结果区；删除分区列表、专用操作、重复的签到重试入口及无用 locale/状态；主按钮 `立即签到` 按 loading/saving/failed/running/no-targets 禁用并给可读提示。串行发送配置快照并按本地编辑版本确认，旧保存回复、轮询和失败不得覆盖更新中的草稿；确认后更新自 Host 返回的规范配置。若 Host 返回 `targets-changed`，提示查看最新设置，刷新但不自动重发。保留原 SMS 登录流程与面板主题 token。
- [ ] **GREEN 与最终复核：** 跑上述 UI 命令及 `$NODE --test test/*.test.mjs`，记录完整数量；`$NODE --check` 检查改动生产 JS，解析 manifest，`git diff --check`，静态核对除迁移/旧路由负测试以外无分区选择与旧手动路由残留；重查原安装链接和 `feat/sms-login` 仍为 `ec07003`。
- [ ] **更新说明与独立审查：** 使用说明更新配置/路由/历史迁移与余额边界；请求工程与 UI/UX 独立复核，回归修复高优先级发现；报告没有真实界面、官方验证码或网络签到测试。提交 `feat: present one check-in setup and action`，保留隔离工作树，停止在上线之前。
