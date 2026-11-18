import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MysService } from '../lib/service.js'

const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
const success = (data) => response({ retcode: 0, data })
const req = (action, body = {}, headers = {}) => new Request(`http://owner.invalid/api/mys/login/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const OLD = { aid: '123', stuid: '123', mid: 'old_mid', accountName: 'Existing', cookies: { ltoken: 'OLD_LTOKEN', cookie_token: 'OLD_COOKIE', stoken: 'OLD_STOKEN', stuid: '123', ltuid: '123', account_id: '123' } }
function setup(t, options = {}) {
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sms-service-'))
  const routes = new Map(), calls = [], original = globalThis.fetch
  const service = new MysService({ logger: () => ({ info() {}, warn() {} }), timeout: () => () => {}, connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } } })
  service.config.enabled = false
  service.config.community.enabled = options.community ?? true
  service.store.setAuth(structuredClone(OLD))
  service.store.patchRuntime({ lastResult: { marker: 'OLD_RUNTIME' } })
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input), call = { path: url.pathname, headers: init.headers, body: init.body }
    calls.push(call)
    const custom = await options.handle?.(call)
    if (custom) return custom
    if (url.pathname.endsWith('/createLoginCaptcha')) return success({ action_type: 'login', countdown: 60 })
    if (url.pathname.endsWith('/loginByMobileCaptcha')) return success({ token: { token_type: 1, token: 'NEW_STOKEN' }, user_info: { aid: '456', mid: 'NEW_MID' } })
    if (url.pathname.endsWith('/getLTokenBySToken')) return success({ ltoken: 'NEW_LTOKEN' })
    if (url.pathname.endsWith('/getCookieAccountInfoBySToken')) return success({ uid: '456', cookie_token: 'NEW_COOKIE' })
    if (url.pathname.endsWith('/getUserGameRolesByCookie')) return success({ list: [] })
    if (url.pathname.endsWith('/getUserMissionsState')) return success({ states: [], total_points: 100, already_received_points: 0, can_get_points: 90 })
    if (url.pathname.endsWith('/getUserFullInfo')) return success({ user: { user_info: { nickname: 'Cosmetic' } } })
    throw new Error(`Unexpected offline request ${url.pathname}`)
  }
  t.after(() => { service.dispose(); globalThis.fetch = original })
  return { service, routes, calls }
}
async function begin(service) {
  const start = await service.routeLoginStart(req('start', { phone: '13800138000' }))
  assert.equal(start.ok, true)
  assert.match(start.flow.flowId, /^[\w-]{36}$/)
  const flowId = start.flow.flowId
  const sent = await service.routeLoginSend(req('send', { flowId }))
  assert.equal(sent.ok, true)
  return flowId
}
async function complete(service) {
  return service.routeLoginSubmit(req('submit', { flowId: await begin(service), code: '123456' }))
}

test('SMS transport streams bounded bodies and accepts the admitted browser Host rather than the internal bridge URL', async (t) => {
  const { routes } = setup(t)
  const route = routes.get('/api/mys/login/start')
  assert.equal(route.requestBody, 'streaming')
  const browserRequest = (origin) => new Request('http://dsh.internal/api/mys/login/start', { method: 'POST', headers: { host: '127.0.0.1:52370', origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ phone: '13800138000' }) })
  assert.equal((await (await route.fetch(browserRequest('http://127.0.0.1:52370'))).json()).ok, true)
  assert.equal((await (await route.fetch(browserRequest('http://evil.invalid'))).json()).ok, false)
})

test('only the owner-registered CAPTCHA document route returns static HTML instead of a JSON envelope', async (t) => {
  const { routes, service, calls } = setup(t)
  const route = routes.get('/api/mys/login/captcha-frame')
  assert.ok(route)
  assert.deepEqual(route.methods, ['GET'])
  const result = await route.fetch(new Request('http://owner.invalid/api/mys/login/captcha-frame'))
  assert.match(result.headers.get('content-type'), /^text\/html/)
  assert.equal(result.headers.get('cache-control'), 'no-store')
  assert.match(await result.text(), /<!doctype html>/)
  assert.equal(calls.length, 0)
  const other = await service.guard(() => new Response('not the frame'), new Request('http://owner.invalid'))
  assert.match(other.headers.get('content-type'), /application\/json/)
})

test('SMS owner routes replace polling; read-only state never dispatches an official request', async (t) => {
  const { service, routes, calls } = setup(t)
  assert.equal(routes.has('/api/mys/login/poll'), false)
  for (const name of ['start', 'send', 'submit', 'challenge', 'cancel', 'state']) assert.equal(routes.has(`/api/mys/login/${name}`), true)
  const result = await service.routeLoginState()
  assert.deepEqual(result, { ok: true, flow: null })
  assert.equal(calls.length, 0)
})

test('valid candidate replaces auth and account runtime only after strict checks, with minimal community Cookie', async (t) => {
  const { service, calls } = setup(t)
  const result = await complete(service)
  assert.equal(result.ok, true)
  assert.equal(result.state, 'confirmed')
  assert.equal(service.state.auth.aid, '456')
  assert.equal(service.state.auth.cookies.ltoken, 'NEW_LTOKEN')
  assert.equal(service.state.auth.cookies.cookie_token, 'NEW_COOKIE')
  assert.equal(service.state.runtime.lastResult, null)
  assert.equal(service.statusPayload().loginFlow, null)
  const query = calls.find(c => c.path.endsWith('/getUserMissionsState'))
  assert.equal(query.headers.Cookie, 'account_id=456; cookie_token=NEW_COOKIE')
  assert.equal(calls.some(c => /\/sign(?:In)?$/.test(c.path)), false)
  const publicText = JSON.stringify(result)
  for (const secret of ['NEW_LTOKEN', 'NEW_COOKIE', 'NEW_STOKEN', 'NEW_MID', '13800138000', '123456', 'OLD_STOKEN']) assert.equal(publicText.includes(secret), false)
})

for (const [stage, bad] of [
  ['createLoginCaptcha', () => response({ retcode: -1 })],
  ['loginByMobileCaptcha', () => response({ retcode: -1, message: 'SECRET' })],
  ['getLTokenBySToken', () => success({ ltoken: '' })],
  ['getCookieAccountInfoBySToken', () => success({ uid: '999', cookie_token: 'NEW_COOKIE' })],
  ['getUserGameRolesByCookie', () => response({ retcode: -100 })],
  ['getUserGameRolesByCookie', () => success({})],
  ['getUserGameRolesByCookie', () => response({ retcode: 0, data: { list: [] } }, 500)],
  ['getUserMissionsState', () => response({ retcode: -100 })],
  ['getUserMissionsState', () => success({})],
  ['getUserGameRolesByCookie', () => success({ list: [], is_risk: true })],
  ['getUserGameRolesByCookie', () => success({ list: [], gt: 'challenge' })],
  ['getUserGameRolesByCookie', () => new Response(JSON.stringify({ retcode: 0, data: { list: [] } }), { headers: { 'x-rpc-aigis': 'challenge' } })],
  ['getUserMissionsState', () => new Response(JSON.stringify({ retcode: 0, data: { states: [], total_points: 0, already_received_points: 0, can_get_points: 0 } }), { headers: { 'x-rpc-aigis': 'challenge' } })],
]) test(`failure at ${stage} (${bad().status}) preserves old auth and runtime`, async (t) => {
  const { service } = setup(t, { handle: c => c.path.endsWith(`/${stage}`) ? bad() : null })
  const before = structuredClone(service.state.auth)
  const start = await service.routeLoginStart(req('start', { phone: '13800138000' }))
  assert.equal(start.ok, true)
  const flowId = start.flow.flowId
  const sent = await service.routeLoginSend(req('send', { flowId }))
  const result = sent.ok ? await service.routeLoginSubmit(req('submit', { flowId, code: '123456' })) : sent
  assert.equal(result.ok, false)
  assert.deepEqual(service.state.auth, before)
  assert.deepEqual(service.state.runtime.lastResult, { marker: 'OLD_RUNTIME' })
  assert.equal(JSON.stringify(result).includes('SECRET'), false)
})

test('disabled community is best effort and warns without rejecting a strictly valid game session', async (t) => {
  const { service } = setup(t, { community: false, handle: c => c.path.endsWith('/getUserMissionsState') ? response({ retcode: -100 }) : null })
  const result = await complete(service)
  assert.equal(result.ok, true)
  assert.match(result.warning, /社区.*未验证/)
  assert.equal(service.state.auth.aid, '456')
})

for (const action of ['cancel', 'logout', 'replace', 'dispose', 'expire']) test(`${action} during strict game validation cannot commit or issue a subsequent community request`, async (t) => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const { service, calls } = setup(t, { handle: async c => {
    if (c.path.endsWith('/getUserGameRolesByCookie')) { entered.resolve(); await release.promise; return success({ list: [] }) }
  } })
  const flowId = await begin(service)
  const submitting = service.routeLoginSubmit(req('submit', { flowId, code: '123456' }))
  await entered.promise
  if (action === 'cancel') await service.routeLoginCancel(req('cancel', { flowId }))
  if (action === 'logout') await service.routeLogout(req('logout'))
  if (action === 'replace') await service.routeLoginStart(req('start', { phone: '13900139000' }))
  if (action === 'dispose') service.dispose()
  if (action === 'expire') service.sms.now = () => Date.now() + 300001
  release.resolve()
  const result = await submitting
  assert.equal(result.ok, false)
  assert.equal(service.state.auth?.aid ?? null, action === 'logout' ? null : '123')
  assert.equal(calls.some(c => c.path.endsWith('/getUserMissionsState')), false)
})

for (const [headers, body] of [
  [{ origin: 'https://evil.invalid' }, { phone: '13800138000' }],
  [{ origin: 'null' }, { phone: '13800138000' }],
  [{ 'sec-fetch-site': 'cross-site' }, { phone: '13800138000' }],
  [{ 'content-type': 'text/plain' }, { phone: '13800138000' }],
  [{}, { phone: '13800138000', padding: 'x'.repeat(16384) }],
  [{}, []],
]) test(`SMS mutation rejects unsafe request ${JSON.stringify(headers)} size ${JSON.stringify(body).length}`, async (t) => {
  const { service, calls } = setup(t)
  const result = await service.routeLoginStart(req('start', body, headers))
  assert.equal(result.ok, false)
  assert.equal(service.statusPayload().loginFlow, null)
  assert.equal(calls.length, 0)
})

test('stale cancel cannot invalidate the newly created flow; same-origin and owner requests without Origin are allowed', async (t) => {
  const { service } = setup(t)
  const old = await service.routeLoginStart(req('start', { phone: '13800138000' }, { origin: 'http://owner.invalid' }))
  const current = await service.routeLoginStart(req('start', { phone: '13900139000' }))
  const canceled = await service.routeLoginCancel(req('cancel', { flowId: old.flow.flowId }))
  assert.equal(canceled.ok, false)
  assert.equal((await service.routeLoginState()).flow.flowId, current.flow.flowId)
})

test('wrong code preserves the old account and allows an explicit retry without another SMS', async (t) => {
  let attempts = 0
  const { service, calls } = setup(t, { handle: c => c.path.endsWith('/loginByMobileCaptcha') && attempts++ === 0 ? response({ retcode: -3202, message: 'SECRET' }) : null })
  const flowId = await begin(service)
  const wrong = await service.routeLoginSubmit(req('submit', { flowId, code: '000000' }))
  assert.equal(wrong.ok, false)
  assert.equal(wrong.error.code, 'sms-code-invalid')
  assert.equal(wrong.flow.status, 'code-sent')
  assert.deepEqual(service.state.auth, OLD)
  assert.deepEqual(service.state.runtime.lastResult, { marker: 'OLD_RUNTIME' })
  assert.equal(JSON.stringify(wrong).includes('SECRET'), false)
  const retried = await service.routeLoginSubmit(req('submit', { flowId, code: '123456' }))
  assert.equal(retried.state, 'confirmed')
  assert.equal(calls.filter(c => c.path.endsWith('/createLoginCaptcha')).length, 1)
})

test('unknown SMS POST outcome is not retried or disclosed; cooldown survives replacing the flow', async (t) => {
  const { service, calls } = setup(t, { handle: c => { if (c.path.endsWith('/createLoginCaptcha')) throw new Error('SECRET') } })
  const start = await service.routeLoginStart(req('start', { phone: '13800138000' }))
  const unknown = await service.routeLoginSend(req('send', { flowId: start.flow.flowId }))
  assert.equal(unknown.ok, false)
  assert.equal(JSON.stringify(unknown).includes('SECRET'), false)
  const next = await service.routeLoginStart(req('start', { phone: '13900139000' }))
  const limited = await service.routeLoginSend(req('send', { flowId: next.flow.flowId }))
  assert.equal(limited.error.code, 'sms-cooldown')
  assert.equal(calls.length, 1)
  assert.deepEqual(service.state.auth, OLD)
})
