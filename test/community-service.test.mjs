import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MysService } from '../lib/service.js'
import { normalizeConfig } from '../lib/config.js'

const request = (route = 'logout', body = {}) => new Request(`http://owner.invalid/api/mys/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const reply = (body) => new Response(JSON.stringify(body), { status: 200 })
const balancePath = '/apihub/wapi/getUserMissionsState'
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
function syntheticAuth(id = '123') {
  return { aid: id, stuid: id, mid: 'secret-mid', accountName: 'Synthetic account', cookies: { stuid: id, ltuid: id, ltoken: 'secret-ltoken', stoken: 'v2_secret-stoken', mid: 'secret-mid' } }
}
function setup(t, handler = () => undefined) {
  const oldHome = process.env.DSH_HOME
  const original = globalThis.fetch
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mys-community-service-'))
  const calls = [], unexpected = [], routes = new Map()
  globalThis.fetch = async (url, init) => {
    const call = { url, init, pathname: new URL(url).pathname }
    calls.push(call)
    const custom = await handler(call)
    if (custom !== undefined) return custom
    if (call.pathname === '/apihub/wapi/getUserMissionsState') return reply({ retcode: 0, data: { total_points: 123, already_received_points: 30, can_get_points: 0, states: [{ mission_id: 58, is_get_award: true }] } })
    if (call.pathname === '/apihub/app/api/signIn') return reply({ retcode: 0 })
    if (call.pathname.endsWith('/binding/api/getUserGameRolesByCookie')) return reply({ retcode: 0, data: { list: [{ game_uid: '100000001', region: 'cn_gf01', nickname: 'Synthetic role' }] } })
    if (call.pathname === '/event/luna/hk4e/info') return reply({ retcode: 0, data: { is_sign: false } })
    if (call.pathname === '/event/luna/hk4e/sign') return reply({ retcode: 0, data: {} })
    unexpected.push(url)
    throw new Error('Unmatched fake request; real network is forbidden')
  }
  const service = new MysService({
    logger: () => ({ info() {}, warn() {}, error() {} }),
    timeout: () => () => {},
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } },
  })
  service.config = normalizeConfig({ enabled: false, community: { enabled: true }, games: { genshin: false, starrail: false, zzz: false, honkai3: false, tears: false, bh2: false } })
  // No wall-clock waits in unit tests; normalization's public clamp has separate coverage.
  service.config.gapMs = { min: 0, max: 0 }
  service.store.setConfig(service.config)
  service.store.setAuth(syntheticAuth())
  t.after(async () => {
    if (service.runPromise) await service.runPromise
    service.dispose()
    globalThis.fetch = original
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    assert.deepEqual(unexpected, [], 'every outbound request must match the offline fake')
  })
  return { service, calls, routes, posts: () => calls.filter((call) => call.pathname === '/apihub/app/api/signIn') }
}
async function finish(service) { const promise = service.runPromise; assert.ok(promise); await promise }

test('manual community route runs with all games off, preserves other scopes, caches individual gids', async (t) => {
  const { service, posts, routes } = setup(t)
  assert.deepEqual(routes.get('/api/mys/community/run')?.methods, ['POST'])
  const old = { lastResult: { synthetic: true }, lastError: { code: 'SYNTHETIC' }, lastRunDate: '2026-01-01', scheduleLastAttemptDate: '2026-01-02' }
  service.store.patchRuntime(old)
  assert.equal((await service.routeCommunityRun(request('community/run'))).started, true)
  await finish(service)
  assert.deepEqual(posts().map(({ init }) => JSON.parse(init.body).gids), ['5', '2'])
  for (const [key, value] of Object.entries(old)) assert.deepEqual(service.state.runtime[key], value)
  assert.equal(service.statusPayload().community.lastResult.ok, true)
  assert.equal(service.state.runtime.community.accountId, '123')
  service.runCommunity(); await finish(service)
  assert.equal(posts().length, 2)
  assert.deepEqual(service.state.runtime.community.lastResult.results.map((r) => r.outcome), ['cached-success', 'cached-success'])
  service.config.community.gids.push('6')
  service.runCommunity(); await finish(service)
  assert.deepEqual(posts().map(({ init }) => JSON.parse(init.body).gids), ['5', '2', '6'])
})

test('partial community config updates preserve saved selection and independent protocol overrides, including explicit empty gids', async (t) => {
  const { service } = setup(t)
  service.config.community = { enabled: true, gids: ['6'], client: { appVersion: '9.8.7', salt: 'synthetic-salt' } }
  await service.routeConfig(request('config', { community: { enabled: false } }))
  assert.deepEqual(service.config.community, { enabled: false, gids: ['6'], client: { appVersion: '9.8.7', salt: 'synthetic-salt' } })
  await service.routeConfig(request('config', { community: { gids: [], client: { salt: 'new-synthetic-salt' } } }))
  assert.deepEqual(service.config.community, { enabled: false, gids: [], client: { appVersion: '9.8.7', salt: 'new-synthetic-salt' } })
})

test('partial failure and ambiguous writes stay distinct; account mission 58 does not skip gids', async (t) => {
  const { service, posts } = setup(t, ({ pathname, init }) => {
    if (pathname === '/apihub/app/api/signIn' && JSON.parse(init.body).gids === '2') return reply({ retcode: -5003, message: 'already signed' })
  })
  service.runCommunity(); await finish(service)
  assert.deepEqual(service.state.runtime.community.lastResult.results.map((r) => r.outcome), ['success', 'error'])
  assert.equal(service.state.runtime.community.lastResult.ok, false)
  assert.equal(posts().length, 2)
})

test('lost POST response is unknown once, with no secret/URL reflected in community status or logs', async (t) => {
  const { service, posts } = setup(t, ({ pathname }) => {
    if (pathname === '/apihub/app/api/signIn') throw new Error('https://fake.invalid/?stoken=secret-stoken&mid=secret-mid')
  })
  service.config.community.gids = ['5']
  service.runCommunity(); await finish(service)
  assert.equal(posts().length, 1)
  assert.equal(service.state.runtime.community.lastResult.results[0].outcome, 'unknown')
  assert.doesNotMatch(JSON.stringify(service.statusPayload()), /secret-stoken|secret-mid|secret-ltoken|https:\/\/fake/)
})

test('balance failure is independent, while CAPTCHA in either query or sign blocks later writes', async (t) => {
  let mode = 'balance-error'
  const { service, posts } = setup(t, ({ pathname }) => {
    if (pathname === '/apihub/wapi/getUserMissionsState') return reply({ retcode: mode === 'query-captcha' ? 1034 : -1 })
    if (pathname === '/apihub/app/api/signIn' && mode === 'sign-captcha') return reply({ retcode: 1034 })
  })
  service.runCommunity(); await finish(service)
  assert.equal(posts().length, 2)
  assert.equal(service.state.runtime.community.lastResult.ok, true)
  assert.ok(service.state.runtime.community.balanceError)
  service.state.runtime.community.signedDays = {}
  mode = 'query-captcha'
  service.runCommunity(); await finish(service)
  assert.equal(posts().length, 2)
  assert.equal(service.state.runtime.community.lastResult.ok, false)
  mode = 'sign-captcha'
  service.runCommunity(); await finish(service)
  assert.equal(posts().length, 3)
  assert.deepEqual(service.state.runtime.community.lastResult.results.map((r) => r.outcome), ['captcha', 'skipped'])
})

test('community expiration never invalidates the shared game login', async (t) => {
  const { service } = setup(t, ({ pathname }) => pathname === '/apihub/app/api/signIn' ? reply({ retcode: -100 }) : undefined)
  service.config.community.gids = ['5']
  const auth = structuredClone(service.state.auth)
  service.runCommunity(); await finish(service)
  assert.equal(service.state.runtime.community.lastResult.results[0].outcome, 'expired')
  assert.deepEqual(service.state.auth, auth)
  assert.equal(service.accountSummary().state, 'active')
  assert.equal(service.state.runtime.lastError, null)
})

test('server enforces disabled/empty/capability guards and uses the same execution lock as games', async (t) => {
  const { service, calls } = setup(t)
  service.config.community.enabled = false
  assert.equal(service.runCommunity().error.code, 'community-disabled')
  service.config.community.enabled = true
  service.config.community.gids = []
  assert.equal(service.runCommunity().error.code, 'community-empty')
  service.config.community.gids = ['5']
  delete service.state.auth.cookies.stoken
  assert.equal(service.runCommunity().error.code, 'auth-unavailable')
  assert.equal(service.accountSummary().state, 'active')
  service.state.auth.cookies.stoken = 'v2_secret-stoken'
  delete service.state.auth.mid; delete service.state.auth.cookies.mid
  assert.equal(service.statusPayload().community.capability.reason, 'missing-mid')
  assert.equal(service.runCommunity().error.code, 'auth-unavailable')
  service.state.auth.mid = 'secret-mid'
  service.runPromise = Promise.resolve()
  assert.equal(service.runCommunity().error.code, 'busy')
  assert.equal(service.run('manual').error.code, 'busy')
  service.runPromise = null
  assert.equal(calls.length, 0)
})

test('logout during a POST discards old results, stops following requests, and clears account markers', async (t) => {
  const entered = deferred(), release = deferred()
  const { service, calls } = setup(t, async ({ pathname }) => {
    if (pathname === '/apihub/app/api/signIn') { entered.resolve(); await release.promise; return reply({ retcode: 0 }) }
  })
  service.runCommunity()
  await entered.promise
  const done = service.runPromise
  const generation = service.authGeneration
  try {
    await service.routeLogout(request())
    assert.ok(service.authGeneration > generation)
  } finally { release.resolve() }
  await done
  assert.equal(service.state.auth, null)
  assert.equal(service.state.runtime.community.lastResult, null)
  assert.equal(service.state.runtime.lastRunDate, null)
  assert.equal(service.state.runtime.scheduleLastAttemptDate, null)
  assert.equal(calls.length, 2)
})

test('closing community while first request is in flight prevents subsequent gid writes', async (t) => {
  const entered = deferred(), release = deferred()
  const { service, posts } = setup(t, async ({ pathname }) => {
    if (pathname === '/apihub/app/api/signIn') { entered.resolve(); await release.promise; return reply({ retcode: 0 }) }
  })
  service.runCommunity(); await entered.promise
  service.config.community.enabled = false
  release.resolve(); await finish(service)
  assert.equal(posts().length, 1)
  assert.equal(service.state.runtime.community.lastResult.results[1].outcome, 'skipped')
})

test('late role lookup cannot write a cache or send a game sign after logout', async (t) => {
  const entered = deferred(), release = deferred()
  const { service, calls } = setup(t, async ({ pathname }) => {
    if (pathname.endsWith('/binding/api/getUserGameRolesByCookie')) { entered.resolve(); await release.promise; return reply({ retcode: 0, data: { list: [{ game_uid: '100000001', region: 'cn_gf01' }] } }) }
  })
  service.config.games.genshin = true
  service.run('manual'); await entered.promise
  const done = service.runPromise
  await service.routeLogout(request()); release.resolve(); await done
  assert.equal(calls.length, 1)
  assert.equal(service.state.runtime.roles, null)
  assert.equal(service.state.runtime.lastResult, null)
})

test('logout while refreshing prevents the second token request and resurrection of credentials', async (t) => {
  const entered = deferred(), release = deferred()
  const { service, calls } = setup(t, async ({ pathname }) => {
    if (pathname.endsWith('/getCookieAccountInfoBySToken')) { entered.resolve(); await release.promise; return reply({ retcode: 0, data: { cookie_token: 'secret-new-cookie' } }) }
  })
  const refreshing = service.routeRefresh(request('refresh')); await entered.promise
  await service.routeLogout(request()); release.resolve(); await refreshing
  assert.equal(service.state.auth, null)
  assert.equal(calls.length, 1)
  assert.equal(service.state.runtime.lastError, null)
})

test('normal token refresh keeps the same generation and cannot clear community-specific state', async (t) => {
  const { service } = setup(t, ({ pathname }) => {
    if (pathname.endsWith('/getCookieAccountInfoBySToken')) return reply({ retcode: 0, data: { cookie_token: 'synthetic-cookie' } })
    if (pathname.endsWith('/getLTokenBySToken')) return reply({ retcode: 0, data: { ltoken: 'synthetic-ltoken' } })
  })
  const generation = service.authGeneration
  service.state.runtime.community.lastError = { code: 'expired', message: 'Synthetic community expiry' }
  assert.equal((await service.routeRefresh(request('refresh'))).ok, true)
  assert.equal(service.authGeneration, generation)
  assert.equal(service.state.runtime.community.lastError.code, 'expired')
})

test('game automatic refresh cannot resurrect old credentials or dispatch its second exchange after logout', async (t) => {
  const entered = deferred(), release = deferred()
  const { service, calls } = setup(t, async ({ pathname }) => {
    if (pathname === '/event/luna/hk4e/sign') return reply({ retcode: -100 })
    if (pathname.endsWith('/getCookieAccountInfoBySToken')) { entered.resolve(); await release.promise; return reply({ retcode: 0, data: { cookie_token: 'synthetic-stale-cookie' } }) }
  })
  service.config.games.genshin = true
  service.run('manual'); await entered.promise
  const done = service.runPromise
  await service.routeLogout(request()); release.resolve(); await done
  assert.equal(service.state.auth, null)
  assert.equal(service.state.runtime.lastResult, null)
  assert.equal(service.state.runtime.lastError, null)
  assert.equal(calls.some(({ pathname }) => pathname.endsWith('/getLTokenBySToken')), false)
  assert.equal(calls.filter(({ pathname }) => pathname === '/event/luna/hk4e/sign').length, 1)
})

function smsReply(call, id = '123') {
  if (call.pathname.endsWith('/createLoginCaptcha')) return reply({ retcode: 0, data: { action_type: 'login', countdown: 60 } })
  if (call.pathname.endsWith('/loginByMobileCaptcha')) return reply({ retcode: 0, data: { token: { token_type: 1, token: 'v2_secret-stoken' }, user_info: { aid: id, mid: 'secret-mid' } } })
  if (call.pathname.endsWith('/getLTokenBySToken')) return reply({ retcode: 0, data: { ltoken: 'v2_secret-ltoken' } })
  if (call.pathname.endsWith('/getCookieAccountInfoBySToken')) return reply({ retcode: 0, data: { uid: id, cookie_token: 'v2_secret-cookie' } })
  if (call.pathname === '/user/api/getUserFullInfo') return reply({ retcode: 0, data: { user: { user_info: { nickname: 'Synthetic login' } } } })
}
async function smsStart(service) {
  const start = await service.routeLoginStart(request('login/start', { phone: '13800138000' }))
  const flowId = start.flow.flowId
  assert.equal((await service.routeLoginSend(request('login/send', { flowId }))).ok, true)
  return flowId
}
for (const id of ['123', '456']) test(`new SMS login for ${id} invalidates old in-flight writes even on same-account login`, async (t) => {
  const entered = deferred(), release = deferred()
  const { service, posts } = setup(t, async (call) => {
    if (call.pathname === '/apihub/app/api/signIn') { entered.resolve(); await release.promise; return reply({ retcode: 0 }) }
    return smsReply(call, id)
  })
  service.runCommunity(); await entered.promise
  const done = service.runPromise, generation = service.authGeneration
  try {
    const confirmation = await service.routeLoginSubmit(request('login/submit', { flowId: await smsStart(service), code: '123456' }))
    assert.equal(confirmation.state, 'confirmed')
    assert.ok(service.authGeneration > generation)
  } finally { release.resolve() }
  await done
  assert.equal(service.state.auth.aid, id)
  assert.equal(service.state.runtime.community.lastResult, null)
  assert.deepEqual(service.state.runtime.community.signedDays, {})
  assert.equal(posts().length, 1)
})

test('old SMS confirmation cannot win while a new start request body is still being read', async (t) => {
  const queried = deferred(), queryRelease = deferred(), bodyEntered = deferred(), bodyRelease = deferred()
  const { service } = setup(t, async (call) => {
    if (call.pathname.endsWith('/loginByMobileCaptcha')) { queried.resolve(); await queryRelease.promise }
    return smsReply(call)
  })
  service.store.setAuth(null)
  const flowId = await smsStart(service)
  const confirming = service.routeLoginSubmit(request('login/submit', { flowId, code: '123456' }))
  await queried.promise
  const replacing = service.routeLoginStart(new Request('http://owner.invalid/api/mys/login/start', {
    method: 'POST', headers: { 'content-type': 'application/json' }, duplex: 'half',
    body: new ReadableStream({ async start(controller) { bodyEntered.resolve(); await bodyRelease.promise; controller.enqueue(new TextEncoder().encode(JSON.stringify({ phone: '13900139000' }))); controller.close() } }),
  }))
  await bodyEntered.promise
  // Once the authorized new start has entered, its old confirmation must lose.
  try {
    queryRelease.resolve()
    const old = await confirming
    assert.equal(old.ok, false)
    assert.equal(service.state.auth, null)
  } finally { queryRelease.resolve(); bodyRelease.resolve(); await replacing }
})

test('community run queries one account snapshot before and after writes, without attributing points', async (t) => {
  const { service, calls } = setup(t)
  service.runCommunity(); await finish(service)
  assert.deepEqual(calls.map(({ pathname }) => pathname), [balancePath, '/apihub/app/api/signIn', '/apihub/app/api/signIn', balancePath])
})

test('schedule can run community with all games off, consumes one actual attempt even on partial failure', async (t) => {
  const { service, posts } = setup(t, ({ pathname, init }) => pathname === '/apihub/app/api/signIn' ? reply({ retcode: JSON.parse(init.body).gids === '5' ? 0 : -5003 }) : undefined)
  service.config.enabled = true
  assert.equal(service.run('schedule').started, true); await finish(service)
  assert.equal(posts().length, 2)
  assert.equal(service.state.runtime.community.lastResult.reason, 'schedule')
  assert.equal(service.state.runtime.community.lastResult.ok, false)
  assert.equal(service.state.runtime.scheduleLastAttemptDate, service.state.runtime.community.lastResult.day)
  assert.equal(service.state.runtime.lastResult, null)
  assert.equal(service.run('schedule').started, false)
  assert.equal(posts().length, 2)
})

test('busy schedule does not consume automatic opportunity; releasing the shared lock replans', async (t) => {
  const entered = deferred(), release = deferred()
  const { service } = setup(t, async ({ pathname }) => {
    if (pathname === '/apihub/app/api/signIn') { entered.resolve(); await release.promise; return reply({ retcode: 0 }) }
  })
  service.config.enabled = true
  service.config.games.genshin = true
  service.runCommunity(); await entered.promise
  const done = service.runPromise
  try {
    assert.equal(service.run('schedule').error.code, 'busy')
    assert.equal(service.state.runtime.scheduleLastAttemptDate, null)
  } finally { release.resolve(); await done }
  assert.ok(service.scheduler.getPlan())
  assert.equal(service.run('schedule').started, true); await finish(service)
  assert.ok(service.state.runtime.scheduleLastAttemptDate)
})

test('anonymous automatic skip consumes an attempt while no targets schedules nothing', async (t) => {
  const { service, calls } = setup(t)
  service.config.enabled = true
  service.store.setAuth(null)
  assert.equal(service.run('schedule').started, false)
  assert.ok(service.state.runtime.scheduleLastAttemptDate)
  assert.equal(calls.length, 0)
  service.config.community.enabled = false
  service.scheduler.refresh()
  assert.equal(service.scheduler.getPlan(), null)
})

for (const captcha of [false, true]) test(`combined run preserves independent scopes and applies global CAPTCHA stop=${captcha}`, async (t) => {
  const { service, posts, calls } = setup(t, ({ pathname }) => pathname === '/event/luna/hk4e/sign' ? reply({ retcode: captcha ? 1034 : 999 }) : undefined)
  service.config.enabled = true
  service.config.games.genshin = true
  if (captcha) service.config.games.starrail = true
  service.run('schedule'); await finish(service)
  assert.equal(service.state.runtime.lastResult.ok, false)
  if (captcha) assert.equal(service.state.runtime.lastResult.results.find((item) => item.game === 'starrail').outcome, 'skipped')
  assert.equal(service.state.runtime.community.lastResult.ok, !captcha)
  assert.equal(posts().length, captcha ? 0 : 2)
  if (captcha) {
    assert.deepEqual(service.state.runtime.community.lastResult.results.map((item) => item.outcome), ['skipped', 'skipped'])
    assert.equal(calls.some(({ pathname }) => pathname === '/apihub/app/api/signIn'), false)
  }
})

for (const target of ['getCookieAccountInfoBySToken', 'getLTokenBySToken']) for (const retcode of [1034, -999]) {
  test(`game refresh CAPTCHA ${retcode} at ${target} stops remaining exchanges and all later writes`, async (t) => {
    const { service, posts, calls } = setup(t, ({ pathname }) => {
      if (pathname === '/event/luna/hk4e/sign') return reply({ retcode: -100 })
      if (pathname.endsWith(target)) return reply({ retcode, message: 'secret-stoken https://secret.invalid' })
      if (pathname.endsWith('getCookieAccountInfoBySToken')) return reply({ retcode: 0, data: { cookie_token: 'synthetic-derived-token' } })
      if (pathname.endsWith('getLTokenBySToken')) return reply({ retcode: 0, data: { ltoken: 'synthetic-derived-ltoken' } })
    })
    service.config.enabled = true
    service.config.games.genshin = true
    service.config.games.starrail = true
    const originalAuth = structuredClone(service.state.auth)
    service.run('schedule'); await finish(service)
    assert.equal(service.state.runtime.lastResult.results[0].outcome, 'captcha')
    assert.equal(service.state.runtime.lastError.code, 'CAPTCHA')
    assert.equal(service.state.runtime.lastResult.results[1].outcome, 'skipped')
    assert.equal(posts().length, 0)
    assert.equal(calls.filter(({ pathname }) => pathname.endsWith('/sign')).length, 1)
    assert.equal(calls.filter(({ pathname }) => pathname.startsWith('/account/auth/')).length, target === 'getCookieAccountInfoBySToken' ? 1 : 2)
    assert.equal(calls.some(({ pathname }) => pathname === balancePath), false)
    assert.deepEqual(service.state.runtime.community.lastResult.results.map((item) => item.outcome), ['skipped', 'skipped'])
    assert.deepEqual(service.state.auth, originalAuth)
    assert.doesNotMatch(JSON.stringify(service.statusPayload()), /secret-stoken|secret\.invalid/)
  })
}

test('manual refresh CAPTCHA preserves auth and reports verification rather than expired SToken', async (t) => {
  const { service, calls } = setup(t, ({ pathname }) => pathname.endsWith('getCookieAccountInfoBySToken') ? reply({ retcode: 1034 }) : undefined)
  const originalAuth = structuredClone(service.state.auth)
  const result = await service.routeRefresh(request('refresh'))
  assert.equal(result.error?.code, 'captcha')
  assert.equal(service.state.runtime.lastError.code, 'CAPTCHA')
  assert.deepEqual(service.state.auth, originalAuth)
  assert.equal(calls.length, 1)
})

for (const target of ['/binding/api/getUserGameRolesByCookie', '/event/luna/hk4e/info']) test(`a game read CAPTCHA at ${target} stops remaining game and community writes`, async (t) => {
  const { service, posts, calls } = setup(t, ({ pathname }) => pathname === target ? reply({ retcode: 1034 }) : undefined)
  service.config.enabled = true
  service.config.games.genshin = true
  service.config.games.starrail = true
  service.config.retry.attempts = 1
  service.run('schedule'); await finish(service)
  assert.equal(calls.some(({ pathname }) => pathname.endsWith('/sign')), false)
  assert.equal(posts().length, 0)
  assert.equal(service.state.runtime.lastResult.results[0].outcome, 'captcha')
  assert.equal(service.state.runtime.community.lastResult.results[0].outcome, 'skipped')
})

test('unexpected community orchestration failure cannot replace the successful game banner or leak the cause', async (t) => {
  const { service } = setup(t)
  service.config.enabled = true
  service.config.games.genshin = true
  service.executeCommunity = async () => { throw new Error('https://secret.invalid/?stoken=secret-stoken') }
  service.run('schedule'); await finish(service)
  assert.equal(service.state.runtime.lastResult.ok, true)
  assert.equal(service.state.runtime.lastError, null)
  assert.equal(service.state.runtime.community.lastError.code, 'unknown')
  assert.doesNotMatch(JSON.stringify(service.statusPayload()), /secret-stoken|secret\.invalid/)
})

test('completed community history is not overwritten by an automatic game failure', async (t) => {
  const { service, posts } = setup(t, ({ pathname }) => pathname === '/event/luna/hk4e/sign' ? reply({ retcode: 999 }) : undefined)
  service.config.enabled = true
  service.config.games.genshin = true
  service.runCommunity(); await finish(service)
  const historical = structuredClone(service.state.runtime.community)
  assert.equal(service.run('schedule').started, true); await finish(service)
  assert.deepEqual(service.state.runtime.community, historical)
  assert.equal(service.state.runtime.lastResult.ok, false)
  assert.equal(posts().length, 2)
})

test('a completed game scope is preserved when automatic opportunity is only needed for community', async (t) => {
  const { service, calls } = setup(t)
  service.config.enabled = true
  service.config.games.genshin = true
  service.run('manual'); await finish(service)
  const historical = structuredClone(service.state.runtime.lastResult)
  assert.equal(service.run('schedule').started, true); await finish(service)
  assert.deepEqual(service.state.runtime.lastResult, historical)
  assert.equal(service.state.runtime.community.lastResult.ok, true)
  assert.equal(calls.filter(({ pathname }) => pathname === '/event/luna/hk4e/sign').length, 1)
})

test('community recalculates the Shanghai request day instead of persisting one run-wide day across midnight', async (t) => {
  const originalNow = Date.now
  let clock = new Date('2026-11-18T15:59:59Z').getTime()
  Date.now = () => clock
  t.after(() => { Date.now = originalNow })
  const { service } = setup(t, ({ pathname }) => {
    if (pathname === '/apihub/app/api/signIn') { clock = new Date('2026-11-18T16:00:01Z').getTime(); return reply({ retcode: 0 }) }
  })
  service.runCommunity(); await finish(service)
  assert.equal(service.state.runtime.community.signedDays['5'].day, '2026-11-18')
  assert.equal(service.state.runtime.community.signedDays['2'].day, '2026-11-19')
  assert.equal(service.state.runtime.community.balance.day, '2026-11-19')
})

test('a late profile response cannot repopulate an anonymous account', async (t) => {
  const entered = deferred(), release = deferred()
  const { service } = setup(t, async ({ pathname }) => {
    if (pathname === '/user/api/getUserFullInfo') { entered.resolve(); await release.promise; return reply({ retcode: 0, data: { user: { user_info: { nickname: 'Old account' } } } }) }
  })
  service.state.auth.accountName = null
  const profiling = service.enrichProfile(); await entered.promise
  await service.routeLogout(request()); release.resolve(); await profiling
  assert.equal(service.state.auth, null)
})
