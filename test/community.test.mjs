import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { normalizeConfig } from '../lib/config.js'
import { communityCapability, signCommunity, getCommunityBalance } from '../lib/community.js'

// Synthetic contract fixtures only — not real captured API responses.
const config = normalizeConfig({ community: { enabled: true } })
const auth = { aid: '123', mid: 'synthetic-mid', cookies: { stoken_v2: 'v2_synthetic-secret', ltoken: 'synthetic-ltoken', ltuid: '123' } }
const options = { config, auth, deviceId: 'synthetic-device' }
function fake(t, handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return handler(url, init) }
  t.after(() => { globalThis.fetch = original })
  return calls
}
const response = (body, status = 200) => new Response(JSON.stringify(body), { status })

test('capability is safe, V2 needs mid, V1 needs a numeric account, web-only auth remains unavailable', () => {
  assert.deepEqual(communityCapability(auth), { available: true, accountId: '123', reason: null })
  assert.equal(communityCapability({ aid: '123', cookies: { stoken: 'v2_synthetic-secret' } }).reason, 'missing-mid')
  assert.equal(communityCapability({ aid: '123', cookies: { stoken_v2: 'synthetic-secret' } }).reason, 'missing-mid')
  assert.equal(communityCapability({ aid: '123', cookies: { ltoken: 'web-only' } }).reason, 'no-stoken')
  assert.equal(communityCapability({ cookies: { stoken: 'v1-secret' } }).reason, 'missing-account')
  assert.deepEqual(communityCapability({ cookies: { stuid: '456', stoken: 'v1-secret' } }), { available: true, accountId: '456', reason: null })
  assert.equal(JSON.stringify(communityCapability(auth)).includes('synthetic'), false)
})

test('签名仅使用固定字符串 5 with dedicated DS2 and minimum normalized V2 cookie', async (t) => {
  const before = structuredClone(auth)
  const calls = fake(t, () => response({ retcode: 0 }))
  const result = await signCommunity({ ...options, gid: '2' })
  assert.equal(result.outcome, 'success')
  assert.equal(calls.length, 1)
  const { url, init } = calls[0]
  assert.equal(url, 'https://bbs-api.miyoushe.com/apihub/app/api/signIn')
  assert.equal(init.method, 'POST')
  assert.equal(init.body, '{"gids":"5"}')
  const headers = new Headers(init.headers)
  assert.equal(headers.get('cookie'), 'stuid=123; stoken=v2_synthetic-secret; mid=synthetic-mid')
  assert.equal(headers.get('x-rpc-client_type'), '2')
  assert.equal(headers.get('x-rpc-app_version'), '2.117.0')
  assert.equal(headers.get('x-rpc-verify_key'), 'bll8iq97cem8')
  assert.equal(headers.get('x-rpc-device_id'), 'synthetic-device')
  const [time, nonce, signature] = headers.get('DS').split(',')
  const expected = createHash('md5').update(`salt=t0qEgfub6cvueAPgR5m9aQWWVciEer7v&t=${time}&r=${nonce}&b={"gids":"5"}&q=`).digest('hex')
  assert.equal(signature, expected)
  assert.deepEqual(auth, before)
})

test('V1 cookie has no unsolicited mid and missing capability makes no request', async (t) => {
  const calls = fake(t, () => response({ retcode: 0, data: null }))
  assert.equal((await signCommunity({ ...options, auth: { cookies: { stuid: '123', stoken: 'v1-secret' } } })).outcome, 'success')
  assert.equal(new Headers(calls[0].init.headers).get('cookie'), 'stuid=123; stoken=v1-secret')
  assert.equal((await signCommunity({ ...options, auth: null })).outcome, 'auth-unavailable')
  assert.equal(calls.length, 1)
})

test('only structurally valid acceptance is success; risks take precedence and game already-signed code is not reused', async (t) => {
  const fixtures = [
    [{ retcode: 0 }, 'success'], [{ retcode: 0, message: 'ok', data: {} }, 'success'],
    [{ retcode: 1034 }, 'captcha'], [{ retcode: -100 }, 'expired'], [{ retcode: -5003, message: 'already signed' }, 'error'],
    [{ retcode: 123, message: 'success' }, 'error'], [{ retcode: '0' }, 'unknown'], [[], 'unknown'],
    [{ retcode: 0, data: [] }, 'unknown'], [{ retcode: 0, message: 123 }, 'unknown'],
    [{ retcode: 0, data: { is_risk: true } }, 'captcha'],
    [{ retcode: 0, data: { verification: { requires_manual: true } } }, 'unknown'],
  ]
  let index = 0
  const calls = fake(t, () => response(fixtures[index][0]))
  for (; index < fixtures.length; index++) assert.equal((await signCommunity(options)).outcome, fixtures[index][1], JSON.stringify(fixtures[index][0]))
  assert.equal(calls.length, fixtures.length)
})

test('HTTP failures, malformed JSON, lost response and read timeout never retry a POST or leak raw errors', async (t) => {
  const cases = [
    () => response({ retcode: 0 }, 500),
    () => new Response('<html>synthetic-secret</html>'),
    () => { throw new Error('synthetic-secret https://fake.invalid/?mid=synthetic-mid') },
    () => ({ text: async () => { throw new DOMException('synthetic-secret', 'TimeoutError') } }),
  ]
  let index = 0
  const calls = fake(t, () => cases[index]())
  for (; index < cases.length; index++) {
    const result = await signCommunity(options)
    assert.equal(result.outcome, 'unknown')
    assert.equal(calls.length, index + 1)
    assert.doesNotMatch(JSON.stringify(result), /synthetic|https?:|Cookie|stoken/)
  }
})

test('balance is account-only numeric information, ordinary cookie, no DS or inferred gid success', async (t) => {
  const calls = fake(t, () => response({ retcode: 0, data: { total_points: 123, already_received_points: 30, can_get_points: 0, states: [{ mission_id: 58, is_get_award: true }], secret: 'synthetic-secret' } }))
  const now = Date.parse('2026-11-17T16:01:00Z')
  const result = await getCommunityBalance({ ...options, now })
  assert.deepEqual(result, { ok: true, snapshot: { totalPoints: 123, todayReceived: 30, todayRemaining: 0, at: now, day: '2026-11-18' } })
  assert.equal(calls[0].url, 'https://bbs-api.miyoushe.com/apihub/wapi/getUserMissionsState?point_sn=myb')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(new Headers(calls[0].init.headers).get('DS'), null)
  assert.match(new Headers(calls[0].init.headers).get('cookie'), /ltoken=synthetic-ltoken/)
})

test('bad numeric fields become null and balance errors/risk signals remain secret-free', async (t) => {
  let body = { retcode: 0, data: { total_points: -1, already_received_points: '30', can_get_points: null } }
  fake(t, () => response(body))
  const result = await getCommunityBalance({ ...options, now: 123 })
  assert.equal(result.snapshot.totalPoints, null)
  assert.equal(result.snapshot.todayReceived, null)
  assert.equal(result.snapshot.todayRemaining, null)
  for (const [retcode, outcome] of [[-100, 'expired'], [1034, 'captcha'], [777, 'error']]) {
    body = { retcode, message: 'synthetic-secret https://fake.invalid/?mid=synthetic-mid' }
    const failed = await getCommunityBalance(options)
    assert.equal(failed.ok, false)
    assert.equal(failed.outcome, outcome)
    assert.doesNotMatch(JSON.stringify(failed), /synthetic|https?:/)
  }
})
