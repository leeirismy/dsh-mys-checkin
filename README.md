# 米游社签到（DSH 插件）

[![CI](https://github.com/Veersion/dsh-mys-checkin/actions/workflows/ci.yml/badge.svg)](https://github.com/Veersion/dsh-mys-checkin/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

在 DSH 左侧栏提供「米游社签到」面板：**中国大陆 +86 短信登录**、游戏与大别野（米游币）统一签到、随机时间窗口与失败提示。单账号，Node >=22，ESM，零运行时依赖。

> Mainland +86 SMS login, manually operated official CAPTCHA, and unified check-in for selected games and optional Dabieye. This branch has offline tests only, not live account or GUI acceptance.

**本分支未安装、未重载，也未请求真实短信或账号接口。** 官方 GT3/GT4 在不透明 sandbox 中的实际兼容性、当前 DSH Desktop/Web 载体及浅深色视觉效果仍需授权后验收。测试通过不代表线上协议一定可用，不承诺永久登录或规避风控。

## 安装与集成边界

普通安装需要在目标 profile 中同时配置：
1. `node_modules/@local/dsh-mys-checkin` 链接到插件目录；
2. profile 的 `package.json` 的 `dependencies` 添加 `"@local/dsh-mys-checkin": "link:<绝对路径>"`；
3. `dsh.profile.bundles` 包含 `"@local/dsh-mys-checkin"`。

**当前隔离分支不是已安装目录。不要将验证工作区直接当作已上线版本。** 集成 installed main、修改 profile、安装与重载均须另行确认。源码修改不保证热更新；不要启动替代 Web 服务冒充现有 GUI。卸载时先禁用 bundle 并移除依赖/链接；清理保存凭据是单独且不可逆的操作，请自行备份后确认。

本次从 `e988b41` 重建 `feat/sms-login`，不包含此前整段 9 条 SDK/诊断提交。旧引用保留：
- `backup/pre-sms-installed-20261118` → `564c1413183b2baa03f254cf6fce9b4118998683`
- `backup/pre-sms-sdk-diagnostics-20261118` → `ad38225193cea723b992331cf7114d05cc608402`
- `backup/pre-sms-stash-20261118` → `fe5e97439d98490356a3200514d2773989acf579`

尚未移动 installed main，也未应用/删除旧 stash 备份。将来若选择回退，应恢复已安装代码与加载版本；Git 备份**不包含账号状态**，不能恢复后来删除的凭据。回退前请先暂停自动签到并确认已保存；旧版可能恢复原来的社区分区默认值（不一定是大别野）。回退后核对旧版所有签到项目，再决定是否重新启用自动签到。不要假设未暂停时可安全回退；未实际安装、回退或做线上验证。

## 使用：短信登录

1. 在左侧打开「米游社签到」，点击「短信登录」。打开对话框本身不请求短信。
2. 输入 11 位大陆手机号，明确点击「发送验证码」。仅支持 +86，不支持海外号或多账号管理。
3. 如出现官方人工验证，在对话框里亲自完成 GT4/GT3。插件不自动解题、不绕过验证。加载失败/过期后请取消并重新开始，不会自动重发。
4. 输入 6 位短信验证码并点击「验证并登录」，也可按 Enter。错误码可显式重试；重新发送至少间隔 60 秒，每轮最多提交 5 次验证码。
5. 新凭据先换取 SToken 派生凭据并做只读校验：角色列表允许合法空列表；**社区启用时，社区只读校验也必须通过**。社区关闭时，该校验失败只显示警告。昵称查询失败不决定登录成败。通过后才整体替换旧登录，失败/取消不覆盖旧账号。
6. 本轮最长 5 分钟，人工验证不超过 2 分钟；取消/Escape/关闭会清理本轮输入并撤销会话。已发出的请求不一定能撤回，结果不明时先等待短信，不会自动重试发送。

账号卡「删除登录」需二次确认，会删除保存凭据并清理账号缓存。SToken 可能失效；自动派生 ltoken/cookie_token 不会续期 SToken 本身。缺失或失效时需要重新短信登录。已有合法保存凭据不强制重新登录。

### 隐私边界

- 手机号、验证码与人工验证 proof 仅用于本轮内存状态，不写入日志、持久化状态、浏览器存储或 URL。关闭、完成或到期会清理持有引用；**不保证 JavaScript 堆内存的物理擦除**。
- 手机号与 +86 字段用协议要求的 RSA PKCS#1 v1.5 加密后发给米哈游；验证码通过 HTTPS 发送。运行 DSH 的本机与同权限进程仍在信任边界内。
- 登录 Cookie/SToken 仅宿主持有，不返回浏览器；官方验证码渲染配置中的临时会话数据只向本轮 owner/隔离 frame 提供，不是状态查询字段。第三方官方 widget 会访问其官方 geetest/geevisit 资源，不能保证第三方服务本身零追踪。
- 既有状态文件 `~/.dsh/mys-checkin/state.json` **仍以明文保存长期凭据**，并非系统钥匙串。本次未升级存储加密；系统管理员、同权限进程和备份可能读取。请保护本机与备份，必要时使用加密卷。

## 游戏、社区与调度

支持原神、星穹铁道、绝区零、崩坏3、未定事件簿、崩坏学园2国服。只为勾选且有角色的游戏签到。

- 默认时间窗口 `18:00–18:30`，最多 4 个，在窗口内随机安排；开始不早于结束时，结束自动改为开始 +1 分钟。默认错过窗口后延迟 3–10 分钟补跑，可关闭。
- 在「签到项目」勾选游戏，或开启「大别野（米游币）」。大别野默认关闭，是唯一支持的社区（固定 gid `5`）。仅签到，不看帖、点赞、分享或发帖。
- 设置保存后，用「立即签到」执行已保存的项目：仅游戏、仅大别野，或两者一起。正在保存、保存失败、宿主端离线、已有签到任务或没有选择项目时，不能发起签到。总定时开关不影响手动签到；定时也用同一组已保存项目。手动、定时在同一实例共用互斥锁。
- 手动入口为 `POST /api/mys/run/checkin`，JSON 严格为 `{gameIds,dabieye,accountRevision}`，只含已确认项目和宿主提供的不透明账号会话版本。账号或项目变化时宿主拒绝请求，面板刷新；请核对后再点击，不会自动重试。旧手动路由已移除。
- 面板仅对状态响应标明 `checkinProtocol: 1` 且含有效 `configRevision` 和 `accountRevision` 的宿主启用设置与签到。设置通过 `POST /api/mys/config/checkin` 提交 `{config,configRevision}`，宿主仅在版本一致且完成原子文件替换后确认。旧配置写入路由已移除，无降级回退；遇到竞争会放弃旧草稿并重新显示已保存设置，需自行核对后重新应用。原子替换不保证断电持久性。
- 新配置以 `community.enabled` 保存大别野开关，`community.client` 保留独立客户端配置，不再保存分区列表。迁移时仅当旧社区配置已启用且包含 `5` 才保留启用，其他旧分区的结果和去重记录不再使用。当日大别野成功记录仍用于去重；登录凭据不迁移、不重置。
- 大别野需要完整 SToken 及对应账号标识，V2 还需要 mid；缺少社区凭据不挡游戏签到，可在面板重新短信登录修复。社区 Cookie 与游戏凭据分开构造。
- 自动尝试每日最多一次，纯手动不消耗自动尝试机会；两类项目仍各自判断是否已完成。大别野成功记录按 Asia/Shanghai 自然日去重，定时机会按配置时区计算。忙碌不消耗机会；没有跨进程锁，请勿在多个 DSH 实例并行运行同一账号。
- 「接口接受」不等于独立确认米游币到账。米游币是账号级只读快照，不计算本次赚取或承诺每日上限；有旧日期或新查询失败时，旧快照标为历史。写请求发出前记录对应账号的上海自然日；响应丢失标记结果不明，同日定时不会重发（即使重载本地状态），但符合条件的游戏仍可执行。再次手动签到前，请先去官方 App 核对。
- 签到遭遇验证码时停止剩余写操作，请去 App 处理；**对话框内人工验证仅覆盖短信登录**，不自动恢复已停止的签到任务。
- 设备 ID 持久保存；各端点版本/签名单独配置。游戏间随机 2–8 秒。仅明确会话失效时尝试派生刷新一次，不做定期续期。服务端风控策略变化时仍可能失败，不要频繁登录/补签。

面板显示账号、每游戏/社区结果、任务摘要、最近 200 条日志及顶部失败提示。日志和展示不包含 Cookie、短信验证码、手机号或 proof。`检测接口与登录` 会请求只读绑定接口，不是无网络自检。

## 协议与实现

| 环节 | 官方端点 |
| --- | --- |
| 发短信 | `POST passport-api.mihoyo.com/account/ma-cn-verifier/verifier/createLoginCaptcha` |
| 验证码登录 | `POST passport-api.mihoyo.com/account/ma-cn-passport/app/loginByMobileCaptcha` |
| 派生凭据 | `GET passport-api.mihoyo.com/account/auth/api/getLTokenBySToken`、`getCookieAccountInfoBySToken` |
| 角色校验 | `GET api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie` |
| 游戏签到 | `POST api-takumi.mihoyo.com/event/luna/{game}/sign`；绝区零使用 `act-nap-api.mihoyo.com` |
| 社区签到 | `POST bbs-api.miyoushe.com/apihub/app/api/signIn`，精确 JSON 字节参与 DS2 签名，零自动重试 |
| 米游币快照 | `GET bbs-api.miyoushe.com/apihub/wapi/getUserMissionsState?point_sn=myb` |

短信使用 app `2.116.0`、client_type `2`、app ID `bll8iq97cem8`；社区默认 app `2.117.0`，游戏 `2.109.0`。参数源于公开参考协议，**不是线上兼容性实测保证**。游戏高级参数仍可配置；社区 Host 配置保持独立。

主要模块：[短信协议](lib/sms-login.js)、[本轮状态机](lib/sms-flow.js)、[宿主服务](lib/service.js)、[隔离验证文档](lib/captcha-frame.js)、[游戏协议](lib/mys.js)、[社区协议](lib/community.js)、[调度](lib/scheduler.js)、[浏览器面板](client.js)。QR 路由、轮询、渲染器及专属配置已移除；历史 changelog/design 保留原有语境。

## 离线测试与已知未验收项

无需安装依赖：

```sh
node --test test/*.test.mjs
node --check client.js
node --check lib/service.js
```

测试使用临时 DSH_HOME、人工凭据与假接口，不回退真实网络；验证协议/状态机、取消与过期竞态、社区/调度非回归及回调/元素描述。**不是 DOM、截图或官方 widget 运行测试。** CI 保留 Node22/24；本次本地使用 Node24，未声称远端 CI 或 Node22 已运行。

未验收：真实短信及凭据派生、最小社区 Cookie 的线上接受性、官方 widget 在 opaque-origin/srcDoc/CSP 下的兼容性、当前 GUI 的窄屏/浅深色/键盘体验、安装重载与调度实跑。无浏览器控制工具时不使用假 renderer 代替验收。

## 参考与许可

本插件 [MIT](LICENSE)。社区协议参考 [MihoyoBBSTools](https://github.com/Womsxd/MihoyoBBSTools)，保留其 MIT 声明。短信协议参考 [IKUNHEIHIE/miyoushe-checkin](https://github.com/IKUNHEIHIE/miyoushe-checkin) 的公开端点与字段，未确认该参考项目的许可，不将其声称为 MIT 授权或打包其代码/服务。官方 widget 在线加载、不随插件分发、不代表获第三方许可或保证第三方服务可用；详情见 [第三方说明](THIRD_PARTY_NOTICES.md)。
