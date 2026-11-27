/**
 * Browser half of the 米游社 check-in plugin.
 *
 * Registers the 米游社 sidebar panel and uses owner-only Host routes.
 * Long-term credentials never cross this boundary.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-mys-checkin',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const PLUGIN_ID = '@local/dsh-mys-checkin'
    const NS = 'mys-checkin'

    const CSS = `
.mys-section{max-width:820px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px}
.mys-head{display:flex;flex-direction:column;gap:4px}
.mys-title{margin:0;font-size:18px;font-weight:600;line-height:26px}
.mys-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.mys-settings-group{display:flex;flex-direction:column;gap:8px}
.mys-card-head{display:flex;align-items:flex-start;gap:12px}
.mys-card-head-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.mys-card-title{margin:0;font-size:14px;font-weight:600;line-height:22px}
.mys-card-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.mys-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.mys-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;padding:0 14px;font:inherit;font-size:14px;line-height:22px;border-radius:var(--dsw-radius-md,8px);cursor:pointer;white-space:nowrap;transition:background .12s ease,color .12s ease,border-color .12s ease}
.mys-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));outline-offset:2px}
.mys-btn[disabled]{opacity:.5;cursor:default}
.mys-btn-sm{height:28px;padding:0 10px;font-size:12px;line-height:18px;border-radius:var(--dsw-radius-sm,6px)}
.mys-btn-outline{border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary)}
.mys-btn-outline:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}
.mys-btn-primary{border:.5px solid transparent;background:var(--dsw-alias-button-primary-fill,#4d6bfe);color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:500}
.mys-btn-primary:hover{background:var(--dsw-alias-button-primary-hover,#3f5ae0)}
.mys-btn-ghost{border:.5px solid transparent;background:transparent;color:var(--dsw-alias-label-primary)}
.mys-btn-ghost:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}
.mys-danger-text{color:var(--dsw-alias-state-error-primary,#d93026)}
.mys-account{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;line-height:20px;min-width:0;max-width:100%}
.mys-meta{color:var(--dsw-alias-label-tertiary);font-size:12px}
.mys-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mys-row-label{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.mys-row-title{font-size:13px;line-height:20px}
.mys-row-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.mys-row input[type=checkbox]{flex:none;width:15px;height:15px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-button-primary-fill,#4d6bfe)}
.mys-switch{position:relative;flex:none;box-sizing:border-box;width:36px;height:20px;padding:0;border:none;border-radius:999px;cursor:pointer;background:var(--dsw-alias-border-selected);transition:background .15s ease}
.mys-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}
.mys-switch:disabled{opacity:.5;cursor:default}
.mys-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d8dff);outline-offset:2px}
.mys-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-switch-thumb);transition:transform .15s ease}
.mys-switch[aria-checked=true] .mys-knob{transform:translateX(16px)}
.mys-window{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mys-time{box-sizing:border-box;font:inherit;font-size:12px;height:28px;padding:0 8px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary)}
.mys-time:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#4d6bfe));outline-offset:1px}
.mys-banner{box-sizing:border-box;border-radius:10px;padding:10px 12px;font-size:13px;line-height:20px;display:flex;flex-direction:column;gap:6px;border:.5px solid transparent}
.mys-banner[hidden]{display:none}
.mys-banner[data-tone=error]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);border-color:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary)}
.mys-banner[data-tone=warn]{background:var(--dsw-alias-state-warn-tertiary);border-color:var(--dsw-alias-state-warn-secondary);color:var(--dsw-alias-state-warn-label)}
.mys-banner[data-tone=ok]{background:var(--dsw-alias-state-success-tertiary);border-color:var(--dsw-alias-state-success-secondary);color:var(--dsw-alias-state-success-primary)}
.mys-banner-actions{display:flex;gap:8px;flex-wrap:wrap}
.mys-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:10px}
.mys-field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.mys-input{box-sizing:border-box;font:inherit;font-size:12px;height:28px;padding:0 8px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);width:100%}
.mys-input:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#4d6bfe));outline-offset:1px}
.mys-table{width:100%;border-collapse:collapse;font-size:12px}
.mys-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary);padding:4px 6px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.mys-table td{padding:4px 6px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.mys-tag{display:inline-block;font-size:11px;line-height:16px;padding:0 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-3,#eceff3);color:var(--dsw-alias-label-secondary,#4b5563)}
.mys-tag[data-tone=ok]{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary)}
.mys-tag[data-tone=warn]{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label)}
.mys-tag[data-tone=error]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 13%,transparent);color:var(--dsw-alias-state-error-primary)}
.mys-logs{max-height:200px;overflow:auto;display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:18px;font-family:var(--ds-font-family-code)}
.mys-log{display:flex;gap:8px}
.mys-log-time{color:var(--dsw-alias-label-tertiary);flex:none}
.mys-log[data-level=warn] .mys-log-text{color:var(--dsw-alias-state-warn-label)}
.mys-log[data-level=error] .mys-log-text{color:var(--dsw-alias-state-error-primary)}
.mys-empty{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.mys-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.45);padding:24px}
.mys-captcha-viewport[data-active=false]{height:0;overflow:hidden}
.mys-captcha-start{font:inherit;color:inherit;border:1px solid currentColor;background:transparent;border-radius:6px;padding:6px 12px;cursor:pointer}
.mys-captcha-frame{width:100%;height:420px;border:0;background:#fff;border-radius:8px}
.mys-dialog form{display:flex;flex-direction:column;gap:12px}
.mys-dialog{max-height:calc(100dvh - 48px);overflow:auto;box-sizing:border-box;width:min(380px,100%);background:var(--dsw-alias-bg-layer-1,#fff);border-radius:14px;padding:20px;display:flex;flex-direction:column;gap:12px;box-shadow:0 24px 60px rgba(0,0,0,.35);color:var(--dsw-alias-label-primary)}
.mys-dialog-title{margin:0;font-size:16px;font-weight:600}
.mys-dialog-foot{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end}
.mys-details{font-size:13px}
.mys-details summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#4b5563);font-size:13px;line-height:22px}
.mys-details[open] summary{margin-bottom:8px}
.mys-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.mys-list{display:flex;flex-direction:column;gap:8px}
.mys-page{box-sizing:border-box;height:100%;overflow:auto;color:var(--dsw-alias-label-primary);padding:24px clamp(16px,4vw,40px) 32px;display:flex;flex-direction:column;gap:10px}
.mys-page>*{width:100%;max-width:880px;margin-inline:auto;flex:none}
.mys-page-head,.mys-overview{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px}
.mys-page-title{margin:0;font-size:20px;font-weight:600;line-height:28px}
.mys-overview{padding:6px 0 10px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.mys-avatar{width:28px;height:28px;border-radius:50%;object-fit:cover;flex:none;background:var(--dsw-alias-bg-layer-3);display:grid;place-items:center;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.mys-account-name{font-size:13px;font-weight:600;overflow-wrap:anywhere}
.mys-schedule-inline{display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.mys-schedule-inline label{white-space:nowrap}
.mys-page-section{display:flex;flex-direction:column;gap:6px;padding-block:2px 6px}
.mys-page-section h2,.mys-page-section h3{margin:0;font-size:14px;font-weight:600;line-height:22px}
.mys-record-head{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px}
.mys-record-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.mys-log-snapshot{display:flex;flex-direction:column;gap:4px;padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.mys-log-snapshot h4{margin:0;font-size:12px;font-weight:600;line-height:18px}
.mys-game-table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:12px;line-height:18px;text-align:left;overflow-wrap:anywhere}
.mys-game-table th,.mys-game-table td{padding:6px 8px 6px 0;border-bottom:1px solid var(--dsw-alias-border-l2);vertical-align:top}
.mys-game-table thead th{font-weight:400;color:var(--dsw-alias-label-secondary)}
.mys-game-table thead th:first-child{width:40%}
.mys-game-table thead th:nth-child(2){width:25%}
.mys-game-table tbody th{font-weight:500}
.mys-game-table tbody tr:last-child>*{border-bottom:0}
.mys-game-meta{display:block;font-weight:400;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.mys-status{color:var(--dsw-alias-label-secondary)}
.mys-status[data-outcome=signed],.mys-status[data-outcome=already],.mys-status[data-outcome=success],.mys-status[data-outcome=cached-success]{color:var(--dsw-alias-state-success-primary)}
.mys-status[data-outcome=captcha],.mys-status[data-outcome=unknown],.mys-status[data-outcome=auth-unavailable],.mys-status[data-outcome=first-bind],.mys-status[data-outcome=not-bound]{color:var(--dsw-alias-state-warn-label)}
.mys-status[data-outcome=expired],.mys-status[data-outcome=error]{color:var(--dsw-alias-state-error-primary)}
.mys-disclosure{border-top:1px solid var(--dsw-alias-border-l2)}
.mys-disclosure>summary{padding:9px 0;cursor:pointer;font-size:13px;font-weight:500;line-height:20px}
.mys-disclosure>summary:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
.mys-disclosure>summary .mys-meta{margin-inline-start:8px;font-weight:400;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.mys-disclosure-body{display:flex;flex-direction:column;gap:12px;padding:4px 0 8px}
.mys-badge{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:55;display:flex;align-items:center;gap:8px;max-width:min(560px,calc(100vw - 32px));box-sizing:border-box;padding:6px 10px;border-radius:999px;font-size:12px;line-height:18px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-error-primary);border:1px solid var(--dsw-alias-state-error-secondary);pointer-events:auto}
.mys-badge[data-tone=warn]{color:var(--dsw-alias-state-warn-label);border-color:var(--dsw-alias-state-warn-secondary)}
.mys-badge-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mys-badge-close{flex:none;border:none;background:transparent;color:inherit;font:inherit;cursor:pointer;opacity:.8;padding:0 2px}
.mys-badge-close:hover{opacity:1}
`

    const zh = {
      smsTitle: "短信登录米游社",
      smsHint: "仅支持中国大陆 +86 手机号。点击发送后才会请求短信；如遇风控，请在下方亲自完成官方验证。不会自动重发。",
      smsPhone: "手机号（+86）",
      smsCode: "6 位短信验证码",
      smsSend: "发送验证码",
      smsResend: "重新发送",
      smsSubmit: "验证并登录",
      smsCancel: "取消",
      smsBusy: "正在处理，请稍候…",
      smsBadPhone: "请输入有效的 11 位大陆手机号。",
      smsBadCode: "请输入 6 位短信验证码。",
      smsWrongCode: "验证码不正确或已失效，请重新输入。",
      smsFailed: "请求未完成。请检查状态后重试；若发送结果不明，请先等待短信，不会自动重发。",
      smsCooldown: "请等待倒计时结束后再发送。",
      smsRateLimited: "请求过于频繁，请稍后重新登录。",
      smsOfficialAction: "账号需要官方实名、身份验证或恢复操作。请前往米游社官方客户端处理，再重新登录；插件无法代办。",
      smsGameValidation: "新登录未保存：游戏凭据只读校验失败。已有登录未被替换，请取消后核对账号并重试。",
      smsCommunityValidation: "新登录未保存：已启用社区的凭据只读校验失败。已有登录未被替换，请取消后核对账号与社区设置。",
      smsOutcomeUnknown: "请求可能已经送达，但结果未确认。不会自动重试；请先等待短信或到官方客户端核对，不要立即重复发送。",
      smsStage: "失败阶段", smsRetcode: "官方返回码",
      smsStage_sms: "发送短信", smsStage_login: "短信登录", smsStage_ltoken: "换取 LToken", smsStage_cookie: "换取 Cookie 凭据",
      smsRejected: "官方接口明确拒绝了本次请求。不会自动重试；请取消后检查账号状态，必要时前往官方客户端处理。",
      smsInvalidResponse: "官方响应格式不符合预期，本次未保存新登录。请取消后检查官方服务状态。",
      smsNetwork: "未能完成官方接口的只读请求，本次未保存新登录。请检查网络后重试。",
      smsExpired: "本轮登录已过期，请取消后重新登录。",
      smsCountdown: "{seconds} 秒后可重新发送",
      smsCodeSent: "官方已确认发送。请查看手机短信。",
      smsSendPending: "等待官方确认。请勿重复发送。",
      smsSendChallenge: "需要人工验证。请在下方完成验证。",
      smsSendChallengeUnavailable: "需要人工验证，但验证框未加载。请取消后重新登录。",
      smsSendUnknown: "结果未确认。请先查看短信，不要立即重发。",
      smsSendRejected: "本次发送请求未获受理。",
      smsVerification: "官方人工验证",
      smsWidgetLoading: "正在加载官方验证…",
      smsWidgetStart: "开始人工验证", smsWidgetOpening: "正在打开官方验证…",
      smsWidgetOpenFailed: "官方验证界面未能打开。请取消后重新登录；不会自动重发短信。",
      smsWidgetFailed: "人工验证未完成或加载失败。请取消后重新登录；不会自动发送短信。",
      smsSuccess: "登录成功，凭据已完成只读校验。",
      smsSuccessWarning: "游戏凭据校验通过；社区只读校验未通过，请查看社区状态。",
      communityItem: '大别野',
      communityNoToken: "社区凭据不完整，请重新短信登录；不影响游戏登录。",
      communityMissingMid: "V2 社区凭据缺少必要信息，请重新短信登录；不影响游戏登录。",
      communityPartial: "上次大别野签到未完成",
      communityAccepted: "积分到账未独立验证。",
      communityNoResult: "尚无社区签到记录",
      communityRisk: "需要人工验证：请在米游社 App 手动处理后再决定是否重试。",
      communityBalanceRisk: "查询米游币余额时需要人工验证，请在米游社 App 处理。",
      communityUnknown: "结果不明：请先在米游社 App 核对，不要盲目重复请求。",
      communityBalanceFail: "积分查询失败；不代表大别野签到失败。",
      communityHistorical: "历史积分快照",
      communityCurrent: "今日查询快照",
      communityBalance: "米游币余额",
      communityReceived: "快照当日已获取",
      communityRemaining: "快照当日剩余",
      communitySnapshotAt: "查询时间",
      communityNoBalance: "尚无积分查询快照",
      communityOutcomeSuccess: "接口已接受",
      communityOutcomeCached: "本机已记录今日接口接受",
      communityOutcomeCaptcha: "待人工验证",
      communityOutcomeUnknown: "结果不明",
      communityOutcomeAuth: "社区凭据不可用",
      communityOutcomeExpired: "社区凭据已失效，请重新短信登录",
      communityOutcomeError: "失败",
      communityOutcomeSkipped: "未执行",
      outcomeSkipped: "未执行",
      nav: '米游社',
      title: '米游社签到',
      intro: '在同一处选择游戏与大别野签到项目，手动和定时按已保存的项目执行。登录凭据只保存在本机。',
      account: '账号',
      accountDetails: '账号详情与诊断',
      sendDiag: '最近一次发送诊断', sendDiagEmpty: '尚未记录发送尝试。',
      diag_start: '创建登录流程', diag_send: '发送短信', diag_notSent: '未提交发送', diag_confirmed: '官方已确认发送',
      diag_challenge: '需要人工验证', diag_rejected: '请求未获受理', diag_unknown: '发送结果未确认', diagPoll: '查询发送状态失败',
      checkinSettings: '签到设置',
      showTargets: '查看签到项目',
      showAccount: '查看当前账号',
      scheduleLogin: '待登录',
      scheduleNoTargets: '未安排：未选项目',
      scheduleUnplanned: '未安排',
      gameRecordSummary: '{done}/{total} 项完成',
      accountDesc: '使用大陆 +86 手机号短信登录。凭据仅保存于本机；SToken 失效后仍需重新登录。',
      login: '短信登录',
      relogin: '重新登录',
      refresh: '续期凭据',
      refreshing: '续期中…',
      noStoken: '当前凭据不含 SToken，无法自动续期。',
      noStokenHint: '请重新短信登录获取完整凭据；无法保证长期免登录。',
      upgradeLogin: '短信登录获取 SToken',
      deleteLogin: '删除登录',
      deleteConfirm: '再次点击确认删除',
      loginDeleted: '登录数据已删除',
      logout: '退出登录',
      stateAnonymous: '未登录',
      stateActive: '已登录',
      stateExpired: '登录已失效',
      uid: '米游社 UID',
      loginAt: '登录于',
      lastRefresh: '最近续期',
      never: '从未',
      auto: '自动签到',
      autoDesc: '开启后，每天只在时间窗口内执行一次；随机时刻可以避免整点请求特征。',
      enabled: '启用自动签到',
      windows: '时间窗口',
      windowsDesc: '每个窗口内随机选择一个时刻执行。开始时间晚于结束时间时，自动把结束时间设为开始时间 +1 分钟。',
      addWindow: '添加窗口',
      remove: '删除',
      runWhenMissed: '错过窗口后补跑',
      runWhenMissedDesc: '如果 DSH 在窗口结束后才启动，且当天还没签过，则在几分钟内随机补跑一次。',
      nextRun: '下次执行',
      noPlan: '未安排（自动签到未启用）',
      timezone: '时区',
      notQueried: '尚未读取角色',
      noRole: '无角色',
      bound: '已绑定',
      incompatibleHost: '签到宿主端不兼容。请确认宿主与面板为同一版本，再重新加载页面。',
      accountChanged: '登录账号或会话已变更。请核对当前账号，再次点击「立即签到」。未自动重试。',
      saveConflict: '其他面板修改了设置，未保存的更改已放弃。请核对已保存设置，按需重新应用。',
      saveFeedback: '签到设置保存状态',
      useSaved: '使用已保存设置',
      recordNote: '游戏与大别野分别记录，不一定来自同一轮签到。',
      recordHistorical: '历史记录',
      coinHeading: '账号米游币快照',
      projects: '签到项目',
      projectsDesc: '手动与定时签到使用相同的已保存项目。',
      dabieye: '大别野（米游币）',
      dabieyeDesc: '默认关闭；仅签到，不看帖、点赞或分享。',
      runLoading: '正在加载已保存的签到项目…',
      runOffline: '无法连接插件宿主端；恢复连接后才能签到。',
      runBusy: '签到正在进行，请稍候。',
      runLogin: '请先短信登录。',
      noTargets: '请至少选中一个签到项目。',
      staleTargets: '签到项目刚刚变更。请查看更新后的签到项目，确认后再次点击「立即签到」。',
      targetsChanged: '已保存的签到项目已变更。请查看最新设置，再决定是否签到。未自动重试。',
      runFailed: '签到请求未确认完成。请查看结果，不要立即重复签到。',
      runNow: '立即签到',
      running: '签到中…',
      verify: '检测接口与登录',
      verifying: '检测中…',
      result: '最近一次结果',
      resultDesc: '按游戏列出本次签到结果。',
      colTime: '时间',
      colGame: '游戏',
      colResult: '结果',
      colDetail: '说明',
      noResult: '尚无游戏签到记录。',
      advanced: '高级设置',
      gap: '游戏间隔（秒）',
      gapMin: '最小',
      gapMax: '最大',
      appVersion: '客户端版本',
      appVersionDesc: '与签名 salt 必须匹配；米哈游更新客户端后可能需要同步修改。',
      salt: '签名 salt',
      retry: '失败重试',
      retryAttempts: '重试次数',
      retryDelay: '重试间隔（秒）',
      logs: '运行日志',
      logsEmpty: '暂无日志。',
      saveOk: '已保存',
      saveFail: '未能确认设置已保存，未保存的编辑已放弃。请核对宿主设置，再重新应用或选择使用已保存设置。',
      saveFailed: '保存失败：{message}',
      loadFailed: '无法连接插件宿主端：{message}',
      hostMissing: '插件宿主端未加载。请重新加载页面；若仍无效，重启 DSH。',
      bannerExpired: '登录状态已失效，自动签到无法继续。',
      bannerCaptcha: '签到因人工验证停止。请在米游社 App 手动完成验证，再决定是否重试。',
      bannerRun: '最近一次签到失败。',
      verifyOk: '接口可用，登录有效（{ms}ms）',
      verifyAnon: '尚未登录，无法检测登录状态。',
      verifyFail: '网络不可达：{message}',
      verifyInvalid: '接口可用，但登录无效：{message}',
      verifyUnavailable: '未能确认接口或登录状态，请稍后再检测。',
      riskTitle: '降低被风控的建议',
      riskList: '1) 每天只签一次，不要频繁手动补签。2) 保持固定的 device_id：本插件首次运行后不再更改，请不要删除状态文件。3) 不要在同一台机器上用同一个 DSH 反复登录多个账号。4) 触发验证码时先在米游社 App 内手动完成，不要连续重试。5) 网络出口尽量稳定，避免频繁更换 IP 或代理。',
      outcomeSigned: '成功',
      outcomeAlready: '今日已签到',
      outcomeNoRole: '无角色',
      outcomeCaptcha: '需验证',
      outcomeExpired: '登录失效',
      outcomeNotBound: '未绑定',
      outcomeError: '失败',
      reasonWindow: '窗口内随机',
      reasonInside: '当前窗口内',
      reasonMissed: '错过窗口，补跑',
      reasonDoneToday: '今日已完成，等待明天',
      reasonPassed: '今日窗口已过',
      enabledOn: '开',
      enabledOff: '关',
      save: '保存',
      saving: '保存中…',
      lastRun: '上次执行',
      gamesCount: '{count} 个游戏',
      badgeExpired: '米游社：登录已失效，签到已停止',
      badgeCaptcha: '米游社：需要人机验证，今日签到已停止',
      badgeRun: '米游社：自动签到失败',
      badgeDismiss: '忽略本次提示',
      badgeOpen: '在左侧栏「米游社签到」中处理',
      panel: '米游社签到',
      taskPanelTitle: '米游社签到',
      taskName: '每日签到',
      taskFrequency: '运行频率',
      taskRandom: '（窗口内随机）',
      taskNextRun: '下次运行',
      taskLastRun: '最近游戏签到',
      taskPause: '暂停',
      taskResume: '启用',
      taskRunHistory: '运行记录',
      taskNoHistory: '还没有运行记录。',
      taskStateActive: '已启用',
      taskStatePaused: '已暂停',
      taskStateAnonymous: '未登录',
      taskStateExpired: '登录已失效',
      taskResumed: '已启用自动签到',
      taskPaused: '已暂停自动签到',
      runTitle: '最近签到',
      runGameSummary: '游戏：{summary}',
      colTarget: '签到项目',
      colRewardOrNote: '奖励 / 说明',
      runSigned: '该记录签到成功',
      runAccounts: '个账号',
      runAuto: '是否自动签到',
      runAt: '签到时间',
      runDone: '已完成',
      runPartial: '未完成',
      runAccountUnit: '个账号',
      colStatus: '签到状态',
      colReward: '签到奖励',
      colTotal: '累计签到',
      runFooterDone: '该游戏记录中的项目已完成。',
      runFooterPartial: '该游戏记录并未全部完成，请查看各项目结果。',
      yes: '是',
      no: '否',
      outcomeFirstBind: '待手动签到',
    }

    const en = {
      smsTitle: "Sign in to miHoYo by SMS",
      smsHint: "Mainland China +86 numbers only. SMS is requested only when you press Send. Complete any official verification below yourself. No automatic resend.",
      smsPhone: "Mobile number (+86)",
      smsCode: "6-digit SMS code",
      smsSend: "Send code",
      smsResend: "Resend code",
      smsSubmit: "Verify and sign in",
      smsCancel: "Cancel",
      smsBusy: "Processing…",
      smsBadPhone: "Enter a valid 11-digit mainland China mobile number.",
      smsBadCode: "Enter the 6-digit SMS code.",
      smsWrongCode: "The code is incorrect or expired. Please enter it again.",
      smsFailed: "The request did not complete. Check the state before retrying. If delivery is uncertain, wait for the SMS; it is never resent automatically.",
      smsCooldown: "Wait for the countdown before sending again.",
      smsRateLimited: "Too many requests. Please sign in again later.",
      smsOfficialAction: "Official identity verification or account recovery is required. Use the official app, then start again; this plugin cannot perform it for you.",
      smsGameValidation: "New login not saved: read-only game credential validation failed. Existing login unchanged. Cancel, check the account and try again.",
      smsCommunityValidation: "New login not saved: required community credential validation failed. Existing login unchanged. Cancel and check the account and community settings.",
      smsOutcomeUnknown: "The request may have arrived, but its result is unknown. No automatic retry. Wait for the SMS or check the official app; do not immediately send again.",
      smsStage: "Failed step", smsRetcode: "Official return code",
      smsStage_sms: "Send SMS", smsStage_login: "SMS login", smsStage_ltoken: "Exchange LToken", smsStage_cookie: "Exchange cookie credentials",
      smsRejected: "The official API rejected this request. No automatic retry. Cancel and check the account in the official app if needed.",
      smsInvalidResponse: "Unexpected official response. New login not saved. Cancel and check the official service status.",
      smsNetwork: "The official read-only request could not complete. New login not saved. Check your network before retrying.",
      smsExpired: "This login expired. Cancel and start again.",
      smsCountdown: "Resend available in {seconds}s",
      smsCodeSent: "The service confirmed sending the SMS. Check your phone.",
      smsSendPending: "Waiting for confirmation. Do not resend yet.",
      smsSendChallenge: "Human verification required. Complete the verification below.",
      smsSendChallengeUnavailable: "Human verification required, but the widget is unavailable. Cancel and start again.",
      smsSendUnknown: "Sending is unconfirmed. Check your messages before resending.",
      smsSendRejected: "This send request was not accepted.",
      smsVerification: "Official manual verification",
      smsWidgetLoading: "Loading official verification…",
      smsWidgetStart: "Start verification", smsWidgetOpening: "Opening official verification…",
      smsWidgetOpenFailed: "The verification panel could not open. Cancel and sign in again. No SMS will be resent automatically.",
      smsWidgetFailed: "Verification was not completed or could not load. Cancel and sign in again. No SMS was sent automatically.",
      smsSuccess: "Signed in; read-only credential checks passed.",
      smsSuccessWarning: "Game credentials verified; the community check did not pass. See community status.",
      communityItem: 'Dabieye',
      communityNoToken: "Community credentials are incomplete. Sign in again by SMS; game login is unaffected.",
      communityMissingMid: "Required V2 community credentials are missing. Sign in again by SMS; game login is unaffected.",
      communityPartial: "Dabieye check-in did not complete",
      communityAccepted: "Coin credit has not been independently verified.",
      communityNoResult: "No community check-in record yet",
      communityRisk: "Manual verification is required. Complete it in the Miyoushe App before deciding whether to retry.",
      communityBalanceRisk: "Viewing the coin balance requires manual verification in the Miyoushe App.",
      communityUnknown: "Unknown result. Check in the Miyoushe App before retrying; do not blindly resend.",
      communityBalanceFail: "Coin query failed; community check-in may still have succeeded.",
      communityHistorical: "Historical coin snapshot",
      communityCurrent: "Snapshot queried today",
      communityBalance: "Coin balance",
      communityReceived: "Received on snapshot day",
      communityRemaining: "Remaining on snapshot day",
      communitySnapshotAt: "Queried at",
      communityNoBalance: "No coin snapshot yet",
      communityOutcomeSuccess: "Request accepted",
      communityOutcomeCached: "Acceptance recorded locally today",
      communityOutcomeCaptcha: "Manual verification required",
      communityOutcomeUnknown: "Unknown result",
      communityOutcomeAuth: "Community credentials unavailable",
      communityOutcomeExpired: "Community credentials expired; sign in again by SMS",
      communityOutcomeError: "Failed",
      communityOutcomeSkipped: "Not executed",
      outcomeSkipped: "Not executed",
      nav: 'miHoYo',
      title: 'miHoYo check-in',
      intro: 'Choose games and Dabieye in one place. Manual and scheduled check-ins use your saved selection. Credentials stay on this device.',
      account: 'Account',
      accountDetails: 'Account details and diagnostics',
      sendDiag: 'Latest SMS send diagnostic', sendDiagEmpty: 'No send attempt recorded yet.',
      diag_start: 'Create login flow', diag_send: 'Send SMS', diag_notSent: 'Send not submitted', diag_confirmed: 'Service confirmed sending',
      diag_challenge: 'Human verification required', diag_rejected: 'Request not accepted', diag_unknown: 'Send outcome unknown', diagPoll: 'Send status query failed',
      checkinSettings: 'Check-in settings',
      showTargets: 'View check-in targets',
      showAccount: 'View current account',
      scheduleLogin: 'Sign-in required',
      scheduleNoTargets: 'Not scheduled: no targets selected',
      scheduleUnplanned: 'Not scheduled',
      gameRecordSummary: '{done}/{total} completed',
      accountDesc: 'Sign in with a mainland China +86 mobile number. Credentials stay on this device; an expired SToken requires signing in again.',
      login: 'Sign in by SMS',
      relogin: 'Sign in again',
      refresh: 'Refresh credentials',
      refreshing: 'Refreshing…',
      noStoken: 'This credential has no SToken, so it cannot be renewed automatically.',
      noStokenHint: 'Sign in again by SMS to obtain complete credentials. Permanent login is not guaranteed.',
      upgradeLogin: 'Sign in by SMS for SToken',
      deleteLogin: 'Delete login',
      deleteConfirm: 'Click again to delete',
      loginDeleted: 'Login data deleted',
      logout: 'Sign out',
      stateAnonymous: 'Not signed in',
      stateActive: 'Signed in',
      stateExpired: 'Session expired',
      uid: 'miHoYo UID',
      loginAt: 'Signed in',
      lastRefresh: 'Last refresh',
      never: 'never',
      auto: 'Automatic check-in',
      autoDesc: 'Runs once a day inside a window; the random moment avoids on-the-hour patterns.',
      enabled: 'Enable automatic check-in',
      windows: 'Time windows',
      windowsDesc: 'One random moment inside each window. If the start is later than the end, the end snaps to the start + 1 minute.',
      addWindow: 'Add window',
      remove: 'Remove',
      runWhenMissed: 'Catch up when missed',
      runWhenMissedDesc: 'If DSH starts after the window and nothing ran today, run once a few minutes later.',
      nextRun: 'Next run',
      noPlan: 'Not scheduled (automatic check-in is off)',
      timezone: 'Time zone',
      notQueried: 'Roles not read yet',
      noRole: 'No character',
      bound: 'Bound',
      incompatibleHost: 'Incompatible check-in host. Make sure the panel and host are the same version, then reload the page.',
      accountChanged: 'The account or session changed. Review the current account and click Check in now again. No retry was sent.',
      saveConflict: 'Settings changed in another panel. Your unsaved edits were discarded. Review the saved settings and reapply your edits if needed.',
      saveFeedback: 'Check-in settings save status',
      useSaved: 'Use saved settings',
      recordNote: 'Games and Dabieye are recorded independently and may not be from the same run.',
      recordHistorical: 'Historical record',
      coinHeading: 'Account coin snapshot',
      projects: 'Check-in targets',
      projectsDesc: 'Manual and scheduled check-ins use the same saved targets.',
      dabieye: 'Dabieye (coins)',
      dabieyeDesc: 'Off by default. Check-in only: no reading, liking or sharing posts.',
      runLoading: 'Loading saved check-in targets…',
      runOffline: 'Cannot reach the plugin host. Reconnect before checking in.',
      runBusy: 'A check-in is in progress. Please wait.',
      runLogin: 'Sign in by SMS first.',
      noTargets: 'Select at least one check-in target.',
      staleTargets: 'The targets just changed. Review the updated selection, then click Check in now again.',
      targetsChanged: 'The saved targets changed. Review the latest settings before checking in. The request was not retried.',
      runFailed: 'The check-in request did not confirm completion. Review the results before trying again.',
      runNow: 'Check in now',
      running: 'Checking in…',
      verify: 'Test connection and session',
      verifying: 'Testing…',
      result: 'Last result',
      resultDesc: 'Per-game outcome of the last run.',
      colTime: 'Time',
      colGame: 'Game',
      colResult: 'Result',
      colDetail: 'Detail',
      noResult: 'No game check-in record yet.',
      advanced: 'Advanced',
      gap: 'Gap between games (s)',
      gapMin: 'min',
      gapMax: 'max',
      appVersion: 'Client version',
      appVersionDesc: 'Must match the signature salt. Update after a client release.',
      salt: 'Signature salt',
      retry: 'Retry',
      retryAttempts: 'Attempts',
      retryDelay: 'Delay (s)',
      logs: 'Run log',
      logsEmpty: 'No log entries yet.',
      saveOk: 'Saved',
      saveFail: 'The save could not be confirmed. Your draft was discarded. Review the host settings and reapply your edits or use the saved settings.',
      saveFailed: 'Save failed: {message}',
      loadFailed: 'Cannot reach the plugin host: {message}',
      hostMissing: 'The plugin host is not loaded. Reload the page, and restart DSH if this persists.',
      bannerExpired: 'The session expired; automatic check-in cannot continue.',
      bannerCaptcha: 'Check-in stopped for human verification. Complete it manually in the Miyoushe App before deciding whether to retry.',
      bannerRun: 'The last check-in failed.',
      verifyOk: 'API reachable, session valid ({ms}ms)',
      verifyAnon: 'Not signed in; nothing to verify.',
      verifyFail: 'Network unreachable: {message}',
      verifyInvalid: 'API reachable but the session is invalid: {message}',
      verifyUnavailable: 'Could not confirm the connection or session. Check again later.',
      riskTitle: 'Lowering risk-control flags',
      riskList: '1) One run per day; avoid repeated manual retries. 2) Keep the device id stable: it never changes after first use, so do not delete the state file. 3) Do not sign several accounts in from the same device. 4) When a captcha appears, clear it in the miHoYo app instead of retrying. 5) Keep the network egress stable; avoid hopping IPs or proxies.',
      outcomeSigned: 'Signed',
      outcomeAlready: 'Already signed',
      outcomeNoRole: 'No character',
      outcomeCaptcha: 'Needs verification',
      outcomeExpired: 'Session expired',
      outcomeNotBound: 'Not bound',
      outcomeError: 'Failed',
      reasonWindow: 'random in window',
      reasonInside: 'inside window',
      reasonMissed: 'catch-up run',
      reasonDoneToday: 'done today, waiting for tomorrow',
      reasonPassed: 'window passed',
      enabledOn: 'on',
      enabledOff: 'off',
      save: 'Save',
      saving: 'Saving…',
      lastRun: 'Last run',
      gamesCount: '{count} games',
      badgeExpired: 'miHoYo: session expired — check-in stopped',
      badgeCaptcha: 'miHoYo: human verification required',
      badgeRun: 'miHoYo: automatic check-in failed',
      badgeDismiss: 'Dismiss this notice',
      badgeOpen: 'Resolve it in the sidebar panel “miHoYo check-in”',
      panel: 'miHoYo check-in',
      taskPanelTitle: 'miHoYo check-in',
      taskName: 'Daily check-in',
      taskFrequency: 'Schedule',
      taskRandom: ' (random inside the window)',
      taskNextRun: 'Next run',
      taskLastRun: 'Last game check-in',
      taskPause: 'Pause',
      taskResume: 'Resume',
      taskRunHistory: 'Run history',
      taskNoHistory: 'No runs recorded yet.',
      taskStateActive: 'Active',
      taskStatePaused: 'Paused',
      taskStateAnonymous: 'Not signed in',
      taskStateExpired: 'Session expired',
      taskResumed: 'Automatic check-in resumed',
      taskPaused: 'Automatic check-in paused',
      runTitle: 'Recent check-ins',
      runGameSummary: 'Games: {summary}',
      colTarget: 'Check-in target',
      colRewardOrNote: 'Reward / note',
      runSigned: 'Successful in this record:',
      runAccounts: 'accounts',
      runAuto: 'Automatic',
      runAt: 'At',
      runDone: 'Done',
      runPartial: 'Incomplete',
      runAccountUnit: ' accounts',
      colStatus: 'Status',
      colReward: 'Reward',
      colTotal: 'Total days',
      runFooterDone: 'The targets in this game record were completed.',
      runFooterPartial: 'This game record is incomplete. See the individual results.',
      yes: 'yes',
      no: 'no',
      outcomeFirstBind: 'Manual first sign-in',
    }

    const OUTCOME_TONE = {
      signed: 'ok',
      already: 'ok',
      'no-role': '',
      captcha: 'warn',
      expired: 'error',
      'not-bound': 'warn',
      'first-bind': 'warn',
      error: 'error',
    }

    const OUTCOME_KEY = {
      signed: 'outcomeSigned',
      already: 'outcomeAlready',
      'no-role': 'outcomeNoRole',
      captcha: 'outcomeCaptcha',
      expired: 'outcomeExpired',
      'not-bound': 'outcomeNotBound',
      'first-bind': 'outcomeFirstBind',
      skipped: 'outcomeSkipped',
      error: 'outcomeError',
    }

    function apiUrl(path) {
      return new URL(`api/mys/${path}`, document.baseURI).href
    }

    async function requestJson(path, init) {
      const response = await fetch(apiUrl(path), {
        credentials: 'include',
        cache: 'no-store',
        ...init,
      })
      const text = await response.text()
      if (text.trim() === '') {
        if (response.status === 404) throw new Error('host-missing')
        throw new Error(`HTTP ${response.status}`)
      }
      let body
      try {
        body = JSON.parse(text)
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      return body
    }

    async function callJson(path, init) {
      const body = await requestJson(path, init)
      if (body !== null && typeof body === 'object' && body.ok === false) {
        throw Object.assign(new Error(body.error?.message ?? 'request failed'), { code: body.error?.code })
      }
      return body
    }

    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined ? match : String(values[key])))
    }

    function formatTime(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      try {
        return new Date(value).toLocaleString('zh-CN', { hour12: false })
      } catch {
        return new Date(value).toISOString()
      }
    }

    function formatTarget(value, timeZone) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null
      try {
        return new Intl.DateTimeFormat('zh-CN', {
          timeZone,
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(new Date(value))
      } catch {
        return formatTime(value)
      }
    }

    function shortTime(value) {
      const text = formatTime(value)
      return text.replace(/^\d{4}[/-]/, '')
    }

    function clockToMinutes(text) {
      const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim())
      if (match === null) return null
      const hour = Number(match[1])
      const minute = Number(match[2])
      if (hour > 23 || minute > 59) return null
      return hour * 60 + minute
    }

    function minutesToClock(minutes) {
      const value = Math.max(0, Math.min(1439, Math.round(minutes)))
      return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
    }

    /** One accent per game, so a multi-game result list stays scannable. */
    function awardsText(awards) {
      if (!Array.isArray(awards) || awards.length === 0) return '—'
      return awards
        .filter((award) => award !== null && typeof award === 'object')
        .map((award) => `${award.name ?? ''}${award.cnt === undefined ? '' : `×${award.cnt}`}`)
        .join('、')
    }

    // Local semantic controls; DS styles are shared through theme tokens only.
    function Button({ variant = 'outline', size = 'md', className, children, ...rest }) {
      const mapped = variant === 'primary' ? 'primary' : variant === 'danger' ? 'ghost' : 'outline'
      return h('button', {
        type: 'button',
        ...rest,
        className: ['mys-btn', `mys-btn-${mapped}`, size === 'sm' ? 'mys-btn-sm' : '', variant === 'danger' && 'mys-danger-text', className].filter(Boolean).join(' '),
        children,
      })
    }

    function Switch({ id, checked, onChange, label, disabled }) {
      return h('button', {
        type: 'button',
        id,
        role: 'switch',
        'aria-checked': checked === true,
        'aria-label': label,
        disabled: disabled === true,
        className: 'mys-switch',
        onClick: () => { if (!disabled) onChange(!checked) },
      }, h('span', { className: 'mys-knob', 'aria-hidden': true }))
    }

    function SettingsGroup({ title, desc, id, children }) {
      return h('section', { className: 'mys-settings-group', 'aria-labelledby': id && title ? `${id}-title` : undefined, 'aria-describedby': id && desc ? `${id}-desc` : undefined },
        (title || desc) ? h('div', { className: 'mys-card-head' },
          h('div', { className: 'mys-card-head-text' },
            title ? h('h3', { className: 'mys-card-title', id: id ? `${id}-title` : undefined }, title) : null,
            desc ? h('div', { className: 'mys-card-desc', id: id ? `${id}-desc` : undefined }, desc) : null)) : null,
        children)
    }

    const COMMUNITY_ZONE = 'Asia/Shanghai'
    const gameCaptcha = (code) => code === 'CAPTCHA' || code === 'CAPTCHA_REQUIRED'

    function scopeTime(at, zone, includeTime = false) {
      if (!Number.isFinite(at) || !Number.isFinite(new Date(at).getTime())) return null
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
        ...(includeTime && { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }),
      }).formatToParts(new Date(at))
      const pick = (type) => parts.find((part) => part.type === type)?.value
      const day = [pick('year'), pick('month'), pick('day')].join('-')
      return includeTime ? `${day} ${[pick('hour'), pick('minute'), pick('second')].join(':')}` : day
    }

    function recordTime(record, zone, day, t) {
      // Compare the record's own business day, never infer shared run membership.
      try {
        const when = scopeTime(record.at, zone, true)
        const historical = (day ?? when?.slice(0, 10)) < scopeTime(Date.now(), zone)
        return `${when ?? day ?? '—'} (${zone})${historical ? ` · ${t('recordHistorical')}` : ''}`
      } catch { return formatTime(record.at) }
    }

    function isCurrentCoinSnapshot(balance, balanceError) {
      return balance?.day === scopeTime(Date.now(), COMMUNITY_ZONE) && !balanceError
    }

    function CommunityResults({ t, community = {} }) {
      const { lastResult, lastError, uncertainAttempt, balance, balanceError } = community
      const balanceText = Number.isFinite(balance?.totalPoints)
        ? `${t('communityBalance')}：${balance.totalPoints}${isCurrentCoinSnapshot(balance, balanceError) ? '' : ` · ${t('communityHistorical')}`}`
        : null
      const item = lastResult?.results?.[0]
      const captcha = lastError?.code === 'captcha' || item?.outcome === 'captcha'
      const unknown = Boolean(uncertainAttempt) || lastError?.code === 'unknown' || item?.outcome === 'unknown'
      const outcome = item?.outcome ?? (captcha ? 'captcha' : unknown ? 'unknown'
        : lastError?.code || (lastResult ? lastResult.ok ? 'success' : 'error' : 'none'))
      const outcomes = {
        success: 'communityOutcomeSuccess', 'cached-success': 'communityOutcomeCached', captcha: 'communityOutcomeCaptcha',
        unknown: 'communityOutcomeUnknown', 'auth-unavailable': 'communityOutcomeAuth', expired: 'communityOutcomeExpired',
        error: 'communityOutcomeError', skipped: 'communityOutcomeSkipped', none: 'communityNoResult',
      }
      const accepted = outcome === 'success' || outcome === 'cached-success'
      const diagnostic = lastError && !['captcha', 'unknown'].includes(lastError.code) ? lastError.message : null
      const note = accepted ? t('communityAccepted') : !captcha && !unknown ? diagnostic || item?.message : null
      const record = (item ? lastResult : null)
        ?? (outcome === lastError?.code && Number.isFinite(lastError.at) ? lastError : null)
        ?? (outcome === 'unknown' && Number.isFinite(uncertainAttempt?.at) ? uncertainAttempt : null)
        ?? lastResult
      return h('tr', null,
        h('th', { scope: 'row' }, t('communityItem'), record
          ? h('small', { className: 'mys-game-meta' }, recordTime(record, COMMUNITY_ZONE, record.day, t)) : null),
        h('td', null, h('span', { className: 'mys-status', 'data-outcome': outcome }, t(outcomes[outcome] ?? 'communityOutcomeError'))),
        h('td', null,
          captcha ? h('div', { className: 'mys-status', 'data-outcome': 'captcha', role: 'status' }, t(accepted ? 'communityBalanceRisk' : 'communityRisk')) : null,
          unknown ? h('div', { className: 'mys-status', 'data-outcome': 'unknown', role: 'status' }, t('communityUnknown')) : null,
          balanceText ? h('div', null, balanceText) : null,
          note ? h('div', null, note) : (balanceText || captcha || unknown ? null : '—')))
    }

    function CoinSnapshot({ t, balance, balanceError }) {
      const current = isCurrentCoinSnapshot(balance, balanceError)
      const number = (value) => typeof value === 'number' && Number.isFinite(value) ? String(value) : '—'
      return h('section', { className: 'mys-log-snapshot', 'aria-labelledby': 'mys-coin-heading' },
        h('div', { className: 'mys-record-head' },
          h('h4', { id: 'mys-coin-heading' }, t('coinHeading')),
          h('span', { className: 'mys-record-meta' }, balance
            ? `${t('communityBalance')}：${number(balance.totalPoints)} · ${t(current ? 'communityCurrent' : 'communityHistorical')}`
            : t('communityNoBalance'))),
        balanceError ? h('div', { role: 'status', className: 'mys-hint' }, t('communityBalanceFail'), ' ', balanceError.message) : null,
        balance ? h('div', { className: 'mys-meta' },
          h('div', null, t('communityReceived'), '：', number(balance.todayReceived), ' · ', t('communityRemaining'), '：', number(balance.todayRemaining)),
          h('div', null, t('communitySnapshotAt'), '：', recordTime(balance, COMMUNITY_ZONE, balance.day, t))) : null)
    }

    const validRevision = (value) => typeof value === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
    const compatible = (data) => data?.ok === true && data.checkinProtocol === 1
      && validRevision(data.configRevision) && validRevision(data.accountRevision)
      && data.config && typeof data.config === 'object' && !Array.isArray(data.config)

    /** The base of a dirty draft moves only with this queue's own successful saves. */
    function createConfigSaveQueue({ save, changed, initial = null }) {
      let confirmed = initial
      let revision = 0, pending = false, failed = null, queued = null, draining = null
      const view = () => ({ pending, failed, confirmed })
      const markEdited = () => {
        revision++
        pending = true
        failed = null
        changed()
        return revision
      }
      const observe = (snapshot) => {
        if (!pending) confirmed = snapshot
      }
      const acceptSaved = () => {
        failed = null
        changed()
      }
      const drain = async () => {
        while (queued !== null) {
          const job = queued
          queued = null
          if (job.revision !== revision) continue
          try {
            confirmed = await save(job.next, confirmed?.configRevision)
            if (job.revision === revision) pending = false
            changed()
          } catch (failure) {
            // Neither the failed full draft nor newer snapshots derived from it
            // may be replayed after observing another panel's settings.
            revision++
            queued = null
            pending = false
            failed = failure?.code === 'config-conflict' ? 'saveConflict' : 'saveFail'
            await changed()
          }
        }
        draining = null
      }
      const submit = (next, edited = markEdited()) => {
        if (edited !== revision) return draining
        queued = { next, revision: edited }
        draining ??= Promise.resolve().then(drain)
        return draining
      }
      return { markEdited, submit, observe, acceptSaved, view }
    }

    function postJson(path, body) {
      return callJson(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    }

    // Own the status/selection used by both rendering and the click callback.
    function createCheckinPanel({ initialStatus = null, changed }) {
      let status = initialStatus, draft = compatible(status) ? status.config : null, error = null
      let running = false, runIssue = null, needsRefresh = false, readVersion = 0, timer = null
      const canEdit = () => compatible(status) && error === null && !needsRefresh && draft !== null
      const saves = createConfigSaveQueue({
        initial: compatible(status) ? status : null,
        async save(config, configRevision) {
          if (!canEdit()) throw new Error('Host unavailable')
          const data = await postJson('config/checkin', { config, configRevision })
          if (data?.ok !== true || !compatible(data.status) || data.status.configRevision === configRevision) throw new Error('Invalid check-in configuration response')
          // Invalidate any older status read still in flight.
          readVersion++
          status = data.status
          error = null
          return data.status
        },
        changed() {
          const { pending, failed, confirmed } = saves.view()
          if (failed) {
            clearTimeout(timer)
            draft = null
            needsRefresh = true
            changed()
            return refresh()
          }
          if (!pending) draft = confirmed?.config ?? null
          changed()
        },
      })
      async function refresh() {
        const version = ++readVersion
        try {
          const data = await callJson('status')
          if (version !== readVersion) return
          status = data
          error = null
          needsRefresh = false
          saves.observe(compatible(data) ? data : null)
          if (!saves.view().pending) draft = compatible(data) ? data.config : null
        } catch (failure) {
          if (version !== readVersion) return
          error = String(failure?.message ?? failure)
        }
        changed()
      }
      function patchDraft(mutate) {
        if (!canEdit()) return
        draft = mutate(structuredClone(draft))
        const edited = saves.markEdited()
        const next = draft
        clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          return saves.submit(next, edited)
        }, 650)
      }
      function selection() {
        const { pending, failed, confirmed } = saves.view()
        const targets = {
          gameIds: Object.entries(confirmed?.config.games ?? {}).filter(([, enabled]) => enabled === true).map(([id]) => id),
          dabieye: confirmed?.config.community?.enabled === true,
          accountRevision: confirmed?.accountRevision,
        }
        const blocked = error !== null ? 'runOffline'
          : status !== null && !compatible(status) ? 'incompatibleHost'
            : running || status?.running === true ? 'runBusy'
              : pending ? 'saving'
                : failed ? failed
                  : confirmed === null || needsRefresh ? 'runLoading'
                    : !targets.gameIds.length && !targets.dabieye ? 'noTargets'
                      : !status?.login || status.login.state === 'anonymous' ? 'runLogin' : null
        return { targets, blocked }
      }
      async function runNow(renderedTargets) {
        const { targets, blocked } = selection()
        if (blocked !== null) return
        // A poll can update the controller before React renders the new view.
        // Both targets and account must be the ones the button displayed.
        if (renderedTargets.accountRevision !== targets.accountRevision
          || renderedTargets.dabieye !== targets.dabieye
          || renderedTargets.gameIds.length !== targets.gameIds.length
          || !renderedTargets.gameIds.every((id) => targets.gameIds.includes(id))) {
          runIssue = renderedTargets.accountRevision !== targets.accountRevision ? 'accountChanged' : 'staleTargets'
          changed()
          return
        }
        running = true
        runIssue = null
        changed()
        try {
          const response = await postJson('run/checkin', targets)
          if (response?.ok !== true || response.started !== true) throw new Error('Check-in start was not confirmed')
        } catch (failure) {
          if (['targets-changed', 'account-changed'].includes(failure?.code)) {
            needsRefresh = true
            runIssue = failure.code === 'account-changed' ? 'accountChanged' : 'targetsChanged'
          } else {
            runIssue = 'runFailed'
          }
          changed()
        } finally {
          await refresh()
          running = false
          changed()
        }
      }
      return {
        patchDraft, refresh, runNow,
        acceptSaved: () => { if (canEdit()) saves.acceptSaved() },
        cancelDebounce: () => clearTimeout(timer),
        view: () => {
          const { targets, blocked } = selection()
          const { pending, failed } = saves.view()
          return { status, error, draft: canEdit() ? draft : null, canEdit: canEdit(), runIssue, targets, runBlocked: blocked, saveFeedback: failed ?? (pending ? 'saving' : null) }
        },
      }
    }

    function useCheckinPanel(initialStatus) {
      const [, render] = useState(0)
      const [panel] = useState(() => createCheckinPanel({ initialStatus, changed: () => render((revision) => revision + 1) }))
      useEffect(() => {
        let stopped = false, timer
        async function tick() {
          await panel.refresh()
          if (!stopped) timer = setTimeout(tick, panel.view().status?.running ? 1500 : 4000)
        }
        void tick()
        return () => {
          stopped = true
          clearTimeout(timer)
          panel.cancelDebounce()
        }
      }, [panel])
      return panel
    }

    const sendDiagKey = 'mys-checkin:last-sms-diagnostic:v1'
    const sendCodes = new Set(['bad-phone', 'bad-request', 'flow-changed', 'flow-expired', 'flow-busy', 'flow-state', 'sms-cooldown',
      'invalid-response', 'invalid-challenge', 'invalid-proof', 'challenge-failed', 'challenge-expired', 'challenge-stale', 'challenge-limit',
      'outcome-unknown', 'network-error', 'upstream-rejected', 'rate-limited', 'login-failed', 'session-changed'])
    const challengeFields = new Set(['header', 'data', 'session_id', 'mmt_type', 'use_v4', 'gt', 'challenge', 'new_captcha', 'success', 'risk_type'])
    let lastSendDiagnostic = null
    // Always reconstruct a small record: neither responses nor free-form exceptions enter storage or the UI.
    function safeSendDiagnostic(d) {
      if (!d || !['start', 'send'].includes(d.step) || !['notSent', 'confirmed', 'challenge', 'rejected', 'unknown'].includes(d.result) ||
          !Number.isSafeInteger(d.at) || d.at < 0 || d.at > 8640000000000000) return null
      return { at: d.at, step: d.step, result: d.result, code: sendCodes.has(d.code) ? d.code : null,
        ...(d.step === 'send' && d.code === 'invalid-challenge' && challengeFields.has(d.challengeField) ? { challengeField: d.challengeField } : {}),
        retcode: Number.isInteger(d.retcode) && Math.abs(d.retcode) <= 2147483647 ? d.retcode : null, pollFailed: d.pollFailed === true }
    }
    function readSendDiagnostic() {
      if (lastSendDiagnostic) return lastSendDiagnostic
      try {
        const raw = window.localStorage.getItem(sendDiagKey)
        if (raw && raw.length <= 512) lastSendDiagnostic = safeSendDiagnostic(JSON.parse(raw))
      } catch { /* unavailable desktop storage: keep this session's diagnostic in memory */ }
      return lastSendDiagnostic
    }

    /** Memory-only callbacks, shared by the account and community login CTAs. */
    function createSmsController({ request, changed, confirmed, onDiagnostic = () => {}, now = Date.now }) {
      let state = null, generation = 0, revision = 0, locked = false
      let diagnostic = null
      const record = (step, result, code, details, pollFailed = false) => {
        diagnostic = lastSendDiagnostic = safeSendDiagnostic({ at: now(), step, result, code, retcode: details?.retcode, challengeField: details?.challengeField, pollFailed })
        try { window.localStorage.setItem(sendDiagKey, JSON.stringify(diagnostic)) } catch { /* optional persistence */ }
        onDiagnostic(diagnostic)
      }
      const publish = () => changed(state && { ...state })
      const cancelId = (flowId) => { if (flowId) void request('login/cancel', { flowId }).catch(() => {}) }
      const errorKey = (code) => ({ 'sms-code-invalid': 'smsWrongCode', 'sms-cooldown': 'smsCooldown', 'flow-expired': 'smsExpired', 'flow-changed': 'smsExpired', 'rate-limited': 'smsRateLimited', 'challenge-expired': 'smsExpired', 'official-action-required': 'smsOfficialAction', 'game-validation-failed': 'smsGameValidation', 'community-validation-failed': 'smsCommunityValidation', 'outcome-unknown': 'smsOutcomeUnknown', 'upstream-rejected': 'smsRejected', 'invalid-response': 'smsInvalidResponse', 'network-error': 'smsNetwork' })[code] ?? 'smsFailed'
      const sendRejected = code => ['upstream-rejected', 'rate-limited', 'sms-cooldown'].includes(code)
      const setError = (key, diagnostic) => {
        state.error = key
        state.stage = key && ['sms', 'login', 'ltoken', 'cookie'].includes(diagnostic?.stage) ? diagnostic.stage : null
        state.retcode = key && Number.isInteger(diagnostic?.retcode) && Math.abs(diagnostic.retcode) <= 2147483647 ? diagnostic.retcode : null
      }
      const accept = (data) => {
        if (data.state === 'confirmed' && data.ok === true) {
          generation++; revision++; locked = false; state = null; publish(); confirmed(data); return
        }
        if (data.flow && state.flow && data.flow.flowId !== state.flow.flowId) {
          state.challenge = null; setError('smsExpired'); return
        }
        if (Object.hasOwn(data, 'flow')) state.flow = data.flow
        if (data.ok === false && (data.flow === null || ['official-action-required', 'game-validation-failed', 'community-validation-failed'].includes(data.error?.code))) state.fatal = true
        state.challenge = data.challenge ?? (state.challenge?.challengeId === data.flow?.challenge?.challengeId ? state.challenge : null)
        setError(data.ok === false ? errorKey(data.error?.code) : null, data.diagnostic)
      }
      const perform = async (path, payload) => {
        if (!state || locked || state.fatal) return
        const sending = path === 'login/send' || (path === 'login/challenge' && state.flow?.challenge?.checkpoint === 'sms')
        locked = true; state.busy = true; setError(null)
        const gen = generation
        revision++; publish()
        try {
          if (path === 'login/send' && !state.flow) {
            record('start', 'notSent')
            const start = await request('login/start', { phone: state.phone })
            if (generation !== gen) { cancelId(start.flow?.flowId); return }
            state.phone = ''
            accept(start)
            if (!start.ok || !state.flow) { record('start', 'notSent', start.error?.code, start.diagnostic); return }
            payload = { flowId: state.flow.flowId }
          }
          if (sending) {
            record('send', 'unknown')
            state.sendHint = 'smsSendPending'
            state.previousResendAt = path === 'login/send' ? state.flow?.resendAt ?? 0 : null
            publish()
          }
          const data = await request(path, payload)
          if (generation !== gen) return
          state.code = ''
          accept(data)
          if (sending && state) {
            state.sendHint = data.ok === true && data.flow?.status === 'code-sent' ? 'smsCodeSent'
              : data.ok === true && data.flow?.challenge?.checkpoint === 'sms' ? (state.challenge ? 'smsSendChallenge' : 'smsSendChallengeUnavailable')
              : sendRejected(data.error?.code) ? 'smsSendRejected' : 'smsSendUnknown'
            const result = state.sendHint === 'smsCodeSent' ? 'confirmed' : state.sendHint === 'smsSendRejected' ? 'rejected'
              : state.sendHint.startsWith('smsSendChallenge') ? 'challenge' : 'unknown'
            record('send', result, data.error?.code, data.diagnostic)
          }
        } catch { if (generation === gen && state) {
          state.code = ''; setError('smsFailed')
          if (sending && state.sendHint === 'smsSendPending') state.sendHint = 'smsSendUnknown'
        } }
        finally { if (generation === gen && state) { locked = false; state.busy = false; revision++; publish() } }
      }
      const cancel = () => {
        const id = state?.flow?.flowId
        generation++; revision++; locked = false; state = null; publish(); cancelId(id)
      }
      return {
        open() { if (state) return; diagnostic = null; generation++; state = { phone: '', code: '', flow: null, challenge: null, busy: false, error: null }; publish() },
        setPhone(value) { if (state && !locked && !state.flow) { state.phone = value; publish() } },
        setCode(value) { if (state && !locked) { state.code = value; publish() } },
        send() {
          if (!state || locked) return
          if (!state.flow && !/^1[3-9]\d{9}$/.test(state.phone)) { setError('smsBadPhone'); publish(); return }
          if (state.flow?.resendAt > now()) return
          return perform('login/send', state.flow ? { flowId: state.flow.flowId } : undefined)
        },
        submit() {
          if (!state || locked) return
          if (!state.flow || !/^\d{6}$/.test(state.code)) { setError('smsBadCode'); publish(); return }
          diagnostic = null // Later login/credential errors do not describe the SMS send.
          return perform('login/submit', { flowId: state.flow.flowId, code: state.code })
        },
        solve(challengeId, result) {
          if (!state || locked || !state.challenge || state.challenge.challengeId !== challengeId || state.challenge.expiresAt <= now()) return
          state.challenge = null
          return perform('login/challenge', { flowId: state.flow.flowId, challengeId, result })
        },
        widgetError(reason) { if (state) { revision++; state.challenge = null; state.code = ''; setError(reason === 'open-failed' ? 'smsWidgetOpenFailed' : 'smsWidgetFailed'); state.fatal = true; publish() } },
        async readState() {
          if (!state?.flow || locked || state.fatal) return
          const id = state.flow.flowId, gen = generation, rev = revision
          try {
            const data = await request('login/state')
            if (gen !== generation || rev !== revision || !state) return
            if (!data.flow || data.flow.flowId !== id) { state.challenge = null; setError('smsExpired'); state.flow = { ...state.flow, status: 'expired' } }
            else {
              state.flow = data.flow
              if (state.challenge?.challengeId !== data.flow.challenge?.challengeId) state.challenge = null
              if (data.flow.status === 'expired') setError('smsExpired')
              else if (state.sendHint === 'smsSendUnknown' && data.flow.status === 'code-sent' && !data.flow.error &&
                (state.previousResendAt === null || data.flow.resendAt > state.previousResendAt)) {
                state.sendHint = 'smsCodeSent'; setError(null)
                record('send', 'confirmed')
              } else if (state.sendHint === 'smsSendUnknown' && data.flow.status === 'phone-ready' && sendRejected(data.flow.error?.code) &&
                (state.previousResendAt === null || data.flow.resendAt > state.previousResendAt)) {
                state.sendHint = 'smsSendRejected'; setError(errorKey(data.flow.error.code), data.flow.error.diagnostic)
                record('send', 'rejected', data.flow.error.code, data.flow.error.diagnostic)
              } else if (data.flow.status === 'verification-required' && data.flow.challenge?.checkpoint === 'sms') {
                state.sendHint = state.challenge ? 'smsSendChallenge' : 'smsSendChallengeUnavailable'
                if (diagnostic && diagnostic.result !== 'challenge') record('send', 'challenge')
              }
            }
            publish()
          } catch { if (gen === generation && rev === revision && state) {
            if (diagnostic && !diagnostic.pollFailed) record(diagnostic.step, diagnostic.result, diagnostic.code, diagnostic, true)
            setError('smsFailed'); publish()
          } }
        },
        cancel, dispose: cancel,
      }
    }

    function createCaptchaBridge({ getWindow, nonce, challenge, onResult, onError, onReady = () => {}, onPhase = () => {}, now = Date.now,
      arm = (fn, ms) => setTimeout(fn, ms), disarm = timer => clearTimeout(timer) }) {
      let done = false, phase = 'loading', timer = null
      const clearOpen = () => { if (timer !== null) disarm(timer); timer = null }
      const fail = () => { if (!done) { done = true; clearOpen(); onError(phase === 'opening' ? 'open-failed' : 'widget-failed') } }
      const send = (data) => getWindow()?.postMessage({ ...data, nonce }, '*')
      return {
        load() {
          if (done) return
          if (now() >= challenge.expiresAt) { fail(); return }
          const config = {}
          for (const key of ['captchaId', 'challenge', 'newCaptcha', 'offline', 'riskType', 'userInfo', 'language']) {
            if (Object.hasOwn(challenge.config, key)) config[key] = challenge.config[key]
          }
          send({ type: 'mys-captcha:init', version: challenge.version, config })
        },
        open() {
          if (done || phase !== 'ready') return
          if (now() >= challenge.expiresAt) { fail(); return }
          phase = 'opening'; onPhase(phase)
          timer = arm(fail, Math.min(12000, challenge.expiresAt - now()))
          try { send({ type: 'mys-captcha:open' }) } catch { fail() }
        },
        receive(event) {
          if (done || now() >= challenge.expiresAt || event.source !== getWindow()) return
          const data = event.data
          if (!data || data.nonce !== nonce) return
          if (data.type === 'mys-captcha:ready' && phase === 'loading') { phase = 'ready'; onReady(); onPhase(phase); return }
          if (data.type === 'mys-captcha:opened' && phase === 'opening') { clearOpen(); phase = 'opened'; onPhase(phase); return }
          if (data.type === 'mys-captcha:error') { fail(); return }

          if (data.type !== 'mys-captcha:success' || !['opening', 'opened'].includes(phase)) return
          const fields = challenge.version === 'gt4' ? ['captcha_id', 'lot_number', 'pass_token', 'gen_time', 'captcha_output'] : ['geetest_challenge', 'geetest_validate', 'geetest_seccode']
          const raw = data.result, result = {}
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
          for (const field of fields) {
            const value = raw[field]
            if (typeof value !== 'string' || !/^[A-Za-z0-9_~+/.=|:-]{1,8192}$/.test(value)) return
            result[field] = value
          }
          if (JSON.stringify(result).length > 12288) return
          done = true; clearOpen(); onResult(challenge.challengeId, result)
        },
        dispose() { done = true; clearOpen(); send({ type: 'mys-captcha:destroy' }) },
      }
    }

    function CaptchaFrame({ t, challenge, onResult, onError }) {
      const frame = useRef(null), bridge = useRef(null)
      const [html, setHtml] = useState(null), [phase, setPhase] = useState('loading')
      const callbacks = useRef({ onResult, onError }); callbacks.current = { onResult, onError }
      useEffect(() => {
        let stopped = false, timeout
        const current = createCaptchaBridge({ getWindow: () => frame.current?.contentWindow, nonce: crypto.randomUUID(), challenge,
          onResult: (...args) => callbacks.current.onResult(...args), onReady: () => clearTimeout(timeout), onPhase: setPhase, onError: reason => { clearTimeout(timeout); callbacks.current.onError(reason) } })
        bridge.current = current
        window.addEventListener('message', current.receive)
        // Fetch through the authenticated owner carrier. Desktop uses IPC fetch,
        // so an iframe navigation to apiUrl() would not reach the Host there.
        void (async () => {
          try {
            const response = await fetch(apiUrl('login/captcha-frame'), { credentials: 'include', cache: 'no-store' })
            if (!response.ok || !response.headers.get('content-type')?.startsWith('text/html')) throw new Error()
            const text = await response.text()
            if (text.length > 32768) throw new Error()
            if (!stopped) setHtml(text)
          } catch { if (!stopped) callbacks.current.onError() }
        })()
        timeout = setTimeout(() => { if (!stopped) callbacks.current.onError() }, Math.min(30000, Math.max(0, challenge.expiresAt - Date.now())))
        const expiry = setTimeout(() => { if (!stopped) callbacks.current.onError() }, Math.max(0, challenge.expiresAt - Date.now()))
        return () => { stopped = true; clearTimeout(expiry); clearTimeout(timeout); current.dispose(); window.removeEventListener('message', current.receive); bridge.current = null }
      }, [challenge.challengeId])
      return h('div', null,
        phase === 'ready' ? h('button', { type: 'button', className: 'mys-captcha-start', onClick: () => bridge.current?.open() }, t('smsWidgetStart'))
          : phase !== 'opened' ? h('div', { role: 'status', className: 'mys-hint' }, t(phase === 'opening' ? 'smsWidgetOpening' : 'smsWidgetLoading')) : null,
        html !== null ? h('div', { className: 'mys-captcha-viewport', 'data-active': ['opening', 'opened'].includes(phase) }, h('iframe', {
          ref: frame, title: t('smsVerification'), sandbox: 'allow-scripts', referrerPolicy: 'no-referrer', srcDoc: html,
          tabIndex: phase === 'opened' ? 0 : -1, className: 'mys-captcha-frame', onLoad: () => bridge.current?.load(), onError,
        })) : null)
    }

    function useMysLogin({ t, refresh, onNotice }) {
      const [session, setSession] = useState(null)
      const [sendDiagnostic, onDiagnostic] = useState(readSendDiagnostic)
      const refs = useRef({ refresh, onNotice, t }); refs.current = { refresh, onNotice, t }
      const controller = useRef(null)
      if (!controller.current) controller.current = createSmsController({
        request: (path, body) => requestJson(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        changed: setSession, onDiagnostic,
        confirmed: (data) => { refs.current.onNotice?.(refs.current.t(data.warning ? 'smsSuccessWarning' : 'smsSuccess')); void refs.current.refresh?.() },
      })
      useEffect(() => () => controller.current.dispose(), [])
      useEffect(() => {
        if (!session?.flow) return undefined
        const timer = setInterval(() => { void controller.current.readState() }, 2000)
        return () => clearInterval(timer)
      }, [session?.flow?.flowId])
      return { session, sendDiagnostic, busy: session?.busy === true, controller: controller.current, startLogin: () => controller.current.open(), cancelLogin: () => controller.current.cancel() }
    }

    function SendDiagnostic({ t, value }) {
      return h('div', { className: 'mys-meta' }, h('strong', null, t('sendDiag')), h('div', null, value ? [formatTime(value.at),
        t(`diag_${value.step}`), t(`diag_${value.result}`), value.code, value.retcode !== null ? `retcode: ${value.retcode}` : null,
        value.challengeField ? `challengeField: ${value.challengeField}` : null, value.pollFailed ? t('diagPoll') : null].filter(Boolean).join(' · ') : t('sendDiagEmpty')))
    }

    function SmsDialog({ t, session, controller }) {
      const [now, setNow] = useState(Date.now)
      const dialog = useRef(null)
      const close = useRef(controller.cancel); close.current = controller.cancel
      useEffect(() => {
        const previous = document.activeElement
        const root = dialog.current
        root?.querySelector('input:not(:disabled),button:not(:disabled):not([hidden])')?.focus()
        // Focus events leaving an iframe reach the parent document. A document
        // guard also covers controls that become disabled during a request;
        // aria-modal and a bubbling keydown trap alone cannot contain those.
        const containFocus = event => { if (root && !root.contains(event.target)) root.focus() }
        document.addEventListener('focusin', containFocus, true)
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => { document.removeEventListener('focusin', containFocus, true); clearInterval(timer); previous?.focus?.() }
      }, [])
      const flow = session.flow
      const seconds = Math.max(0, Math.ceil(((flow?.resendAt ?? 0) - now) / 1000))
      const terminal = session.fatal || (flow && (['error', 'expired', 'candidate-ready'].includes(flow.status) || flow.expiresAt <= now))
      const disabled = session.busy || flow?.busy || terminal || !!session.challenge
      const codeReady = flow?.status === 'code-sent'
      const sendHint = session.sendHint || (codeReady ? 'smsCodeSent' : null)
      const sendStatus = sendHint === 'smsSendUnknown' || sendHint === 'smsSendRejected' ? sendHint
        : terminal ? (session.error ? null : 'smsExpired')
        : session.busy && sendHint !== 'smsSendPending' ? 'smsBusy' : sendHint
      useEffect(() => {
        const root = dialog.current
        if (!root) return
        const active = document.activeElement
        if (!root.contains(active) || active?.disabled) root.focus()
        if (!disabled && codeReady && document.activeElement === root) root.querySelector('input[autocomplete="one-time-code"]:not(:disabled)')?.focus()
      }, [disabled, codeReady, session.error, !!flow])
      const onSubmit = (event) => { event.preventDefault(); if (!disabled) void (codeReady ? controller.submit() : controller.send()) }
      return h('div', { className: 'mys-overlay', role: 'presentation', onClick: event => { if (event.target === event.currentTarget) controller.cancel() } },
        h('div', { className: 'mys-dialog', ref: dialog, role: 'dialog', tabIndex: -1, 'aria-modal': true, 'aria-label': t('smsTitle'), 'aria-busy': session.busy,
          onKeyDown: event => {
            if (event.key === 'Escape') { event.preventDefault(); close.current(); return }
            if (event.key !== 'Tab') return
            const items = [...(dialog.current?.querySelectorAll('input:not(:disabled),button:not(:disabled):not([hidden]),iframe') ?? [])]
            const first = items[0], last = items.at(-1)
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
          } },
          h('h3', { className: 'mys-dialog-title' }, t('smsTitle')),
          h('div', { className: 'mys-hint' }, t('smsHint')),
          h('form', { onSubmit },
            h('label', { className: 'mys-field' }, t('smsPhone'), h('input', { className: 'mys-input', type: 'tel', inputMode: 'tel', autoComplete: 'tel-national', maxLength: 11,
              value: flow ? flow.phoneMasked : session.phone, disabled: !!flow || session.busy, onChange: event => controller.setPhone(event.target.value) })),
            flow ? h('label', { className: 'mys-field' }, t('smsCode'), h('input', { className: 'mys-input', type: 'text', inputMode: 'numeric', autoComplete: 'one-time-code', maxLength: 6, value: session.code,
              disabled: !codeReady || disabled, onChange: event => controller.setCode(event.target.value) })) : null,
            session.error ? h('div', { className: 'mys-banner', role: 'alert', 'data-tone': 'warn' }, t(session.error),
              session.stage ? h('div', null, `${t('smsStage')}: ${t(`smsStage_${session.stage}`)} (${session.stage})`) : null,
              session.retcode != null ? h('div', null, `${t('smsRetcode')} (retcode): ${session.retcode}`) : null) : null,
            h('div', { role: 'status', 'aria-live': 'polite', className: 'mys-hint' }, sendStatus ? t(sendStatus) : ''),
            seconds > 0 ? h('div', { className: 'mys-hint', 'aria-live': 'off' }, fill(t('smsCountdown'), { seconds })) : null,
            session.challenge ? h(CaptchaFrame, { key: session.challenge.challengeId, t, challenge: session.challenge, onResult: controller.solve, onError: controller.widgetError }) : null,
            h('div', { className: 'mys-dialog-foot' },
              h(Button, { type: 'button', variant: 'primary', disabled: !!disabled || (!codeReady && seconds > 0), onClick: () => { if (!disabled) void (codeReady ? controller.submit() : controller.send()) } }, t(codeReady ? 'smsSubmit' : 'smsSend')),
              flow ? h(Button, { type: 'button', disabled: !!disabled || seconds > 0, onClick: () => { void controller.send() } }, t('smsResend')) : null,
              h(Button, { type: 'button', onClick: controller.cancel }, t('smsCancel'))),
            // Native form submission supports Enter without giving custom Button
            // wrappers an implicit second submission path.
            h('button', { type: 'submit', hidden: true, disabled: !!disabled, tabIndex: -1, 'aria-hidden': true }))))
    }

    const BADGE_DISMISS_KEY = 'dsh.mys-checkin.dismissed-at'

    /** Frame-wide status pill: shows when the last run failed, until dismissed. */
    function OverlayBadge({ t }) {
      const [lastError, setLastError] = useState(null)
      const [dismissed, setDismissed] = useState(() => {
        try {
          return window.localStorage.getItem(BADGE_DISMISS_KEY)
        } catch {
          return null
        }
      })

      useEffect(() => {
        let stopped = false
        let timer
        const tick = async () => {
          try {
            const body = await requestJson('status')
            if (!stopped) setLastError(body?.lastError ?? null)
          } catch {
            if (!stopped) setLastError(null)
          }
          if (!stopped) timer = setTimeout(tick, 60000)
        }
        timer = setTimeout(tick, 4000)
        return () => {
          stopped = true
          clearTimeout(timer)
        }
      }, [])

      if (lastError === null || lastError === undefined) return null
      const at = String(lastError.at ?? '')
      if (dismissed === at) return null
      const captcha = gameCaptcha(lastError.code)
      const text = lastError.code === 'LOGIN_EXPIRED'
        ? t('badgeExpired')
        : captcha
          ? t('badgeCaptcha')
          : t('badgeRun')
      return h('div', { className: 'mys-badge', 'data-tone': captcha ? 'warn' : 'error', role: 'status', title: t('badgeOpen') },
        h('span', { className: 'mys-badge-text' }, text),
        h('button', {
          type: 'button',
          className: 'mys-badge-close',
          'aria-label': t('badgeDismiss'),
          onClick: () => {
            setDismissed(at)
            try {
              window.localStorage.setItem(BADGE_DISMISS_KEY, at)
            } catch {
              /* private mode */
            }
          },
        }, '×'))
    }

    function revealDisclosure(ref) {
      const details = ref.current
      if (!details) return
      details.open = true
      details.firstElementChild?.focus()
    }

    function Section({ t, __status }) {
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState({ verify: false, refresh: false })
      const [verifyInfo, setVerifyInfo] = useState(null)
      const [deleteArmed, setDeleteArmed] = useState(false)
      const settingsRef = useRef(null)
      const accountRef = useRef(null)
      const panel = useCheckinPanel(__status)
      const { status, error, draft, runIssue, targets, runBlocked, canEdit, saveFeedback } = panel.view()
      const { refresh, patchDraft, runNow } = panel
      const loginFlow = useMysLogin({ t, refresh, onNotice: setNotice })

      useEffect(() => {
        if (notice === null) return undefined
        const timer = setTimeout(() => setNotice(null), 2600)
        return () => clearTimeout(timer)
      }, [notice])

      // A stray click on "delete" must not wipe the session: disarm after 6 s.
      useEffect(() => {
        if (!deleteArmed) return undefined
        const timer = setTimeout(() => setDeleteArmed(false), 6000)
        return () => clearTimeout(timer)
      }, [deleteArmed])

      const logout = useCallback(async () => {
        try {
          await callJson('logout', { method: 'POST', body: '{}' })
          setVerifyInfo(null)
          setNotice(t('loginDeleted'))
          void refresh()
        } catch (failure) {
          setNotice(fill(t('saveFailed'), { message: String(failure?.message ?? failure) }))
        }
      }, [refresh, t])

      const deleteLogin = useCallback(() => {
        if (!deleteArmed) {
          setDeleteArmed(true)
          return
        }
        setDeleteArmed(false)
        void logout()
      }, [deleteArmed, logout])

      const refreshCredentials = useCallback(async () => {
        setBusy((current) => ({ ...current, refresh: true }))
        try {
          await callJson('refresh', { method: 'POST', body: '{}' })
          setNotice(t('saveOk'))
          void refresh()
        } catch (failure) {
          setNotice(fill(t('saveFailed'), { message: String(failure?.message ?? failure) }))
        } finally {
          setBusy((current) => ({ ...current, refresh: false }))
        }
      }, [refresh, t])

      const verify = useCallback(async () => {
        setBusy((current) => ({ ...current, verify: true }))
        try {
          const data = await callJson('verify', { method: 'POST', body: '{}' })
          setVerifyInfo(data)
        } catch (failure) {
          setVerifyInfo({ reachable: false, message: String(failure?.message ?? failure) })
        } finally {
          setBusy((current) => ({ ...current, verify: false }))
        }
      }, [t])

      const config = draft
      const games = status?.games ?? []
      const gameZone = status?.timezone ?? status?.config?.timezone ?? COMMUNITY_ZONE
      const lastResult = status?.lastResult ?? null
      const lastError = status?.lastError ?? null
      const gameResults = lastResult?.results ?? []
      const eligibleResults = gameResults.filter((item) => item.outcome !== 'no-role')
      const completedResults = eligibleResults.filter((item) => item.outcome === 'signed' || item.outcome === 'already').length

      if (error === 'host-missing') {
        return h('div', { className: 'mys-page' },
          h('header', { className: 'mys-page-head' },
            h('h1', { className: 'mys-page-title' }, t('taskPanelTitle'))),
          h('div', { className: 'mys-banner', 'data-tone': 'error' }, t('hostMissing')))
      }

      const banner = lastError === null ? null : (() => {
        const code = lastError.code
        if (code === 'LOGIN_EXPIRED') {
          return h('div', { className: 'mys-banner', 'data-tone': 'error' },
            h('div', null, t('bannerExpired')),
            h('div', { className: 'mys-hint' }, String(lastError.message ?? '')))
        }
        if (gameCaptcha(code)) {
          return h('div', { className: 'mys-banner', 'data-tone': 'warn' },
            h('div', null, t('bannerCaptcha')),
            h('div', { className: 'mys-hint' }, String(lastError.message ?? '')))
        }
        return h('div', { className: 'mys-banner', 'data-tone': 'warn' },
          h('div', null, t('bannerRun')),
          h('div', { className: 'mys-hint' }, String(lastError.message ?? '')))
      })()

      const login = status?.login ?? { state: 'anonymous' }
      const plan = status?.schedule ?? {}
      const targetText = plan.targetAt === null || plan.targetAt === undefined ? null : formatTarget(plan.targetAt, status?.timezone ?? 'Asia/Shanghai')
      const reasonKey = plan.reason === 'missed' ? 'reasonMissed' : plan.reason === 'inside' ? 'reasonInside' : plan.reason === 'done-today' ? 'reasonDoneToday' : plan.reason === 'passed' ? 'reasonPassed' : 'reasonWindow'

      const enabled = config?.enabled === true
      const verifyValid = verifyInfo?.reachable === true && verifyInfo?.sessionValid === true
      const windowsText = (config?.windows ?? []).map((window) => `${window.start}–${window.end}`).join('、')
      const loginLabel = t(login.state === 'active' ? 'stateActive' : login.state === 'expired' ? 'stateExpired' : 'stateAnonymous')
      const reloginNeeded = login.state === 'expired' || lastError?.code === 'LOGIN_EXPIRED'
      const needsStoken = login.state === 'active' && login.hasStoken === false
      const communityRepair = login.state !== 'anonymous' && status?.community?.capability?.available === false
      const loginAction = reloginNeeded ? 'relogin' : needsStoken ? 'upgradeLogin' : login.state === 'anonymous' ? 'login' : null
      const projectsText = config === null ? '' : [
        fill(t('gamesCount'), { count: Object.values(config.games ?? {}).filter((value) => value === true).length }),
        config?.community?.enabled === true ? t('dabieye') : null,
        windowsText || null,
      ].filter(Boolean).join(' · ')
      const scheduleText = config === null ? null
        : !enabled ? t('taskStatePaused')
          : login.state === 'anonymous' ? t('scheduleLogin')
            : reloginNeeded ? t('stateExpired')
              : targets.gameIds.length === 0 && !targets.dabieye ? t('scheduleNoTargets')
                : targetText === null ? t('scheduleUnplanned') : `${t('nextRun')} ${targetText}（${t(reasonKey)}）`
      const viewTargets = () => h(Button, { size: 'sm', 'aria-controls': 'mys-settings', onClick: () => revealDisclosure(settingsRef) }, t('showTargets'))

      return h('div', { className: 'mys-page' },
        h('header', { className: 'mys-page-head' },
          h('h1', { className: 'mys-page-title' }, t('taskPanelTitle')),
          h(Button, {
            variant: 'primary',
            disabled: runBlocked !== null,
            'aria-describedby': saveFeedback !== null ? 'mys-save-status' : runBlocked !== null ? 'mys-run-hint' : undefined,
            onClick: () => runNow(targets),
          }, runBlocked === 'runBusy' ? t('running') : t('runNow'))),

        h('div', { className: 'mys-overview' },
          h('div', { className: 'mys-account' },
            login.avatar
              ? h('img', { className: 'mys-avatar', src: login.avatar, alt: '', onError: (event) => { event.currentTarget.hidden = true } })
              : login.accountName ? h('span', { className: 'mys-avatar', 'aria-hidden': true }, login.accountName.slice(0, 1)) : null,
            login.accountName ? h('span', { className: 'mys-account-name' }, login.accountName) : null,
            status === null ? null : h('span', {
              className: 'mys-tag', 'data-tone': login.state === 'active' ? 'ok' : login.state === 'expired' ? 'error' : '',
            }, loginLabel),
            status !== null && loginAction !== null
              ? h(Button, { size: 'sm', onClick: loginFlow.startLogin, disabled: loginFlow.busy }, t(loginFlow.busy ? 'smsBusy' : loginAction)) : null),
          h('div', { className: 'mys-schedule-inline' },
            h('label', { htmlFor: 'mys-auto-switch' }, t('auto')),
            h(Switch, {
              id: 'mys-auto-switch', checked: enabled, label: t('enabled'), disabled: !canEdit,
              onChange: (value) => patchDraft((next) => { next.enabled = value; return next }),
            }),
            scheduleText === null ? null : h('span', null, scheduleText))),

        h('div', { id: 'mys-run-hint', role: 'status', className: 'mys-hint', hidden: runBlocked === null || runBlocked === saveFeedback }, runBlocked === null || runBlocked === saveFeedback ? '' : t(runBlocked)),
        runBlocked === 'noTargets' ? h('div', { className: 'mys-actions' }, viewTargets()) : null,
        h('div', { id: 'mys-save-status', role: 'status', 'aria-label': t('saveFeedback'), className: 'mys-banner', 'data-tone': saveFeedback === 'saving' ? undefined : 'warn', hidden: saveFeedback === null },
          saveFeedback === null ? '' : t(saveFeedback),
          saveFeedback !== null && saveFeedback !== 'saving' && canEdit
            ? h('div', { className: 'mys-banner-actions' }, viewTargets(), h(Button, { size: 'sm', onClick: panel.acceptSaved }, t('useSaved'))) : null),
        runIssue !== null ? h('div', { className: 'mys-banner', 'data-tone': 'warn' },
          h('div', { role: 'status' }, t(runIssue)),
          runIssue === 'targetsChanged' || runIssue === 'staleTargets' ? h('div', { className: 'mys-banner-actions' }, viewTargets())
            : runIssue === 'accountChanged' ? h('div', { className: 'mys-banner-actions' },
                h(Button, { size: 'sm', 'aria-controls': 'mys-account-details', onClick: () => revealDisclosure(accountRef) }, t('showAccount'))) : null) : null,
        error !== null ? h('div', { className: 'mys-banner', 'data-tone': 'error' }, fill(t('loadFailed'), { message: error })) : null,
        banner,
        notice !== null ? h('div', { className: 'mys-banner', 'data-tone': 'ok' }, notice) : null,

        needsStoken ? h('div', { className: 'mys-banner', 'data-tone': 'warn' }, `${t('noStoken')}${t('noStokenHint')}`) : null,
        communityRepair ? h('div', { className: 'mys-row' },
          h('div', { className: 'mys-row-desc mys-row-label' }, t(status.community.capability.reason === 'missing-mid' ? 'communityMissingMid' : 'communityNoToken')),
          loginAction === null ? h(Button, { size: 'sm', onClick: loginFlow.startLogin, disabled: loginFlow.busy }, t('relogin')) : null) : null,

        h('div', { className: 'mys-page-section' },
          h('div', { className: 'mys-record-head' },
            h('h2', { id: 'mys-results-heading' }, t('runTitle')),
            lastResult === null ? null : h('span', { className: 'mys-record-meta' },
              fill(t('runGameSummary'), { summary: [
                eligibleResults.length === 0 ? null : fill(t('gameRecordSummary'), { done: completedResults, total: eligibleResults.length }),
                recordTime(lastResult, gameZone, lastResult.date, t),
                `${t('runAuto')}：${lastResult.reason === 'schedule' ? t('yes') : t('no')}`,
              ].filter(Boolean).join(' · ') }))),
          h('table', { className: 'mys-game-table', 'aria-labelledby': 'mys-results-heading' },
            h('thead', null, h('tr', null,
              h('th', { scope: 'col' }, t('colTarget')),
              h('th', { scope: 'col' }, t('colStatus')),
              h('th', { scope: 'col' }, t('colRewardOrNote')))),
            h('tbody', null,
              gameResults.length === 0
                ? h('tr', null, h('td', { colSpan: 3, className: 'mys-empty' }, t(lastResult === null ? 'noResult' : 'outcomeSkipped')))
                : gameResults.map((item, index) => h('tr', { key: `${item.game}-${index}` },
                    h('th', { scope: 'row' }, item.label ?? item.game,
                      item.uid || typeof item.totalDays === 'number' ? h('small', { className: 'mys-game-meta' }, [
                        item.uid ? `UID ${item.uid}` : null,
                        typeof item.totalDays === 'number' ? `${t('colTotal')} ${item.totalDays}/25` : null,
                      ].filter(Boolean).join(' · ')) : null),
                    h('td', null, h('span', { className: 'mys-status', 'data-outcome': item.outcome }, t(OUTCOME_KEY[item.outcome] ?? 'outcomeError'))),
                    h('td', null, awardsText(item.awards)))),
              h(CommunityResults, { t, community: status?.community }))),
          lastResult !== null && status?.community?.lastResult ? h('div', { className: 'mys-record-meta' }, t('recordNote')) : null),

        h('details', { className: 'mys-disclosure', id: 'mys-settings', ref: settingsRef },
          h('summary', null, t('checkinSettings'), projectsText === '' ? null : h('span', { className: 'mys-meta' }, projectsText)),
          h('div', { className: 'mys-disclosure-body' },
            h(SettingsGroup, { title: t('projects'), desc: t('projectsDesc'), id: 'mys-targets' },
              h('div', { className: 'mys-list' },
                games.map((game) => h('label', { className: 'mys-row', key: game.id },
                  h('span', { className: 'mys-row-label' },
                    h('span', { className: 'mys-row-title' }, game.label),
                    h('span', { className: 'mys-row-desc' },
                      game.role == null ? t('notQueried')
                        : typeof game.role === 'object' ? `${game.role.nickname ?? ''} ${game.role.uid ?? ''} ${game.role.regionName ?? ''}`.trim()
                          : t('noRole'))),
                  h('input', {
                    type: 'checkbox',
                    checked: config?.games?.[game.id] === true,
                    disabled: config === null,
                    'aria-label': game.label,
                    onChange: (event) => patchDraft((next) => { next.games[game.id] = event.target.checked; return next }),
                  }))),
                h('label', { className: 'mys-row' },
                  h('span', { className: 'mys-row-label' },
                    h('span', { className: 'mys-row-title' }, t('dabieye')),
                    h('span', { className: 'mys-row-desc' }, t('dabieyeDesc'))),
                  h('input', {
                    type: 'checkbox',
                    checked: config?.community?.enabled === true,
                    disabled: config === null,
                    'aria-label': t('dabieye'),
                    onChange: (event) => patchDraft((next) => { next.community.enabled = event.target.checked; return next }),
                  })))),
            h(SettingsGroup, { title: t('auto'), desc: t('autoDesc') },
              h('div', { className: 'mys-row' },
                h('div', { className: 'mys-row-label' },
                  h('div', { className: 'mys-row-title' }, t('windows')),
                  h('div', { className: 'mys-row-desc' }, t('windowsDesc')))),

              h('div', { className: 'mys-list' },
                (config?.windows ?? []).map((window, index) => h('div', { className: 'mys-window', key: `w${index}` },
                  h('input', {
                    className: 'mys-time',
                    type: 'time',
                     disabled: !canEdit,
                    value: window.start,
                    'aria-label': t('windows'),
                    onChange: (event) => patchDraft((next) => {
                      const value = event.target.value
                      const startMin = clockToMinutes(value)
                      const endMin = clockToMinutes(next.windows[index].end)
                      next.windows[index].start = value
                      // Keep the window valid while the user is still typing: an end
                      // at or before the start snaps to a one-minute window.
                      if (startMin !== null && (endMin === null || endMin <= startMin)) {
                        next.windows[index].end = minutesToClock(Math.min(1439, startMin + 1))
                      }
                      return next
                    }),
                  }),
                  h('span', { className: 'mys-meta' }, '—'),
                  h('input', {
                    className: 'mys-time',
                    type: 'time',
                     disabled: !canEdit,
                    value: window.end,
                    'aria-label': t('windows'),
                    onChange: (event) => patchDraft((next) => {
                      const value = event.target.value
                      const startMin = clockToMinutes(next.windows[index].start)
                      const endMin = clockToMinutes(value)
                      next.windows[index].end = endMin !== null && startMin !== null && endMin <= startMin
                        ? minutesToClock(startMin + 1)
                        : value
                      return next
                    }),
                  }),
                  h(Button, {
                    variant: 'danger',
                    size: 'sm',
                    disabled: !canEdit || (config?.windows ?? []).length <= 1,
                    onClick: () => patchDraft((next) => {
                      if (next.windows.length > 1) next.windows.splice(index, 1)
                      return next
                    }),
                  }, t('remove'))))),

              h('div', { className: 'mys-actions' },
                h(Button, {
                  size: 'sm',
                  disabled: !canEdit || (config?.windows ?? []).length >= 4,
                  onClick: () => patchDraft((next) => {
                    if (next.windows.length >= 4) return next
                    const last = next.windows[next.windows.length - 1] ?? { start: '18:00', end: '18:30' }
                    const lastStart = clockToMinutes(last.start) ?? 1080
                    const lastEnd = clockToMinutes(last.end) ?? lastStart + 30
                    const span = Math.min(120, Math.max(1, lastEnd - lastStart))
                    // Offset the new window so it is immediately usable; duplicate
                    // times are allowed, this is only a convenience.
                    let start = lastStart + 60
                    if (start + span > 1439) start = 1439 - span
                    next.windows.push({ start: minutesToClock(start), end: minutesToClock(start + span) })
                    return next
                  }),
                }, t('addWindow'))),

              h('div', { className: 'mys-row' },
                h('div', { className: 'mys-row-label' },
                  h('div', { className: 'mys-row-title' }, t('runWhenMissed')),
                  h('div', { className: 'mys-row-desc' }, t('runWhenMissedDesc'))),
                h(Switch, {
                  checked: config?.runWhenMissed === true,
                  label: t('runWhenMissed'),
                  disabled: !canEdit,
                  onChange: (value) => patchDraft((next) => { next.runWhenMissed = value; return next }),
                }))),
            h('details', { className: 'mys-details' },
              h('summary', null, t('advanced')),
              h('div', { className: 'mys-grid' },
                h('label', { className: 'mys-field' }, t('timezone'),
                  h('input', {
                    className: 'mys-input',
                    disabled: !canEdit,
                    value: draft?.timezone ?? '',
                    onChange: (event) => patchDraft((next) => { next.timezone = event.target.value; return next }),
                  })),
                h('label', { className: 'mys-field' }, t('appVersion'),
                  h('input', {
                    className: 'mys-input',
                    disabled: !canEdit,
                    value: draft?.client?.appVersion ?? '',
                    onChange: (event) => patchDraft((next) => { next.client.appVersion = event.target.value; return next }),
                  })),
                h('label', { className: 'mys-field' }, t('salt'),
                  h('input', {
                    className: 'mys-input',
                    disabled: !canEdit,
                    value: draft?.client?.salt ?? '',
                    onChange: (event) => patchDraft((next) => { next.client.salt = event.target.value; return next }),
                  })),
                h('label', { className: 'mys-field' }, `${t('gap')} · ${t('gapMin')}`,
                  h('input', {
                    className: 'mys-input',
                    disabled: !canEdit,
                    type: 'number',
                    min: 1,
                    max: 60,
                    value: Math.round((draft?.gapMs?.min ?? 2000) / 1000),
                    onChange: (event) => patchDraft((next) => { next.gapMs.min = Math.max(1, Number(event.target.value) || 1) * 1000; return next }),
                  })),
                h('label', { className: 'mys-field' }, `${t('gap')} · ${t('gapMax')}`,
                  h('input', {
                    className: 'mys-input',
                    disabled: !canEdit,
                    type: 'number',
                    min: 1,
                    max: 120,
                    value: Math.round((draft?.gapMs?.max ?? 8000) / 1000),
                    onChange: (event) => patchDraft((next) => { next.gapMs.max = Math.max(1, Number(event.target.value) || 1) * 1000; return next }),
                  })),
                h('label', { className: 'mys-field' }, `${t('retry')} · ${t('retryAttempts')}`,
                  h('input', {
                    className: 'mys-input',
                    disabled: !canEdit,
                    type: 'number',
                    min: 0,
                    max: 3,
                    value: draft?.retry?.attempts ?? 1,
                    onChange: (event) => patchDraft((next) => { next.retry.attempts = Number(event.target.value) || 0; return next }),
                  })),
                h('label', { className: 'mys-field' }, `${t('retry')} · ${t('retryDelay')}`,
                  h('input', {
                    className: 'mys-input',
                    disabled: !canEdit,
                    type: 'number',
                    min: 10,
                    max: 900,
                    value: Math.round((draft?.retry?.delayMs ?? 60000) / 1000),
                    onChange: (event) => patchDraft((next) => { next.retry.delayMs = Math.max(10, Number(event.target.value) || 60) * 1000; return next }),
                  })),
                h('div', { className: 'mys-hint' }, t('appVersionDesc')))))),

        h('details', { className: 'mys-disclosure', id: 'mys-account-details', ref: accountRef },
          h('summary', null, t('accountDetails')),
          h('div', { className: 'mys-disclosure-body' },
            h(SettingsGroup, { title: t('account'), desc: t('accountDesc') },
              h(SendDiagnostic, { t, value: loginFlow.sendDiagnostic }),
              login.uid ? h('div', { className: 'mys-meta' }, `${t('uid')} ${login.uid}`) : null,
              login.state !== 'anonymous' ? h('div', { className: 'mys-meta' },
                [login.loginAt ? `${t('loginAt')} ${formatTime(login.loginAt)}` : null,
                  `${t('lastRefresh')} ${login.lastRefreshAt ? formatTime(login.lastRefreshAt) : t('never')}`].filter(Boolean).join(' · ')) : null,
              h('div', { className: 'mys-actions' },
                login.state === 'active' && !needsStoken
                  ? h(Button, { onClick: refreshCredentials, disabled: busy.refresh }, busy.refresh ? t('refreshing') : t('refresh')) : null,
                login.state !== 'anonymous'
                  ? h(Button, { variant: 'danger', onClick: deleteLogin }, deleteArmed ? t('deleteConfirm') : t('deleteLogin')) : null),
              h('div', { className: 'mys-actions' },
                h(Button, { onClick: verify, disabled: busy.verify }, busy.verify ? t('verifying') : t('verify'))),
              verifyInfo === null ? null : h('div', {
                className: 'mys-banner',
                role: 'status',
                'data-tone': verifyValid ? 'ok' : verifyInfo.reachable === null ? undefined : 'warn',
              }, verifyInfo.reachable === false
                ? fill(t('verifyFail'), { message: verifyInfo.message })
                : verifyInfo.reachable === null
                  ? t('verifyAnon')
                  : verifyValid ? fill(t('verifyOk'), { ms: verifyInfo.elapsedMs ?? 0 })
                    : verifyInfo.reachable === true && verifyInfo.sessionValid === false
                      ? fill(t('verifyInvalid'), { message: verifyInfo.message ?? '—' }) : t('verifyUnavailable'))),
            h(SettingsGroup, { title: t('logs'), id: 'mys-log-group' },
               h(CoinSnapshot, { t, balance: status?.community?.balance, balanceError: status?.community?.balanceError }),
              (status?.logs ?? []).length === 0
                ? h('div', { className: 'mys-empty' }, t('logsEmpty'))
                : h('div', { className: 'mys-logs' }, (status?.logs ?? []).slice().reverse().map((entry, index) => h('div', {
                    className: 'mys-log',
                    'data-level': entry.level,
                    key: `${entry.at}-${index}`,
                  },
                  h('span', { className: 'mys-log-time' }, shortTime(entry.at)),
                  h('span', { className: 'mys-log-text' }, entry.message))))),
            h(SettingsGroup, { title: t('riskTitle') },
              h('div', { className: 'mys-hint' }, t('riskList'))))),

        loginFlow.session === null ? null : h(SmsDialog, { t, session: loginFlow.session, controller: loginFlow.controller }))
    }

    /** Sidebar rail icon for the task panel. */
    function PanelIcon({ size }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'aria-hidden': true,
      },
      h('circle', { cx: 12, cy: 12, r: 8.25, strokeWidth: 1.5 }),
      h('path', { d: 'M8.2 12.2l2.5 2.5 5.1-5.2', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mys-checkin: dictionaries')

        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = PLUGIN_ID
          tag.dataset.pluginCss = `${PLUGIN_ID}/settings.css`
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => tag.remove()
        }, 'mys-checkin: settings styles')

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'mys-checkin-status',
          order: 20,
        }, (props) => h(OverlayBadge, { ...props, t })))

        // Everything lives in the sidebar task panel; DSH Settings keeps no
        // section of its own for this plugin.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'mys-checkin',
          order: 11,
          locale: NS,
          label: () => t('panel'),
        }, PanelIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'mys-checkin',
          locale: NS,
        }, Section))
      },
    }
  },
})
