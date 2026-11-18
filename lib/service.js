/**
 * Host half of the 米游社 check-in plugin.
 *
 * Owns everything that must not live in the browser: the session cookie, the
 * device fingerprint, the timer, and every outbound request. The browser half
 * reaches it through owner-only routes under `/api/mys/`, and never sees a
 * credential.
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { GAMES, COMMUNITIES, enabledGames, normalizeConfig } from './config.js'
import {
  hasSession,
  credentialCookies,
  ensureIdentityCookies,
  sessionStoken,
} from './ds.js'
import { sleep, withRequestGuard } from './http.js'
import { communityCapability, signCommunity, getCommunityBalance } from './community.js'
import {
  getAccountProfile,
  getRoles,
  getSignInfo,
  isLoginExpired,
  isCaptcha,
  refreshCredentials,
  signGame,
  verifySession,
} from './mys.js'
import { SmsLoginProtocol, SmsLoginError } from './sms-login.js'
import { SmsLoginFlow, SmsFlowError } from './sms-flow.js'
import { Scheduler } from './scheduler.js'
import { StateStore, resolveHome, emptyCommunityState } from './store.js'
import { dayKey } from './tz.js'
import { communityDay, completedScopes, effectiveLastRunDate } from './run-policy.js'

const ROUTE_PREFIX = '/api/mys'
const MAX_BODY_BYTES = 64 * 1024
const ROUTE_PATHS = {
  status: `${ROUTE_PREFIX}/status`,
  config: `${ROUTE_PREFIX}/config`,
  loginStart: `${ROUTE_PREFIX}/login/start`,
  loginSend: `${ROUTE_PREFIX}/login/send`,
  loginSubmit: `${ROUTE_PREFIX}/login/submit`,
  loginChallenge: `${ROUTE_PREFIX}/login/challenge`,
  loginState: `${ROUTE_PREFIX}/login/state`,
  loginCancel: `${ROUTE_PREFIX}/login/cancel`,
  logout: `${ROUTE_PREFIX}/logout`,
  run: `${ROUTE_PREFIX}/run`,
  communityRun: `${ROUTE_PREFIX}/community/run`,
  refresh: `${ROUTE_PREFIX}/refresh`,
  verify: `${ROUTE_PREFIX}/verify`,
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function failure(code, message, extra = {}) {
  return { ok: false, error: { code, message }, ...extra }
}

async function readJsonBody(request) {
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) throw new Error('请求体过大')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

class LoginRequestError extends Error {
  constructor(code = 'bad-request', message = '短信登录请求格式不正确') { super(message); this.code = code }
}

function checkLoginRequest(request) {
  const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  const origin = request.headers.get('origin')
  const site = request.headers.get('sec-fetch-site')
  // Owner authorization remains the host transport's responsibility. Missing
  // Origin is allowed for its native owner client; browser Origin must match.
  if (request.method !== 'POST' || type !== 'application/json' || (site && !['same-origin', 'none'].includes(site)) || (origin !== null && origin !== new URL(request.url).origin)) throw new LoginRequestError()
}

async function readLoginBody(request) {
  checkLoginRequest(request)
  const reader = request.body?.getReader()
  let bytes = 0, chunks = []
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > 16384) { await reader.cancel(); throw new LoginRequestError() }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
  }
  let body
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new LoginRequestError() }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LoginRequestError()
  return body
}

function nowStamp() {
  return Date.now()
}

export class MysService {
  /**
   * @param {object} ctx - cordis host context with `connection`.
   * @param {object} [entryConfig] - config from the cordis entry.
   */
  constructor(ctx, entryConfig = {}) {
    this.ctx = ctx
    this.logger = typeof ctx.logger === 'function' ? ctx.logger('mys-checkin') : null
    this.store = new StateStore({
      directory: path.join(resolveHome(), 'mys-checkin'),
      entryConfig,
      onWriteError: (message) => this.logger?.warn?.(message),
    })
    this.store.load()

    this.state = this.store.get()
    this.config = this.state.config
    this.ensureDeviceId()
    this.repairIdentity()

    this.authGeneration = 0
    this.loginEpoch = 0
    this.disposed = false
    this.runningScope = null
    this.sms = new SmsLoginFlow({ protocol: new SmsLoginProtocol({ deviceId: this.deviceId, device: this.config.device }), isCurrent: () => !this.disposed })
    this.runPromise = null
    // These entry points may be called directly as well as through routes.
    // Supply one generation context and guard all nested HTTP dispatches.
    for (const name of ['enrichProfile', 'routeLoginStart', 'routeLoginSend', 'routeLoginSubmit', 'routeLoginChallenge', 'routeLoginCancel', 'routeRefresh', 'routeVerify']) {
      const operation = this[name].bind(this)
      this[name] = (...args) => {
        const context = this.sessionContext()
        if (name.startsWith('routeLogin')) context.loginEpoch = this.loginEpoch
        return withRequestGuard(() => this.isCurrentSession(context), async () => {
          try { return await operation(...args, context) }
          catch (error) {
            if (!this.isCurrentSession(context)) return failure('session-changed', '登录会话已变更，请重新操作')
            if (name.startsWith('routeLogin')) {
              const safe = error instanceof SmsLoginError || error instanceof SmsFlowError || error instanceof LoginRequestError
              return { ...failure(safe ? error.code : 'login-failed', safe ? error.message : '登录请求未完成，请重新发起登录'), flow: this.sms.view(), ...(safe && error.diagnostic ? { diagnostic: { ...error.diagnostic } } : {}) }
            }
            throw error
          }
        })
      }
    }
    this.disposers = []

    const setTimer = typeof ctx.timeout === 'function'
      ? (fn, delay) => ctx.timeout(fn, delay)
      : (fn, delay) => {
          const timer = setTimeout(fn, delay)
          if (typeof timer.unref === 'function') timer.unref()
          return () => clearTimeout(timer)
        }

    this.scheduler = new Scheduler({
      getConfig: () => ({ ...this.config, enabled: this.config.enabled && this.hasAutomaticTargets() }),
      getLastRunDate: () => effectiveLastRunDate(this.policyInput()),
      setTimer,
      onRun: (reason) => this.run(reason),
      onPlan: (plan) => {
        this.store.patchRuntime({
          planDate: plan?.date ?? null,
          plannedAt: plan === null ? null : plan.targetAt.getTime(),
          nextRunAt: plan === null ? null : plan.targetAt.getTime(),
          planReason: plan?.reason ?? null,
        })
      },
      onError: (error) => this.logger?.warn?.(`定时任务失败：${String(error?.message ?? error)}`),
    })

    this.registerRoutes()
    this.scheduler.start()
    this.log('info', '米游社签到插件已启动')
    // Credentials stored before the nickname lookup existed get one background
    // attempt so the account card shows a name instead of a bare UID.
    void this.enrichProfile()
  }

  /** Read the community nickname when the stored session has none. */
  async enrichProfile(context) {
    const auth = this.state.auth
    if (auth === null) return
    if (typeof auth.accountName === 'string' && auth.accountName !== '') return
    try {
      const profile = await getAccountProfile({
        config: this.config,
        deviceId: this.deviceId,
        cookies: auth.cookies,
        uid: String(auth.stuid ?? auth.aid ?? ''),
      })
      this.checkSession(context)
      if (profile.ok === true) {
        this.store.setAuth({ ...this.state.auth, accountName: profile.nickname ?? null, avatar: profile.avatar ?? null })
        this.log('info', `已读取米游社昵称：${profile.nickname}`)
      }
    } catch {
      /* cosmetic only */
    }
  }

  /**
   * Repair credentials saved by 0.2.0: the App QR flow persisted V2 id cookies
   * plus a V1 ltoken (from `getLTokenBySToken`), while luna endpoints pair a V1
   * ltoken with `ltuid` / `account_id`. Without those aliases every signed call
   * answers -100 even though the session itself is valid.
   */
  repairIdentity() {
    const auth = this.state.auth
    if (auth === null) return
    const before = JSON.stringify(auth.cookies)
    ensureIdentityCookies(auth.cookies, {
      aid: auth.aid ?? auth.stuid ?? auth.cookies.ltuid ?? auth.cookies.ltuid_v2,
      mid: auth.mid ?? auth.cookies.ltmid_v2,
    })
    if (JSON.stringify(auth.cookies) === before) return
    this.store.setAuth(auth)
    if (this.state.runtime.lastError?.code === 'LOGIN_EXPIRED') {
      // The -100 came from the missing alias, not from a dead session.
      this.store.patchRuntime({ lastError: null, roles: null })
    }
    this.store.log('info', '已补齐登录凭据缺失的 ID Cookie（ltuid/account_id）')
  }

  /** Generate and persist the device id on first use; never change it afterwards. */
  ensureDeviceId() {
    const existing = this.state.runtime.deviceId
    if (typeof existing === 'string' && /^[0-9a-f-]{36}$/i.test(existing)) return existing
    const created = randomUUID()
    this.store.patchRuntime({ deviceId: created })
    return created
  }

  get deviceId() {
    return this.state.runtime.deviceId
  }

  log(level, message, detail) {
    this.store.log(level, message, detail)
    const sink = this.logger
    if (sink !== null) {
      if (level === 'error') sink.error?.(message)
      else if (level === 'warn') sink.warn?.(message)
      else sink.info?.(message)
    }
  }

  /** Register the owner-only routes; disposal removes them. */
  registerRoutes() {
    const routes = [
      { path: ROUTE_PATHS.status, methods: ['GET'], handler: (request) => this.routeStatus(request) },
      { path: ROUTE_PATHS.config, methods: ['POST'], handler: (request) => this.routeConfig(request) },
      { path: ROUTE_PATHS.loginStart, methods: ['POST'], handler: (request) => this.routeLoginStart(request) },
      { path: ROUTE_PATHS.loginSend, methods: ['POST'], handler: (request) => this.routeLoginSend(request) },
      { path: ROUTE_PATHS.loginSubmit, methods: ['POST'], handler: (request) => this.routeLoginSubmit(request) },
      { path: ROUTE_PATHS.loginChallenge, methods: ['POST'], handler: (request) => this.routeLoginChallenge(request) },
      { path: ROUTE_PATHS.loginState, methods: ['GET'], handler: () => this.routeLoginState() },
      { path: ROUTE_PATHS.loginCancel, methods: ['POST'], handler: (request) => this.routeLoginCancel(request) },
      { path: ROUTE_PATHS.logout, methods: ['POST'], handler: (request) => this.routeLogout(request) },
      { path: ROUTE_PATHS.run, methods: ['POST'], handler: (request) => this.routeRun(request) },
      { path: ROUTE_PATHS.communityRun, methods: ['POST'], handler: (request) => this.routeCommunityRun(request) },
      { path: ROUTE_PATHS.refresh, methods: ['POST'], handler: (request) => this.routeRefresh(request) },
      { path: ROUTE_PATHS.verify, methods: ['POST'], handler: (request) => this.routeVerify(request) },
    ]
    for (const route of routes) {
      const dispose = this.ctx.connection.fetch.register({
        path: route.path,
        methods: route.methods,
        requestBody: 'buffered',
        fetch: (request) => this.guard(route.handler, request),
      })
      this.disposers.push(dispose)
    }
  }

  /** Wrap one handler: JSON errors instead of a broken response. */
  async guard(handler, request) {
    try {
      const result = await handler(request)
      return json(result)
    } catch (error) {
      const message = '接口请求失败，请稍后重试'
      this.logger?.warn?.(message)
      return json(failure('internal', message), 200)
    }
  }

  /** Dismiss every route and timer. */
  dispose() {
    this.disposed = true
    this.sms.dispose()
    this.scheduler.stop()
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
    this.store.close()
  }

  // ---------------------------------------------------------------- status

  accountSummary() {
    const auth = this.state.auth
    if (auth === null) {
      return { state: 'anonymous', accountName: null, uid: null, loginAt: null, lastRefreshAt: null, hasStoken: false, avatar: null }
    }
    const expired = this.state.runtime.lastError?.code === 'LOGIN_EXPIRED'
    // `mid` is an opaque account token; the number a user recognizes as their
    // miHoYo UID is `ltuid` / `account_id`.
    const cookies = auth.cookies ?? {}
    const uid = cookies.ltuid_v2 ?? cookies.ltuid ?? cookies.account_id_v2 ?? cookies.account_id ?? auth.stuid ?? auth.aid ?? null
    return {
      state: expired || !hasSession(cookies) ? 'expired' : 'active',
      accountName: auth.accountName ?? this.fallbackNickname(),
      uid: uid === null ? null : String(uid),
      loginAt: auth.loginAt ?? null,
      lastRefreshAt: auth.lastRefreshAt ?? null,
      hasStoken: sessionStoken(cookies) !== null,
      avatar: auth.avatar ?? null,
    }
  }

  /** In-game nickname of the first bound role, used when no community profile is known. */
  fallbackNickname() {
    const roles = this.state.runtime.roles
    if (roles === null || typeof roles !== 'object') return null
    for (const role of Object.values(roles.byGame ?? {})) {
      if (role !== null && typeof role === 'object' && typeof role.nickname === 'string' && role.nickname !== '') return role.nickname
    }
    return null
  }

  roleSummary() {
    const cache = this.state.runtime.roles
    const today = dayKey(new Date(nowStamp()), this.config.timezone)
    if (cache === null || cache?.date !== today) return {}
    return cache.byGame ?? {}
  }

  statusPayload() {
    const runtime = this.state.runtime
    const roles = this.roleSummary()
    const plan = this.scheduler.getPlan()
    return {
      ok: true,
      enabled: this.config.enabled,
      config: this.config,
      timezone: this.config.timezone,
      running: this.runPromise !== null,
      login: this.accountSummary(),
      loginFlow: this.sms.view(),
      schedule: {
        date: plan?.date ?? null,
        targetAt: plan?.targetAt?.getTime() ?? null,
        window: plan?.window ?? null,
        reason: plan?.reason ?? null,
        lastRunDate: runtime.lastRunDate ?? null,
        lastRunAt: runtime.lastRunAt ?? null,
      },
      lastResult: runtime.lastResult ?? null,
      lastError: runtime.lastError ?? null,
      community: {
        enabled: this.config.community.enabled,
        communities: COMMUNITIES.map((item) => ({ ...item, enabled: this.config.community.gids.includes(item.id) })),
        capability: communityCapability(this.state.auth),
        running: this.runPromise !== null && ['community', 'combined'].includes(this.runningScope),
        lastResult: runtime.community.lastResult,
        lastError: runtime.community.lastError,
        balance: runtime.community.balance,
        balanceError: runtime.community.balanceError,
      },
      roles,
      games: GAMES.map((game) => ({
        id: game.id,
        label: game.label,
        biz: game.biz,
        enabled: this.config.games[game.id] === true,
        role: roles[game.id] ?? null,
      })),
      logs: (runtime.log ?? []).slice(-60),
    }
  }

  async routeStatus() {
    return this.statusPayload()
  }

  // ------------------------------------------------------------ config

  async routeConfig(request) {
    const body = await readJsonBody(request)
    const patch = body?.config ?? body
    if (patch === null || typeof patch !== 'object') return failure('bad-request', '配置格式不正确')
    const merged = { ...this.config, ...patch }
    if (patch.community && typeof patch.community === 'object' && !Array.isArray(patch.community)) {
      merged.community = { ...this.config.community, ...patch.community }
      if (patch.community.client && typeof patch.community.client === 'object' && !Array.isArray(patch.community.client)) {
        merged.community.client = { ...this.config.community.client, ...patch.community.client }
      }
    }
    this.config = normalizeConfig(merged)
    this.store.setConfig(this.config)
    this.scheduler.refresh()
    this.log('info', `配置已更新：${this.config.windows.map((window) => `${window.start}-${window.end}`).join('、')}`)
    return { ok: true, config: this.config, status: this.statusPayload() }
  }

  // ------------------------------------------------------------- login

  async routeLoginStart(request, context) {
    checkLoginRequest(request)
    this.checkSession(context)
    // Revoke the old flow before awaiting a possibly streaming owner body.
    this.sms.cancel()
    context.loginEpoch = ++this.loginEpoch
    const body = await readLoginBody(request)
    this.checkSession(context)
    const flow = this.sms.start(body.phone)
    return { ok: true, flow }
  }

  async routeLoginState() { return { ok: true, flow: this.sms.view() } }

  async routeLoginSend(request, context) {
    const body = await readLoginBody(request)
    this.checkSession(context)
    const result = await this.sms.send(body.flowId)
    this.checkLogin(context, body.flowId)
    return { ok: true, flow: result.flow, ...(result.challenge ? { challenge: result.challenge } : {}) }
  }

  async routeLoginSubmit(request, context) {
    const body = await readLoginBody(request)
    this.checkSession(context)
    return this.completeSms(await this.sms.submit(body.flowId, body.code), body.flowId, context)
  }

  async routeLoginChallenge(request, context) {
    const body = await readLoginBody(request)
    this.checkSession(context)
    return this.completeSms(await this.sms.solve(body.flowId, body.challengeId, body.result), body.flowId, context)
  }

  checkLogin(context, flowId) {
    this.checkSession(context)
    const flow = this.sms.view()
    if (!flow || flow.flowId !== flowId || flow.status === 'expired' || flow.expiresAt <= nowStamp()) throw new SmsFlowError('flow-changed')
  }

  async completeSms(result, flowId, context) {
    this.checkLogin(context, flowId)
    if (!result.candidate) return { ok: true, flow: result.flow, ...(result.challenge ? { challenge: result.challenge } : {}) }
    const { aid, mid, stoken, ltoken, cookieToken } = result.candidate
    const cookies = { stuid: aid, mid }
    for (const [name, token] of [['stoken', stoken], ['ltoken', ltoken], ['cookie_token', cookieToken]]) {
      cookies[token.startsWith('v2_') ? name + '_v2' : name] = token
    }
    ensureIdentityCookies(cookies, { aid, mid })
    const auth = { cookies: credentialCookies(cookies), aid, stuid: aid, mid, accountName: null, avatar: null, loginAt: nowStamp(), lastRefreshAt: nowStamp() }
    // Candidates never touch saved auth, logs or account runtime before validation.
    let warning
    try {
      const roles = await getRoles({ config: context.config, deviceId: this.deviceId, cookies: auth.cookies, biz: 'hk4e_cn', strict: true })
      this.checkLogin(context, flowId)
      if (!roles.ok) throw new LoginRequestError('game-validation-failed', '候选账号的游戏凭据未通过校验，原登录未改变')
      const balance = await getCommunityBalance({ config: context.config, deviceId: this.deviceId, auth, strict: true })
      this.checkLogin(context, flowId)
      if (!balance.ok) {
        if (context.config.community.enabled || this.config.community.enabled) throw new LoginRequestError('community-validation-failed', '候选账号的社区凭据未通过校验，原登录未改变')
        warning = '社区凭据未验证；启用社区签到前请重新登录校验'
      }
    } catch (error) {
      this.sms.cancel(flowId)
      throw error
    }
    // Synchronous replacement: no await between the last guard and commit.
    this.checkLogin(context, flowId)
    this.authGeneration++
    this.store.setAuth(auth)
    this.clearAccountRuntime()
    this.sms.cancel(flowId)
    this.loginEpoch++
    Object.assign(context, this.sessionContext(), { loginEpoch: this.loginEpoch })
    this.scheduler.refresh()
    this.log('info', '短信登录成功，凭据已通过校验并保存')
    void this.enrichProfile()
    return { ok: true, state: 'confirmed', flow: null, ...(warning ? { warning } : {}), account: this.accountSummary(), status: this.statusPayload() }
  }

  async routeLoginCancel(request, context) {
    const body = await readLoginBody(request)
    this.checkSession(context)
    if (typeof body.flowId !== 'string' || !this.sms.cancel(body.flowId)) throw new SmsFlowError('flow-changed')
    this.loginEpoch++
    return { ok: true, flow: null }
  }

  async routeLogout(request) {
    await readJsonBody(request).catch(() => undefined)
    const hadAuth = this.state.auth !== null
    this.authGeneration += 1
    this.loginEpoch += 1
    this.sms.cancel()
    this.store.setAuth(null)
    this.clearAccountRuntime()
    this.scheduler.refresh()
    this.log('info', hadAuth ? '已删除登录凭据' : '当前没有登录凭据可删除')
    return { ok: true, status: this.statusPayload() }
  }

  // ------------------------------------------------------------- actions

  async routeRun(request) {
    const body = await readJsonBody(request).catch(() => ({}))
    if (body?.game !== undefined && typeof body.game !== 'string') return failure('bad-request', 'game 参数不正确')
    const started = this.run('manual', typeof body?.game === 'string' ? body.game : null)
    return started
  }

  async routeRefresh(request, context) {
    await readJsonBody(request).catch(() => undefined)
    this.checkSession(context)
    const auth = this.state.auth
    if (auth === null) return failure('anonymous', '尚未登录')
    const result = await refreshCredentials({ config: this.config, deviceId: this.deviceId, cookies: auth.cookies })
    this.checkSession(context)
    if (result.ok !== true) {
      if (result.reason === 'no-stoken') {
        // No stoken is not the same as an expired session: the ltoken may still
        // sign in fine until it expires on its own.
        const message = '当前登录没有 SToken，无法尝试续期；请使用短信重新登录'
        this.log('warn', message)
        return failure('no-stoken', message)
      }
      if (result.reason === 'captcha') {
        this.store.patchRuntime({ lastError: { code: 'CAPTCHA', message: result.message, at: nowStamp() } })
        this.log('warn', result.message)
        return failure('captcha', result.message)
      }
      if (result.reason === 'network') {
        const message = '续期请求失败（网络原因），登录状态未改变；请稍后重试'
        this.log('warn', message)
        return failure('refresh-failed', message)
      }
      const message = 'SToken 已失效，无法续期；当前 cookie 可能仍可签到，建议重新短信登录'
      this.store.patchRuntime({ lastError: { code: 'LOGIN_EXPIRED', message, at: nowStamp() } })
      this.log('error', `凭据续期失败：${result.message}`)
      return failure('refresh-failed', message)
    }
    this.store.setAuth({ ...auth, cookies: result.cookies, lastRefreshAt: nowStamp() })
    this.store.patchRuntime({ lastError: null })
    this.log('info', '凭据已续期')
    return { ok: true, login: this.accountSummary(), status: this.statusPayload() }
  }

  async routeVerify(request, context) {
    await readJsonBody(request).catch(() => undefined)
    this.checkSession(context)
    const auth = this.state.auth
    const startedAt = nowStamp()
    if (auth === null) {
      return { ok: true, reachable: null, message: '尚未登录，无法测试接口连通性' }
    }
    try {
      const result = await verifySession({ config: this.config, deviceId: this.deviceId, cookies: auth.cookies })
      this.checkSession(context)
      if (result.ok === true) void this.enrichProfile()
      return {
        ok: true,
        reachable: true,
        sessionValid: result.ok === true,
        retcode: result.retcode ?? null,
        message: result.ok === true ? '接口可用，登录状态有效' : `接口可用，但登录状态无效：${result.message}`,
        elapsedMs: nowStamp() - startedAt,
      }
    } catch (error) {
      return {
        ok: true,
        reachable: false,
        sessionValid: null,
        message: '网络请求失败，请稍后重试',
        elapsedMs: nowStamp() - startedAt,
      }
    }
  }

  // --------------------------------------------- shared account lifecycle

  sessionContext(reason = 'manual') {
    return {
      generation: this.authGeneration,
      accountId: communityCapability(this.state.auth).accountId,
      auth: structuredClone(this.state.auth), config: structuredClone(this.config), reason,
    }
  }

  isCurrentSession(context) {
    return !this.disposed && context.generation === this.authGeneration
      && context.accountId === communityCapability(this.state.auth).accountId
      && (context.loginEpoch === undefined || context.loginEpoch === this.loginEpoch)
  }

  checkSession(context) {
    if (!this.isCurrentSession(context)) throw new Error('登录会话已变更')
  }

  clearAccountRuntime() {
    this.store.patchRuntime({
      community: emptyCommunityState(), roles: null, lastError: null,
      lastResult: null, lastRunAt: null, lastRunDate: null, scheduleLastAttemptDate: null,
    })
  }

  async routeCommunityRun(request) {
    const body = await readJsonBody(request)
    if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) return failure('bad-request', '社区签到使用已保存的分区配置，请发送空对象')
    const started = this.runCommunity()
    return { ...started, status: this.statusPayload() }
  }

  runCommunity(reason = 'manual') {
    if (this.runPromise !== null) return { ...failure('busy', '已有签到任务正在运行'), started: false }
    if (!this.config.community.enabled) return { ...failure('community-disabled', '社区签到未启用'), started: false }
    if (this.config.community.gids.length === 0) return { ...failure('community-empty', '尚未选择社区分区'), started: false }
    if (!communityCapability(this.state.auth).available) return { ...failure('auth-unavailable', '社区凭据不完整，请使用短信登录'), started: false }
    const context = this.sessionContext(reason)
    this.runningScope = 'community'
    this.runPromise = withRequestGuard(() => this.isCurrentSession(context), () => this.executeCommunity(context))
      .catch(() => {
        if (!this.isCurrentSession(context)) return
        this.patchCommunity(context, { lastError: { code: 'unknown', message: '社区任务未完成，请检查本轮结果后手动重试', at: nowStamp() } })
      })
      .finally(() => {
        this.runPromise = null
        this.runningScope = null
        this.scheduler.refresh()
      })
    return { ok: true, started: true }
  }

  patchCommunity(context, patch) {
    this.checkSession(context)
    this.store.patchRuntime({ community: { ...this.state.runtime.community, ...patch } })
  }

  async executeCommunity(context) {
    this.checkSession(context)
    const { config, auth, reason, accountId } = context
    const at = nowStamp()
    const day = dayKey(new Date(at), 'Asia/Shanghai')
    const gids = [...config.community.gids]
    if (this.state.runtime.community.accountId !== accountId) {
      this.patchCommunity(context, { ...emptyCommunityState(), accountId })
    }
    let fatal = context.fatal ?? null
    const capability = communityCapability(auth)
    const results = []
    // Informational account-level query; task58/remaining points do not prove
    // anything about individual communities. Failure cannot skip their writes.
    const queryBalance = async () => {
      const balance = await getCommunityBalance({ config, deviceId: this.deviceId, auth })
      this.checkSession(context)
      this.patchCommunity(context, balance.ok
        ? { balance: balance.snapshot, balanceError: null }
        : { balanceError: balance.error })
      if (balance.outcome === 'captcha') fatal = 'captcha'
    }
    if (fatal === null && capability.available) await queryBalance()
    for (const gid of gids) {
      this.checkSession(context)
      const day = communityDay(nowStamp())
      const label = COMMUNITIES.find((item) => item.id === gid).label
      let signed
      if (fatal === 'captcha' || !this.config.community.enabled) {
        signed = { outcome: 'skipped', message: fatal === 'captcha' ? '检测到人工验证，已停止后续写入' : '社区签到已关闭，已停止后续写入' }
      } else if (!capability.available) {
        signed = { outcome: 'auth-unavailable', message: '社区凭据不完整，请使用短信登录' }
      } else if (this.state.runtime.community.signedDays[gid]?.day === day) {
        signed = { outcome: 'cached-success', message: '本机已记录该分区今日接口接受签到' }
      } else {
        signed = await signCommunity({ config, deviceId: this.deviceId, auth, gid })
        this.checkSession(context)
        if (signed.outcome === 'success') {
          this.patchCommunity(context, { signedDays: { ...this.state.runtime.community.signedDays, [gid]: { day, at: nowStamp() } } })
        }
        if (signed.outcome === 'captcha') fatal = 'captcha'
      }
      results.push({ gid, label, day, at: nowStamp(), ...signed })
      // Only between actual targets, and never after a CAPTCHA.
      if (fatal === null && gid !== gids[gids.length - 1] && this.config.community.enabled) {
        const { min, max } = config.gapMs
        if (max > 0) await sleep(min + Math.floor(Math.random() * Math.max(1, max - min)))
      }
    }
    if (fatal === null && capability.available && this.config.community.enabled) await queryBalance()
    const ok = gids.length > 0 && fatal === null && results.every((item) => ['success', 'cached-success'].includes(item.outcome))
    const issue = results.find((item) => !['success', 'cached-success'].includes(item.outcome))
    this.patchCommunity(context, {
      lastRunAt: at,
      lastResult: { at, finishedAt: nowStamp(), reason, day, gids, ok, results },
      lastError: ok ? null : { code: fatal ?? issue?.outcome ?? 'error', message: fatal === 'captcha' ? '需要人工验证，已停止本轮后续签到' : issue?.message ?? '社区签到未完成', at: nowStamp() },
    })
    this.log(ok ? 'info' : 'warn', ok ? '社区签到结束：接口已接受各分区签到（积分到账未独立验证）' : '社区签到结束：存在未完成分区，请查看社区结果')
    return { fatal, ok }
  }

  // ---------------------------------------------------------------- run

  /**
   * Start one check-in run. Returns immediately; the browser polls status.
   *
   * @param {'manual'|'schedule'} reason
   * @param {string|null} [onlyGame] - restrict a manual run to one game id.
   */
  run(reason, onlyGame = null) {
    if (reason === 'schedule') return this.runScheduled()
    if (this.runPromise !== null) return { ok: false, started: false, error: { code: 'busy', message: '已有签到任务在进行中' } }
    if (this.state.auth === null) {
      return { ok: false, started: false, error: { code: 'anonymous', message: '请先短信登录' } }
    }

    const context = this.sessionContext(reason)
    this.runningScope = 'game'
    this.runPromise = withRequestGuard(() => this.isCurrentSession(context), () => this.executeRun(reason, onlyGame, context))
      .catch(() => {
        if (!this.isCurrentSession(context)) return
        const message = '签到请求失败，请稍后重试'
        this.store.patchRuntime({ lastError: { code: 'RUN_FAILED', message, at: nowStamp() } })
        this.log('error', `签到任务异常：${message}`)
      })
      .finally(() => {
        this.runPromise = null
        this.runningScope = null
        this.scheduler.refresh()
      })
    return { ok: true, started: true }
  }

  policyInput(config = this.config) {
    return { config, runtime: this.state.runtime, accountId: communityCapability(this.state.auth).accountId, now: new Date(nowStamp()) }
  }

  hasAutomaticTargets() {
    return enabledGames(this.config).length > 0 || (this.config.community.enabled && this.config.community.gids.length > 0)
  }

  runScheduled() {
    // Busy is not an attempt. The current owner's finally block will replan.
    if (this.runPromise !== null) return { ...failure('busy', '已有签到任务在进行中'), started: false }
    if (!this.config.enabled || !this.hasAutomaticTargets()) return { ...failure('no-targets', '没有启用的自动签到目标'), started: false }
    const input = this.policyInput()
    const today = dayKey(input.now, this.config.timezone)
    if (effectiveLastRunDate(input) === today) return { ...failure('already-attempted', '今日自动签到机会已消费或所有范围均已完成'), started: false }
    const context = this.sessionContext('schedule')
    const completed = completedScopes(input)
    this.store.patchRuntime({ scheduleLastAttemptDate: today })
    if (context.auth === null) {
      this.log('warn', '定时签到已跳过：尚未登录')
      return { ...failure('anonymous', '请先短信登录'), started: false }
    }
    const games = enabledGames(context.config).length > 0 && !completed.games
    const community = context.config.community.enabled && context.config.community.gids.length > 0 && !completed.community
    this.runningScope = games && community ? 'combined' : community ? 'community' : 'game'
    let activeScope = games ? 'game' : 'community'
    this.runPromise = withRequestGuard(() => this.isCurrentSession(context), async () => {
      const gameResult = games ? await this.executeRun('schedule', null, context) : null
      this.checkSession(context)
      if (community) {
        activeScope = 'community'
        await this.executeCommunity({ ...context, fatal: gameResult?.fatal === 'captcha' ? 'captcha' : null })
      }
    }).catch(() => {
      if (!this.isCurrentSession(context)) return
      const error = { code: 'unknown', message: '自动签到未完成，请查看分范围结果', at: nowStamp() }
      if (activeScope === 'game') this.store.patchRuntime({ lastError: error })
      else this.patchCommunity(context, { lastError: error })
    }).finally(() => {
      this.runPromise = null
      this.runningScope = null
      this.scheduler.refresh()
    })
    return { ok: true, started: true }
  }

  async executeRun(reason, onlyGame, context) {
    const startedAt = nowStamp()
    const timeZone = context.config.timezone
    const today = dayKey(new Date(startedAt), timeZone)
    const targets = enabledGames(context.config).filter((game) => onlyGame === null || game.id === onlyGame)
    if (targets.length === 0) {
      this.log('warn', '没有启用任何游戏，签到未执行')
      return
    }

    this.log('info', `${reason === 'manual' ? '手动' : '定时'}签到开始，目标：${targets.map((game) => game.label).join('、')}`)
    const results = []
    let fatal = null
    let refreshed = false

    for (const game of targets) {
      this.checkSession(context)
      const auth = this.state.auth
      if (auth === null) break
      try {
        const resolved = await this.resolveRole(game, auth, context)
        this.checkSession(context)
        if (resolved.error !== undefined) {
          if (resolved.error === 'captcha') {
            fatal = 'captcha'
            results.push({ game: game.id, label: game.label, outcome: 'captcha', message: resolved.message })
            this.store.patchRuntime({ lastError: { code: 'CAPTCHA_REQUIRED', message: '需要人工验证，已停止本轮后续签到', at: nowStamp() } })
            break
          }
          if (resolved.error === 'expired') {
            this.store.patchRuntime({
              lastError: { code: 'LOGIN_EXPIRED', message: '登录状态已失效，请重新短信登录', at: nowStamp() },
            })
            results.push({ game: game.id, label: game.label, outcome: 'expired', message: resolved.message })
            this.log('error', `${game.label}：${resolved.message}`)
            fatal = 'expired'
            break
          }
          results.push({ game: game.id, label: game.label, outcome: 'error', message: resolved.message })
          this.log('error', `${game.label}：${resolved.message}`)
          continue
        }
        const role = resolved.role
        if (role === null) {
          results.push({ game: game.id, label: game.label, outcome: 'no-role', message: '该游戏下没有角色' })
          this.log('info', `${game.label}：账号下没有角色，跳过`)
          continue
        }

        // One cheap state read per game gives the cumulative day count and
        // avoids a redundant sign call when today is already done.
        let info = null
        try {
          info = await getSignInfo({ config: context.config, deviceId: this.deviceId, cookies: auth.cookies, game, role })
        } catch {
          info = null
        }

        this.checkSession(context)
        let signed
        if (isCaptcha(info?.retcode)) {
          signed = { outcome: 'captcha', retcode: info.retcode, message: '需要人工验证，已停止本轮后续签到' }
        } else if (info?.ok === true && info.isSign === true) {
          signed = { outcome: 'already', retcode: 0, message: '今日已签到' }
        } else if (info?.ok === true && info.firstBind === true) {
          signed = { outcome: 'first-bind', retcode: 0, message: '首次绑定需在米游社手动签到一次' }
        } else {
          signed = await this.signWithRetry(auth, game, role, context)
        }

        this.checkSession(context)
        // One refresh attempt per run, and only when the server says the session died.
        if (signed.outcome === 'expired' && refreshed !== true) {
          const refreshedAuth = await refreshCredentials({ config: context.config, deviceId: this.deviceId, cookies: auth.cookies })
          this.checkSession(context)
          if (refreshedAuth.ok === true) {
            this.store.setAuth({ ...auth, cookies: refreshedAuth.cookies, lastRefreshAt: nowStamp() })
            refreshed = true
            this.log('info', '登录凭据已自动续期，重试签到')
            signed = await this.signWithRetry({ ...auth, cookies: refreshedAuth.cookies }, game, role, context)
          } else if (refreshedAuth.reason === 'captcha') {
            signed = { outcome: 'captcha', retcode: refreshedAuth.retcode, message: refreshedAuth.message }
          } else if (refreshedAuth.reason === 'no-stoken') {
            this.log('warn', '当前凭据不含 SToken，无法自动续期')
          }
        }

        this.checkSession(context)
        const totalDays = info?.ok === true && typeof info.totalDays === 'number'
          ? info.totalDays + (signed.outcome === 'signed' ? 1 : 0)
          : null

        results.push({
          game: game.id,
          label: game.label,
          role: role.nickname || role.uid,
          uid: role.uid,
          region: role.region,
          regionName: role.regionName,
          level: role.level,
          outcome: signed.outcome,
          retcode: signed.retcode,
          message: signed.message,
          awards: signed.awards ?? undefined,
          totalDays,
        })

        if (signed.outcome === 'expired') {
          this.store.patchRuntime({
            lastError: {
              code: 'LOGIN_EXPIRED',
              message: '登录状态已失效，签到被拒绝，请重新短信登录',
              at: nowStamp(),
            },
          })
          this.log('error', `${game.label}：登录已失效（${signed.retcode}），需要重新短信登录`)
          fatal = 'expired'
          break
        }
        if (signed.outcome === 'captcha') {
          this.store.patchRuntime({
            lastError: {
              code: 'CAPTCHA',
              message: '米游社要求人机验证。请打开米游社 App → 我的 → 我的角色 完成验证，今日已停止自动签到',
              at: nowStamp(),
            },
          })
          this.log('warn', `${game.label}：触发人机验证，停止今日剩余签到`)
          fatal = 'captcha'
          break
        }
        if (signed.outcome === 'signed') this.log('info', `${game.label}：签到成功`)
        else if (signed.outcome === 'already') this.log('info', `${game.label}：今日已签到`)
        else if (signed.outcome === 'first-bind') this.log('warn', `${game.label}：首次绑定需要在米游社手动签到一次`)
        else if (signed.outcome === 'not-bound') this.log('warn', `${game.label}：角色未绑定（${signed.message}）`)
        else this.log('warn', `${game.label}：签到失败 ${signed.retcode} ${signed.message}`)
      } catch {
        this.checkSession(context)
        const message = '签到请求失败，请稍后重试'
        results.push({ game: game.id, label: game.label, outcome: 'error', message })
        this.log('error', `${game.label}：请求失败 ${message}`)
      }

      // Human-like spacing between games; the last game needs no sleep.
      if (game !== targets[targets.length - 1]) {
        const { min, max } = context.config.gapMs
        if (max > 0) await sleep(min + Math.floor(Math.random() * Math.max(1, max - min)))
      }
    }

    this.checkSession(context)
    if (fatal === 'captcha') {
      for (const game of targets) if (!results.some((item) => item.game === game.id)) {
        results.push({ game: game.id, label: game.label, outcome: 'skipped', message: '检测到人工验证，已停止后续写入' })
      }
    }
    const ok = fatal === null && results.every((item) => ['signed', 'already', 'no-role', 'first-bind'].includes(item.outcome))
    const summary = results.map((item) => `${item.label}:${labelOfOutcome(item.outcome)}`).join('、')
    const record = {
      date: today,
      at: startedAt,
      finishedAt: nowStamp(),
      reason,
      ok,
      results,
      summary,
    }

    const patch = {
      lastResult: record,
      lastRunAt: startedAt,
    }
    // A manual run only consumes the day when it actually finished cleanly, so
    // a failed manual attempt leaves the automatic run in place.
    if (ok && onlyGame === null && reason !== 'schedule') patch.lastRunDate = today
    // A clean run retires the previous failure banner; a fatal one keeps it.
    if (ok && fatal === null) patch.lastError = null
    this.store.patchRuntime(patch)
    this.log(ok ? 'info' : 'warn', `签到结束：${summary}`)
    return { fatal, ok }
  }

  /** Sign one game, retrying transport failures up to the configured budget. */
  async signWithRetry(auth, game, role, context) {
    const attempts = Math.max(1, context.config.retry.attempts)
    let lastError
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      this.checkSession(context)
      try {
        return await signGame({
          config: context.config,
          deviceId: this.deviceId,
          cookies: auth.cookies,
          game,
          role,
        })
      } catch (error) {
        this.checkSession(context)
        lastError = error
        if (attempt < attempts) {
          this.log('warn', `${game.label}：请求失败，${Math.round(context.config.retry.delayMs / 1000)} 秒后重试（${attempt}/${attempts - 1}）`)
          await sleep(context.config.retry.delayMs)
        }
      }
    }
    throw lastError
  }

  /**
   * Resolve one role for a game, caching the binding query for the day.
   * @returns {Promise<{role: object|null, error?: undefined} | {error: 'expired'|'error', message: string}>}
   */
  async resolveRole(game, auth, context) {
    this.checkSession(context)
    const today = dayKey(new Date(nowStamp()), context.config.timezone)
    const cache = this.state.runtime.roles
    if (cache !== null && cache?.date === today && cache.byGame?.[game.id] !== undefined) {
      return { role: cache.byGame[game.id] }
    }
    const result = await getRoles({
      config: context.config,
      deviceId: this.deviceId,
      cookies: auth.cookies,
      biz: game.biz,
    })
    this.checkSession(context)
    if (result.ok !== true) {
      if (isCaptcha(result.retcode)) return { error: 'captcha', message: '需要人工验证，已停止本轮后续签到' }
      if (isLoginExpired(result.retcode)) {
        return { error: 'expired', message: `登录已失效（${result.retcode} ${result.message}）` }
      }
      return { error: 'error', message: `查询角色失败（${result.retcode} ${result.message}）` }
    }
    const role = result.roles[0] ?? null
    const byGame = { ...(cache?.date === today ? cache.byGame : {}), [game.id]: role }
    this.store.patchRuntime({ roles: { date: today, byGame } })
    return { role }
  }
}

function labelOfOutcome(outcome) {
  switch (outcome) {
    case 'signed':
      return '成功'
    case 'already':
      return '已签到'
    case 'no-role':
      return '无角色'
    case 'captcha':
      return '需验证'
    case 'expired':
      return '登录失效'
    case 'not-bound':
      return '未绑定'
    case 'first-bind':
      return '待手动签到'
    default:
      return '失败'
  }
}
