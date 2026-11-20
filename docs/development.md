# 开发与测试

[返回项目首页](../README.md)

## 环境与测试

需要 Node.js 22 或更高版本。插件采用 ESM，不需要安装第三方依赖或执行构建。在项目根目录运行：

```sh
node --test test/*.test.mjs
node --check client.js
node --check lib/service.js
```

测试使用合成凭据、临时状态目录和假接口，不需要真实米游社账号。客户端单元测试检查组件描述与回调，不代表实际浏览器布局、官方极验或线上签到已验收。涉及 UI 与宿主接口的改动，另在现有 DSH 界面验证；渠道、登录和签到应分别说明是否经过实测。

## 项目结构

| 路径 | 职责 |
| --- | --- |
| [`index.js`](../index.js) / [`cordis.patch.yml`](../cordis.patch.yml) | DSH 宿主入口与插件挂载配置 |
| [`client.js`](../client.js) | 侧栏面板、配置保存与手动操作 |
| [`lib/service.js`](../lib/service.js) | Owner 路由、帐号状态与签到执行 |
| [`lib/sms-login.js`](../lib/sms-login.js) / [`lib/sms-flow.js`](../lib/sms-flow.js) | 短信协议与临时登录流程 |
| [`lib/captcha-frame.js`](../lib/captcha-frame.js) | 隔离的官方人工验证文档 |
| [`lib/mys.js`](../lib/mys.js) / [`lib/community.js`](../lib/community.js) | 游戏与大别野协议；社区写入固定为 `gid=5` |
| [`lib/scheduler.js`](../lib/scheduler.js) / [`lib/run-policy.js`](../lib/run-policy.js) | 定时计划与范围完成规则 |
| [`lib/store.js`](../lib/store.js) | 本地状态持久化与旧配置迁移 |

## 宿主接口

以下路由用于已认证的 DSH 面板，**不是公共 API**。

| 方法及路径 | 用途 |
| --- | --- |
| `GET /api/mys/status` | 读取状态、配置、`checkinProtocol: 1` 及配置、账号版本 |
| `POST /api/mys/config/checkin` | 提交 `{config,configRevision}`，仅在版本一致且原子保存成功后应用 |
| `POST /api/mys/run/checkin` | 提交 `{gameIds,dabieye,accountRevision}`，宿主核对账号与已保存项目后才开始执行 |

旧的配置及手动签到路由不提供回退。版本或目标冲突不自动重试。游戏与大别野共用一次运行的锁，但保留独立结果；遇到人机验证时停止后续写入、避免重复签到，以及旧配置不能误启用大别野，都是应保留的回归边界。

## 提交与反馈

提交变更前运行相关测试；涉及保存、迁移、账号切换或写入边界时，增加对应的离线回归用例。报告中不要附带本机状态文件、账号数据或真实验证码。反馈与脱敏建议见[使用指南](usage.md#反馈问题)。第三方来源和许可见[第三方声明](../THIRD_PARTY_NOTICES.md)。
