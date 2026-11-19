import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MysService } from '../lib/service.js'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mys-test-'))

/** Each test gets its own DSH_HOME so no state leaks between them. */
function freshHome() {
  const directory = fs.mkdtempSync(path.join(ROOT, 'home-'))
  process.env.DSH_HOME = directory
  return directory
}

/** Minimal cordis host context: route capture, a logger, and unref'd timers. */
function createCtx() {
  const routes = new Map()
  return {
    routes,
    logger: Object.assign(() => ({ info() {}, warn() {}, error() {}, debug() {} }), {
      info() {},
      warn() {},
      error() {},
      debug() {},
    }),
    timeout: (fn, ms) => {
      const timer = setTimeout(fn, ms)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearTimeout(timer)
    },
    effect: (fn) => fn(),
    connection: {
      fetch: {
        register(route) {
          assert.equal(routes.has(route.path), false, `duplicate route ${route.path}`)
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
  }
}

function jsonResponse(body, extraHeaders = []) {
  const headers = new Headers([['content-type', 'application/json']])
  for (const [name, value] of extraHeaders) headers.append(name, value)
  return new Response(JSON.stringify(body), { status: 200, headers })
}

/** Offline official SMS/token/game fixtures; never contacts the network. */
function installFakeNetwork(options = {}) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body })
    if (url.includes('/createLoginCaptcha')) return jsonResponse({ retcode: options.sendFails ? -1 : 0, data: { action_type: 'login', countdown: 60 } })
    if (url.includes('/loginByMobileCaptcha')) return jsonResponse({ retcode: 0, data: { user_info: { aid: '100200300', mid: 'mid_9000' }, token: { token_type: 1, token: 'v2_stoken' } } })
    if (url.includes('/getUserMissionsState')) return jsonResponse({ retcode: 0, data: { states: [], total_points: 0, already_received_points: 0, can_get_points: 0 } })
    if (url.includes('/getCookieAccountInfoBySToken')) {
      return jsonResponse({ retcode: 0, message: 'ok', data: { uid: '100200300', cookie_token: options.v1Tokens === true ? 'v1_cookie' : 'v2_cookie' } })
    }
    if (url.includes('/getLTokenBySToken')) {
      return jsonResponse({ retcode: 0, message: 'ok', data: { ltoken: options.v1Tokens === true ? 'v1_ltoken' : 'v2_ltoken' } })
    }
    if (url.includes('/binding/api/getUserGameRolesByCookie')) {
      const biz = new URL(url).searchParams.get('game_biz')
      if (biz === 'hk4e_cn') {
        return jsonResponse({
          retcode: 0,
          message: 'ok',
          data: {
            list: [
              { game_uid: '100000001', region: 'cn_gf01', region_name: '天空岛', nickname: '旅行者', level: 60, game_biz: 'hk4e_cn' },
            ],
          },
        })
      }
      return jsonResponse({ retcode: 0, message: 'ok', data: { list: [] } })
    }
    if (url.includes('/user/api/getUserFullInfo')) {
      return jsonResponse({ retcode: 0, message: 'ok', data: { user: { user_info: { nickname: '米游社昵称', avatar_url: 'https://example.com/a.png' } } } })
    }
    if (url.includes('/event/luna/') && url.includes('/info?')) {
      return jsonResponse({ retcode: 0, message: 'ok', data: { is_sign: false, first_bind: false, total_sign_day: 1 } })
    }
    if (url.includes('/event/luna/') && url.endsWith('/sign')) {
      return jsonResponse({ retcode: 0, message: 'ok', data: { success: 0, awards: [{ name: '原石', cnt: 20 }] } })
    }
    return jsonResponse({ retcode: -1, message: `unexpected ${url}` })
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

const checkinRequest = (gameIds = ['genshin']) => new Request('http://x/api/mys/run/checkin', { method: 'POST', body: JSON.stringify({ gameIds, dabieye: false }) })
const loginRequest = (action, body) => new Request('http://x/api/mys/login/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
async function completeLogin(service) {
  const started = await service.routeLoginStart(loginRequest('start', { phone: '13800138000' }))
  assert.equal(started.ok, true)
  const flowId = started.flow.flowId
  assert.equal((await service.routeLoginSend(loginRequest('send', { flowId }))).ok, true)
  return { started, confirmed: await service.routeLoginSubmit(loginRequest('submit', { flowId, code: '123456' })) }
}

test('service wiring: routes, login, status', async (t) => {
  freshHome()
  const network = installFakeNetwork()
  t.after(() => network.restore())

  const ctx = createCtx()
  const service = new MysService(ctx, {})
  t.after(() => service.dispose())

  assert.deepEqual([...ctx.routes.keys()].sort(), [
    '/api/mys/config',
    '/api/mys/login/cancel',
    '/api/mys/login/captcha-frame',
    '/api/mys/login/challenge',
    '/api/mys/login/send',
    '/api/mys/login/start',
    '/api/mys/login/state',
    '/api/mys/login/submit',
    '/api/mys/logout',
    '/api/mys/refresh',
    '/api/mys/run/checkin',
    '/api/mys/status',
    '/api/mys/verify',
  ])

  const status = await service.routeStatus()
  assert.equal(status.ok, true)
  assert.equal(status.login.state, 'anonymous')
  assert.equal(status.games.length, 6)
  assert.equal(status.config.windows[0].start, '18:00')

  const { started, confirmed } = await completeLogin(service)
  assert.equal(started.flow.status, 'phone-ready')
  assert.equal(started.flow.phoneMasked, '138****8000')
  assert.equal(confirmed.state, 'confirmed')

  const after = await service.routeStatus()
  assert.equal(after.login.state, 'active')
  assert.ok(after.login.accountName === null || after.login.accountName === '米游社昵称')
  // The numeric miHoYo UID, never the opaque `mid`.
  assert.equal(after.login.uid, '100200300')
  assert.ok(after.login.avatar === null || after.login.avatar === 'https://example.com/a.png')
  assert.equal(after.login.hasStoken, true)
  // The wire payload must never carry the cookie itself.
  assert.equal(JSON.stringify(after).includes('v2_ltoken'), false)

  // Every outbound call must carry the signed header set.
  const signed = network.calls.filter((call) => call.url.includes('/event/luna/') || call.url.includes('/binding/'))
  for (const call of signed) {
    assert.match(call.headers.DS, /^\d{10},[A-Za-z0-9]{6},[0-9a-f]{32}$/)
    assert.equal(call.headers['x-rpc-client_type'], '5')
    assert.equal(call.headers['x-rpc-app_version'], '2.109.0')
    assert.match(call.headers.Cookie, /ltoken_v2=v2_ltoken/)
  }
})

test('SMS login exchanges the root token before accepting a validated session', async (t) => {
  freshHome()
  const network = installFakeNetwork({ stokenOnly: true })
  t.after(() => network.restore())

  const ctx = createCtx()
  const service = new MysService(ctx, {})
  t.after(() => service.dispose())

  const { confirmed } = await completeLogin(service)
  assert.equal(confirmed.state, 'confirmed')

  assert.equal(network.calls.some((call) => call.url.includes('/app/loginByMobileCaptcha')), true)
  assert.equal(network.calls.some((call) => call.url.includes('/getLTokenBySToken')), true)

  const after = await service.routeStatus()
  assert.equal(after.login.state, 'active')
  assert.equal(after.login.hasStoken, true)
  assert.notEqual(after.login.lastRefreshAt, null)
  assert.equal(service.state.auth.cookies.ltoken_v2, 'v2_ltoken')
  assert.equal(service.state.auth.cookies.cookie_token_v2, 'v2_cookie')
})

test('SMS login pairs a V1 ltoken with ltuid/account_id', async (t) => {
  freshHome()
  const network = installFakeNetwork({ stokenOnly: true, v1Tokens: true })
  t.after(() => network.restore())

  const ctx = createCtx()
  const service = new MysService(ctx, {})
  t.after(() => service.dispose())

  const { confirmed } = await completeLogin(service)
  assert.equal(confirmed.state, 'confirmed')

  const cookies = service.state.auth.cookies
  assert.equal(cookies.ltoken, 'v1_ltoken')
  assert.equal(cookies.cookie_token, 'v1_cookie')
  assert.equal(cookies.ltuid, '100200300')
  assert.equal(cookies.account_id, '100200300')

  // The verification call proves the V1 pair actually travels on the wire.
  const binding = network.calls.filter((call) => call.url.includes('/binding/api/getUserGameRolesByCookie')).at(-1)
  assert.match(binding.headers.Cookie, /ltuid=100200300/)
  assert.match(binding.headers.Cookie, /ltoken=v1_ltoken/)
})

test('failed SMS send does not silently choose another login channel or retry', async (t) => {
  freshHome()
  const network = installFakeNetwork({ sendFails: true })
  t.after(() => network.restore())
  const service = new MysService(createCtx(), {})
  t.after(() => service.dispose())
  const start = await service.routeLoginStart(loginRequest('start', { phone: '13800138000' }))
  const sent = await service.routeLoginSend(loginRequest('send', { flowId: start.flow.flowId }))
  assert.equal(sent.ok, false)
  assert.equal(network.calls.length, 1)
  assert.equal(service.state.auth, null)
})

test('service runs one check-in per enabled game and records the result', async (t) => {
  freshHome()
  const network = installFakeNetwork()
  t.after(() => network.restore())

  const ctx = createCtx()
  const service = new MysService(ctx, {})
  t.after(() => service.dispose())

  // One game only, and a short gap, keeps the test fast.
  service.config = {
    ...service.config,
    games: { genshin: true, starrail: false, zzz: false, honkai3: false, tears: false, bh2: false },
    gapMs: { min: 500, max: 500 },
  }
  service.store.setConfig(service.config)

  await completeLogin(service)

  const runResult = await ctx.routes.get('/api/mys/run/checkin').fetch(checkinRequest()).then((response) => response.json())
  assert.equal(runResult.started, true)
  await service.runPromise

  const status = await service.routeStatus()
  assert.equal(status.lastResult.ok, true)
  assert.equal(status.lastResult.results.length, 1)
  assert.equal(status.lastResult.results[0].outcome, 'signed')
  assert.equal(status.lastResult.results[0].game, 'genshin')
  assert.equal(status.lastResult.results[0].uid, '100000001')
  assert.equal(status.lastResult.results[0].totalDays, 2)
  assert.deepEqual(status.lastResult.results[0].awards, [{ name: '原石', cnt: 20 }])
  assert.notEqual(status.schedule.lastRunDate, null)
  assert.equal(status.lastError, null)

  // The binding query is cached for the day: a second run must not repeat it.
  const before = network.calls.filter((call) => call.url.includes('/binding/')).length
  await ctx.routes.get('/api/mys/run/checkin').fetch(checkinRequest()).then((response) => response.json())
  await service.runPromise
  const after = network.calls.filter((call) => call.url.includes('/binding/')).length
  assert.equal(after, before)
})

test('service refuses manual runs while anonymous and applies config updates', async (t) => {
  freshHome()
  const network = installFakeNetwork()
  t.after(() => network.restore())

  const ctx = createCtx()
  const service = new MysService(ctx, {})
  t.after(() => service.dispose())

  const refused = await ctx.routes.get('/api/mys/run/checkin').fetch(checkinRequest(['genshin', 'starrail', 'zzz', 'honkai3'])).then((response) => response.json())
  assert.equal(refused.started, false)
  assert.equal(refused.error.code, 'anonymous')

  const body = JSON.stringify({ config: { windows: [{ start: '09:00', end: '09:20' }], enabled: false } })
  const updated = await service.routeConfig(new Request('http://x/api/mys/config', { method: 'POST', body }))
  assert.equal(updated.ok, true)
  assert.equal(updated.config.windows[0].start, '09:00')
  assert.equal(updated.config.enabled, false)
  assert.equal(updated.status.schedule.targetAt, null)
})

test('expired session marks the banner and stops the run', async (t) => {
  freshHome()
  const network = installFakeNetwork()
  t.after(() => network.restore())

  const ctx = createCtx()
  const service = new MysService(ctx, {})
  t.after(() => service.dispose())

  await completeLogin(service)

  // Re-route the binding call to a login-expired answer.
  const base = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.includes('/binding/api/getUserGameRolesByCookie')) {
      return jsonResponse({ retcode: -100, message: '登录失效，请重新登录', data: null })
    }
    return base(input, init)
  }

  service.config = {
    ...service.config,
    games: { genshin: true, starrail: false, zzz: false, honkai3: false, tears: false, bh2: false },
  }
  service.store.setConfig(service.config)

  await ctx.routes.get('/api/mys/run/checkin').fetch(checkinRequest()).then((response) => response.json())
  await service.runPromise

  const status = await service.routeStatus()
  assert.equal(status.login.state, 'expired')
  assert.equal(status.lastError.code, 'LOGIN_EXPIRED')
  assert.equal(status.lastResult.ok, false)
  assert.equal(status.lastResult.results[0].outcome, 'expired')
})

test('stored 0.2.0 credentials get their missing V1 id aliases repaired on load', async (t) => {
  const home = freshHome()
  fs.mkdirSync(path.join(home, 'mys-checkin'), { recursive: true })
  fs.writeFileSync(path.join(home, 'mys-checkin', 'state.json'), JSON.stringify({
    version: 1,
    auth: {
      cookies: { stoken_v2: 'v2_s', ltoken: 'v1_l', ltuid_v2: '100200300', ltmid_v2: 'mid_9000' },
      mid: 'mid_9000',
      aid: '100200300',
      stuid: '100200300',
      accountName: 'veer',
      loginAt: 1,
      lastRefreshAt: null,
    },
    runtime: { lastError: { code: 'LOGIN_EXPIRED', message: 'stale -100', at: 1 }, log: [] },
  }))

  const ctx = createCtx()
  const service = new MysService(ctx, {})
  t.after(() => service.dispose())

  assert.equal(service.state.auth.cookies.ltuid, '100200300')
  assert.equal(service.state.auth.cookies.account_id, '100200300')
  // The -100 was caused by the missing alias, not by an expired session.
  assert.equal(service.state.runtime.lastError, null)
  assert.equal((await service.routeStatus()).login.state, 'active')
})

test('delete login clears the stored credentials', async (t) => {
  freshHome()
  const network = installFakeNetwork()
  t.after(() => network.restore())

  const ctx = createCtx()
  const service = new MysService(ctx, {})
  t.after(() => service.dispose())

  await completeLogin(service)
  assert.notEqual(service.state.auth, null)

  const deleted = await service.routeLogout(new Request('http://x/api/mys/logout', { method: 'POST', body: '{}' }))
  assert.equal(deleted.ok, true)
  assert.equal(service.state.auth, null)
  const status = await service.routeStatus()
  assert.equal(status.login.state, 'anonymous')
  assert.equal(status.login.hasStoken, false)
})
