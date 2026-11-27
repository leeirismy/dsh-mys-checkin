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
import { DABIEYE, GAMES, GAME_INDEX, checkinTargets, enabledGames, normalizeConfig } from './config.js'
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
  refreshCredentials, v2SessionCookies,
  signGame,
  verifySession,
} from './mys.js'
import { SmsLoginProtocol, SmsLoginError } from './sms-login.js'
import { SmsLoginFlow, SmsFlowError } from './sms-flow.js'
import { captchaFrameResponse } from './captcha-frame.js'
import { Scheduler } from './scheduler.js'
import { StateStore, resolveHome, emptyCommunityState } from './store.js'
import { dayKey } from './tz.js'
import { communityDay, completedScopes, effectiveLastRunDate } from './run-policy.js'

const ROUTE_PREFIX = '/api/mys'
const MAX_BODY_BYTES = 64 * 1024
const ROUTE_PATHS = {
  status: `${ROUTE_PREFIX}/status`,
  config: `${ROUTE_PREFIX}/config/checkin`,
  loginStart: `${ROUTE_PREFIX}/login/start`,
  loginSend: `${ROUTE_PREFIX}/login/send`,
  loginSubmit: `${ROUTE_PREFIX}/login/submit`,
  loginChallenge: `${ROUTE_PREFIX}/login/challenge`,
  loginState: `${ROUTE_PREFIX}/login/state`,
  loginCancel: `${ROUTE_PREFIX}/login/cancel`,
  logout: `${ROUTE_PREFIX}/logout`,
  checkin: `${ROUTE_PREFIX}/run/checkin`,
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
  let expected = new URL(request.url).origin
  // The admitted Web carrier uses this fixed sentinel URL (http-bridge.ts).
  // Its Host/Origin fence already rejects foreign browser authorities. Compare
  // against that preserved Host, never against a caller-provided forwarded URL.
  if (expected === 'http://dsh.internal' && origin !== null) {
    const host = request.headers.get('host')
    try {
      const parsed = new URL(origin)
      if (!host || /[\s/@?#\\]/.test(host) || !['http:', 'https:'].includes(parsed.protocol)) throw new Error()
      expected = new URL(`${parsed.protocol}//${host}`).origin
    } catch { throw new LoginRequestError() }
  }
  if (request.method !== 'POST' || type !== 'application/json' || (site && !['same-origin', 'none'].includes(site)) || (origin !== null && origin !== expected)) throw new LoginRequestError()
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

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isRevision(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
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
    this.accountRevision = randomUUID()
    this.configRevision = randomUUID()
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
      { path: `${ROUTE_PREFIX}/login/captcha-frame`, methods: ['GET'], frame: true, handler: () => captchaFrameResponse() },
      { path: ROUTE_PATHS.loginState, methods: ['GET'], handler: () => this.routeLoginState() },
      { path: ROUTE_PATHS.loginCancel, methods: ['POST'], handler: (request) => this.routeLoginCancel(request) },
      { path: ROUTE_PATHS.logout, methods: ['POST'], handler: (request) => this.routeLogout(request) },
      { path: ROUTE_PATHS.checkin, methods: ['POST'], handler: (request) => this.routeCheckin(request) },
      { path: ROUTE_PATHS.refresh, methods: ['POST'], handler: (request) => this.routeRefresh(request) },
      { path: ROUTE_PATHS.verify, methods: ['POST'], handler: (request) => this.routeVerify(request) },
    ]
    for (const route of routes) {
      const dispose = this.ctx.connection.fetch.register({
        path: route.path,
        methods: route.methods,
        requestBody: route.path.startsWith(`${ROUTE_PREFIX}/login/`) && route.methods.includes('POST') ? 'streaming' : 'buffered',
        fetch: (request) => this.guard(route.handler, request, route.frame === true),
      })
      this.disposers.push(dispose)
    }
  }

  /** Wrap one handler: JSON errors instead of a broken response. */
  async guard(handler, request, frame = false) {
    try {
      const result = await handler(request)
      if (frame && result instanceof Response) return result
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
      checkinProtocol: 1,
      configRevision: this.configRevision,
      accountRevision: this.accountRevision,
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
        capability: communityCapability(this.state.auth),
        running: this.runPromise !== null && ['community', 'combined'].includes(this.runningScope),
        lastResult: runtime.community.lastResult,
        lastError: runtime.community.lastError,
        uncertainAttempt: this.currentCommunityUncertainty(communityCapability(this.state.auth).accountId, communityDay(nowStamp())),
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
    const body = await readJsonBody(request).catch(() => null)
    if (!isObject(body) || Object.keys(body).length !== 2 || !isObject(body.config) || !isRevision(body.configRevision)) {
      return failure('bad-request', '配置格式不正确')
    }
    if (body.configRevision !== this.configRevision) return failure('config-conflict', '设置已在其他面板变更，请查看最新设置后重新应用')
    const patch = body.config
    if (Object.hasOwn(patch, 'community') && (!isObject(patch.community)
      || (Object.hasOwn(patch.community, 'client') && !isObject(patch.community.client)))) {
      return failure('bad-request', '配置格式不正确')
    }
    const merged = { ...this.config, ...patch }
    if (patch.community && typeof patch.community === 'object' && !Array.isArray(patch.community)) {
      if (Object.hasOwn(patch.community, 'gids')) return failure('bad-request', '社区签到仅支持大别野，不能设置分区名单')
      merged.community = { ...this.config.community, ...patch.community }
      if (patch.community.client && typeof patch.community.client === 'object' && !Array.isArray(patch.community.client)) {
        merged.community.client = { ...this.config.community.client, ...patch.community.client }
      }
    }
    const config = normalizeConfig(merged)
    if (!this.store.commit({ config })) return failure('save-failed', '设置未能保存到磁盘，请检查后重新应用')
    this.config = config
    this.configRevision = randomUUID()
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
    const cookies = v2SessionCookies({ aid, mid, stoken, ltoken, cookieToken })
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
    const community = this.state.runtime.community
    const accountId = communityCapability(auth).accountId
    const uncertainAttempt = this.currentCommunityUncertainty(accountId, communityDay(nowStamp()))
    this.authGeneration++
    this.accountRevision = randomUUID()
    this.store.setAuth(auth)
    this.clearAccountRuntime(uncertainAttempt ? { accountId: community.accountId, uncertainAttempt } : {})
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
    this.accountRevision = randomUUID()
    this.loginEpoch += 1
    this.sms.cancel()
    this.store.setAuth(null)
    this.clearAccountRuntime()
    this.scheduler.refresh()
    this.log('info', hadAuth ? '已删除登录凭据' : '当前没有登录凭据可删除')
    return { ok: true, status: this.statusPayload() }
  }

  // ------------------------------------------------------------- actions

  async routeCheckin(request) {
    const body = await readJsonBody(request).catch(() => null)
    if (!isObject(body) || Object.keys(body).length !== 3 || !isRevision(body.accountRevision)
      || !Array.isArray(body.gameIds) || typeof body.dabieye !== 'boolean'
      || !body.gameIds.every((id) => GAME_INDEX.has(id)) || new Set(body.gameIds).size !== body.gameIds.length) {
      return { ...failure('bad-request', '签到项目格式不正确'), started: false }
    }
    // Compare and register the run in the same synchronous turn. Only the
    // Host's saved targets determine execution and game order.
    if (body.accountRevision !== this.accountRevision) {
      return { ...failure('account-changed', '登录账号已变更，请刷新并确认后再试'), started: false }
    }
    const { gameIds, dabieye } = checkinTargets(this.config)
    const submitted = new Set(body.gameIds)
    if (dabieye !== body.dabieye || gameIds.length !== submitted.size || !gameIds.every((id) => submitted.has(id))) {
      return { ...failure('targets-changed', '已保存的签到项目已变更，请刷新后再试'), started: false }
    }
    return this.run('manual')
  }

  async routeRefresh(request, context) {
    await readJsonBody(request).catch(() => undefined)
    this.checkSession(context)
    const auth = this.state.auth
    if (auth === null) return failure('anonymous', '尚未登录')
    const result = await refreshCredentials({ config: this.config, deviceId: this.deviceId, cookies: auth.cookies, aid: auth.aid, mid: auth.mid })
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
      if (result.reason !== 'stoken-invalid') {
        this.log('warn', result.message)
        return failure('refresh-failed', result.message)
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

  clearAccountRuntime(community = {}) {
    this.store.patchRuntime({
      community: { ...emptyCommunityState(), ...community }, roles: null, lastError: null,
      lastResult: null, lastRunAt: null, lastRunDate: null, scheduleLastAttemptDate: null,
    })
  }

  patchCommunity(context, patch) {
    this.checkSession(context)
    this.store.patchRuntime({ community: { ...this.state.runtime.community, ...patch } })
  }

  currentCommunityUncertainty(accountId, day) {
    const community = this.state.runtime.community
    return accountId !== null && community.accountId === accountId && community.uncertainAttempt?.day === day
      ? community.uncertainAttempt : null
  }

  commitCommunity(context, patch) {
    this.checkSession(context)
    const runtime = this.state.runtime
    return this.store.commit({ runtime: { ...runtime, community: { ...runtime.community, ...patch } } })
  }

  async executeCommunity(context) {
    this.checkSession(context)
    const { config, auth, reason, accountId } = context
    const at = nowStamp()
    const day = dayKey(new Date(at), 'Asia/Shanghai')
    const { id: gid, label } = DABIEYE
    const scheduled = reason === 'schedule'
    if (scheduled && this.currentCommunityUncertainty(accountId, day)) return
    if (this.state.runtime.community.accountId !== accountId) {
      this.patchCommunity(context, { ...emptyCommunityState(), accountId })
    }
    let fatal = context.fatal ?? null
    const capability = communityCapability(auth)
    // Account points do not prove whether Dabieye was signed. Only CAPTCHA
    // from this informational query prevents the write.
    const queryBalance = async () => {
      const balance = await getCommunityBalance({ config, deviceId: this.deviceId, auth })
      this.checkSession(context)
      this.patchCommunity(context, balance.ok
        ? { balance: balance.snapshot, balanceError: null }
        : { balanceError: balance.error })
      if (balance.outcome === 'captcha') fatal = 'captcha'
    }
    if (fatal === null && capability.available && this.config.community.enabled) await queryBalance()
    this.checkSession(context)
    const dispatchAt = nowStamp()
    const requestDay = communityDay(dispatchAt)
    const earlier = this.currentCommunityUncertainty(accountId, requestDay)
    if (scheduled && earlier) return
    let signed
    if (fatal === 'captcha' || !this.config.community.enabled) {
      signed = { outcome: 'skipped', message: fatal === 'captcha' ? '检测到人工验证，已停止后续写入' : '社区签到已关闭，已停止后续写入' }
    } else if (!capability.available) {
      signed = { outcome: 'auth-unavailable', message: '社区凭据不完整，请使用短信登录' }
    } else if (this.state.runtime.community.signedDays[gid]?.day === requestDay) {
      signed = { outcome: 'cached-success', message: '本机已记录大别野今日接口接受签到' }
    } else if (!this.commitCommunity(context, { uncertainAttempt: earlier ?? { gid, day: requestDay, at: dispatchAt } })) {
      signed = { outcome: 'error', message: '无法保存签到尝试记录，未发送大别野签到请求', saveFailed: true }
    } else {
      // The persisted marker covers both an in-flight request and an unknown
      // result. A definitive rejection cannot resolve an earlier ambiguous write.
      signed = await signCommunity({ config, deviceId: this.deviceId, auth })
      this.checkSession(context)
      if (signed.outcome === 'success') {
        const success = { signedDays: { [gid]: { day: requestDay, at: nowStamp() } } }
        if (!this.commitCommunity(context, { ...success, uncertainAttempt: null })) this.patchCommunity(context, success)
      } else if (signed.outcome !== 'unknown' && !earlier) {
        this.commitCommunity(context, { uncertainAttempt: null })
      }
      if (signed.outcome === 'captcha') fatal = 'captcha'
    }
    const { saveFailed, ...outcome } = signed
    const result = { gid, label, day: requestDay, at: nowStamp(), ...outcome }
    if (fatal === null && capability.available && this.config.community.enabled) await queryBalance()
    const ok = fatal === null && ['success', 'cached-success'].includes(result.outcome)
    const uncertain = !ok && this.currentCommunityUncertainty(accountId, requestDay) !== null
    this.patchCommunity(context, {
      lastRunAt: at,
      lastResult: { at, finishedAt: nowStamp(), reason, day, gids: [gid], ok, results: [result] },
      lastError: ok ? null : {
        gid, code: fatal ?? (uncertain ? 'unknown' : saveFailed ? 'save-failed' : result.outcome), at: nowStamp(),
        message: fatal === 'captcha' ? '需要人工验证，已停止本轮后续签到'
          : uncertain ? '大别野签到结果不明，请先在米游社 App 核对' : result.message,
      },
    })
    this.log(ok ? 'info' : 'warn', ok ? '社区签到结束：接口已接受大别野签到（积分到账未独立验证）' : '社区签到结束：大别野签到未完成，请查看社区结果')
  }

  // ---------------------------------------------------------------- run

  /** Start a run for the saved targets. The browser polls status. */
  run(reason) {
    if (reason === 'schedule') return this.runScheduled()
    const context = this.sessionContext(reason)
    const { gameIds, dabieye } = checkinTargets(context.config)
    return this.startCheckin(context, { games: gameIds.length > 0, community: dabieye })
  }

  policyInput(config = this.config) {
    return { config, runtime: this.state.runtime, accountId: communityCapability(this.state.auth).accountId, now: new Date(nowStamp()) }
  }

  hasAutomaticTargets() {
    const { gameIds, dabieye } = checkinTargets(this.config)
    return gameIds.length > 0 || dabieye
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
    const { gameIds, dabieye } = checkinTargets(context.config)
    return this.startCheckin(context, { games: gameIds.length > 0 && !completed.games, community: dabieye && !completed.community })
  }

  startCheckin(context, { games, community }) {
    if (this.runPromise !== null) return { ...failure('busy', '已有签到任务在进行中'), started: false }
    if (!games && !community) return { ...failure('no-targets', '没有启用的签到项目'), started: false }
    if (!this.isCurrentSession(context)) return { ...failure('session-changed', '登录会话已变更，请重新操作'), started: false }
    if (context.auth === null) return { ...failure('anonymous', '请先短信登录'), started: false }
    this.runningScope = games && community ? 'combined' : community ? 'community' : 'game'
    let activeScope = games ? 'game' : 'community'
    // Defer dispatch until after the shared lock has been assigned.
    const execution = Promise.resolve().then(() => withRequestGuard(() => this.isCurrentSession(context), async () => {
      this.checkSession(context)
      const gameResult = games ? await this.executeRun(context) : null
      this.checkSession(context)
      if (community) {
        activeScope = 'community'
        await this.executeCommunity({ ...context, fatal: gameResult?.fatal === 'captcha' ? 'captcha' : null })
      }
    })).catch(() => {
      if (!this.isCurrentSession(context)) return
      if (activeScope === 'community') {
        this.patchCommunity(context, { lastError: { gid: DABIEYE.id, code: 'unknown', message: '社区任务未完成，请检查本轮结果后手动重试', at: nowStamp() } })
      } else if (context.reason === 'schedule') {
        this.store.patchRuntime({ lastError: { code: 'unknown', message: '自动签到未完成，请查看分范围结果', at: nowStamp() } })
      } else {
        const message = '签到请求失败，请稍后重试'
        this.store.patchRuntime({ lastError: { code: 'RUN_FAILED', message, at: nowStamp() } })
        this.log('error', `签到任务异常：${message}`)
      }
    }).finally(() => {
      if (this.runPromise !== execution) return
      this.runPromise = null
      this.runningScope = null
      if (!this.disposed) this.scheduler.refresh()
    })
    this.runPromise = execution
    return { ok: true, started: true }
  }

  async executeRun(context) {
    const { reason, config } = context
    const startedAt = nowStamp()
    const today = dayKey(new Date(startedAt), config.timezone)
    const targets = enabledGames(config)

    this.log('info', `${reason === 'manual' ? '手动' : '定时'}签到开始，目标：${targets.map((game) => game.label).join('、')}`)
    const results = []
    let fatal = null
    let refreshed = false

    for (const game of targets) {
      this.checkSession(context)
      const auth = context.auth
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
          const refreshedAuth = await refreshCredentials({ config: context.config, deviceId: this.deviceId, cookies: auth.cookies, aid: auth.aid, mid: auth.mid })
          this.checkSession(context)
          if (refreshedAuth.ok === true) {
            context.auth = { ...auth, cookies: refreshedAuth.cookies, lastRefreshAt: nowStamp() }
            this.store.setAuth({ ...this.state.auth, cookies: context.auth.cookies, lastRefreshAt: context.auth.lastRefreshAt })
            refreshed = true
            this.log('info', '登录凭据已自动续期，重试签到')
            signed = await this.signWithRetry(context.auth, game, role, context)
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
    // Legacy display field only; automatic opportunities use the scope policy.
    if (ok && reason !== 'schedule') patch.lastRunDate = today
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
