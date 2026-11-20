import test from 'node:test'
import assert from 'node:assert/strict'
import { SmsLoginFlow } from '../lib/sms-flow.js'
import { SmsChallenge, SmsLoginError, SmsLoginProtocol } from '../lib/sms-login.js'
import { withRequestGuard } from '../lib/http.js'
const phone = '13800000000'
const root = { aid: '123456', mid: 'mid_123', stoken: 'v2_ROOT_SECRET' }
const proof = { captcha_id: 'captcha_123', lot_number: 'lot_123', pass_token: 'PASS_SECRET', gen_time: '1800000000', captcha_output: 'OUTPUT_SECRET' }
const challenge = () => new SmsChallenge({ version: 'gt4', sessionId: 'SESSION_SECRET', config: { captchaId: 'captcha_123', userInfo: '{"session_id":"SESSION_SECRET"}' } })
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function setup(t, overrides = {}) {
  let time = 1_000_000, current = true
  const calls = []
  const base = { sendSms: async () => ({ actionType: 'real-action', countdown: 60 }), login: async () => root, getLToken: async () => ({ ltoken: 'LTOKEN_SECRET' }), getCookieToken: async () => ({ cookieToken: 'COOKIE_SECRET' }), ...overrides }
  const protocol = Object.fromEntries(Object.entries(base).map(([key, fn]) => [key, async args => { calls.push({ key, args }); return fn(args) }]))
  const flow = new SmsLoginFlow({ protocol, now: () => time, isCurrent: () => current })
  t.after(() => flow.dispose())
  return { flow, calls, advance: ms => { time += ms }, invalidate: () => { current = false } }
}
const errorCode = code => e => { assert.equal(e.code, code); assert.doesNotMatch(JSON.stringify(e), /ROOT_SECRET|SESSION_SECRET|13800000000/); return true }
function assertPublic(flow) { assert.doesNotMatch(JSON.stringify(flow.view()), /13800000000|123456|ROOT_SECRET|LTOKEN_SECRET|COOKIE_SECRET|SESSION_SECRET|PASS_SECRET|OUTPUT_SECRET/) }

test('flow returns a one-shot host candidate only after every exchange while public views stay redacted', async t => {
  const { flow, calls } = setup(t)
  const view = flow.start(phone)
  assert.equal(view.phoneMasked, '138****0000')
  assert.equal(view.expiresAt - view.createdAt, 300000)
  await flow.send(view.flowId)
  assert.equal(flow.view().status, 'code-sent')
  const result = await flow.submit(view.flowId, '123456')
  assert.deepEqual(result.candidate, { ...root, ltoken: 'LTOKEN_SECRET', cookieToken: 'COOKIE_SECRET' })
  assert.deepEqual(calls.map(c => c.key), ['sendSms', 'login', 'getLToken', 'getCookieToken'])
  assert.equal(calls[1].args.actionType, 'real-action')
  assert.equal(flow.view().status, 'candidate-ready')
  assertPublic(flow)
  await assert.rejects(flow.submit(view.flowId, '123456'), errorCode('flow-state'))
})

test('concurrent clicks dispatch one SMS and new/canceled flows cannot bypass reserved cooldown', async t => {
  const gate = deferred()
  const { flow, calls, advance } = setup(t, { sendSms: () => gate.promise })
  const id = flow.start(phone).flowId
  const pending = flow.send(id)
  await assert.rejects(flow.send(id), errorCode('flow-busy'))
  flow.cancel(id)
  const next = flow.start('13900000000').flowId
  await assert.rejects(flow.send(next), errorCode('sms-cooldown'))
  assert.equal(calls.length, 1)
  gate.resolve({ actionType: 'old', countdown: 60 })
  await assert.rejects(pending, errorCode('flow-changed'))
  advance(60000)
  await flow.send(next)
  assert.equal(calls.length, 2)
})

test('unknown send outcome reserves cooldown and explicit resend invalidates the old action_type', async t => {
  let attempts = 0
  const { flow, calls, advance } = setup(t, { sendSms: async () => { if (++attempts === 1) throw new SmsLoginError('outcome-unknown'); return { actionType: 'new-action', countdown: 90 } } })
  const id = flow.start(phone).flowId
  await assert.rejects(flow.send(id), errorCode('outcome-unknown'))
  await assert.rejects(flow.send(id), errorCode('sms-cooldown'))
  advance(60000)
  await flow.send(id)
  assert.equal(flow.view().resendAt, 1_150_000)
  await flow.submit(id, '123456')
  assert.equal(calls.find(c => c.key === 'login').args.actionType, 'new-action')
})

for (const invalidation of ['cancel', 'replace', 'expire', 'dispose', 'external-generation']) {
  test(`${invalidation} during login prevents every exchange and candidate completion`, async t => {
    const gate = deferred()
    const { flow, calls, advance, invalidate } = setup(t, { login: () => gate.promise })
    const id = flow.start(phone).flowId
    await flow.send(id)
    const pending = flow.submit(id, '123456')
    if (invalidation === 'cancel') flow.cancel(id)
    if (invalidation === 'replace') flow.start('13900000000')
    if (invalidation === 'expire') advance(300001)
    if (invalidation === 'dispose') flow.dispose()
    if (invalidation === 'external-generation') invalidate()
    gate.resolve(root)
    await assert.rejects(pending, errorCode(invalidation === 'expire' ? 'flow-expired' : 'flow-changed'))
    assert.equal(calls.length, 2)
    assertPublic(flow)
  })
}

test('manual CAPTCHA is bound to flow/checkpoint, consumed once, and never repeats successful login', async t => {
  let attempts = 0
  const { flow, calls } = setup(t, { getLToken: async () => { if (++attempts === 1) throw challenge(); return { ltoken: 'LTOKEN_SECRET' } } })
  const id = flow.start(phone).flowId
  await flow.send(id)
  const pending = await flow.submit(id, '123456')
  assert.equal(pending.flow.status, 'verification-required')
  assert.equal(pending.challenge.version, 'gt4')
  assertPublic(flow)
  const cid = pending.challenge.challengeId
  await assert.rejects(flow.solve('foreign-flow', cid, proof), errorCode('flow-changed'))
  await assert.rejects(flow.solve(id, 'foreign-challenge', proof), errorCode('challenge-stale'))
  await assert.rejects(flow.solve(id, cid, { ...proof, captcha_id: 'another-captcha' }), errorCode('invalid-proof'))
  assert.equal(calls.length, 3)
  const result = await flow.solve(id, cid, proof)
  assert.equal(result.candidate.aid, '123456')
  assert.equal(calls.filter(c => c.key === 'login').length, 1)
  const forwarded = calls.filter(c => c.key === 'getLToken')[1].args.proof
  assert.equal(forwarded, 'SESSION_SECRET;' + Buffer.from(JSON.stringify(proof)).toString('base64'))
  await assert.rejects(flow.solve(id, cid, proof), errorCode('challenge-stale'))
  assert.equal(calls.length, 5)
  assertPublic(flow)
})

test('a send CAPTCHA resumes its reserved request without bypassing or rechecking resend cooldown', async t => {
  let attempts = 0
  const { flow, calls } = setup(t, { sendSms: async () => { if (++attempts === 1) throw challenge(); return { actionType: 'solved', countdown: 60 } } })
  const id = flow.start(phone).flowId
  const pending = await flow.send(id)
  await flow.solve(id, pending.challenge.challengeId, proof)
  assert.equal(flow.view().status, 'code-sent')
  assert.equal(calls.length, 2)
  assert.ok(calls[1].args.proof)
  await assert.rejects(flow.send(id), errorCode('sms-cooldown'))
})

test('expired challenge cannot dispatch; refreshed challenges never extend the absolute flow TTL', async t => {
  const { flow, calls, advance } = setup(t, { sendSms: async () => { throw challenge() } })
  const initial = flow.start(phone)
  const pending = await flow.send(initial.flowId)
  advance(120001)
  await assert.rejects(flow.solve(initial.flowId, pending.challenge.challengeId, proof), errorCode('challenge-expired'))
  assert.equal(calls.length, 1)
  const next = await flow.send(initial.flowId)
  assert.equal(next.flow.expiresAt, initial.expiresAt)
  assert.ok(next.challenge.expiresAt <= initial.expiresAt)
})

test('manual verification loops stop after three continuations without extending or retaining the flow', async t => {
  const { flow, calls } = setup(t, { sendSms: async () => { throw challenge() } })
  const id = flow.start(phone).flowId
  let pending = await flow.send(id)
  for (let i = 0; i < 2; i++) pending = await flow.solve(id, pending.challenge.challengeId, proof)
  await assert.rejects(flow.solve(id, pending.challenge.challengeId, proof), errorCode('challenge-limit'))
  assert.equal(calls.length, 4)
  assert.equal(flow.view().status, 'error')
  assertPublic(flow)
})

test('code validation and five explicit incorrect-code submissions bound official POST attempts', async t => {
  const { flow, calls } = setup(t, { login: async () => { throw new SmsLoginError('sms-code-invalid') } })
  assert.throws(() => flow.start('not-mobile'), errorCode('bad-phone'))
  const id = flow.start(phone).flowId
  await assert.rejects(flow.submit(id, '123456'), errorCode('flow-state'))
  await flow.send(id)
  await assert.rejects(flow.submit(id, '12a456'), errorCode('bad-code'))
  for (let i = 0; i < 5; i++) await assert.rejects(flow.submit(id, '123456'), errorCode('sms-code-invalid'))
  await assert.rejects(flow.submit(id, '123456'), errorCode('flow-state'))
  assert.equal(calls.filter(c => c.key === 'login').length, 5)
  assertPublic(flow)
})

test('resending SMS cannot reset the five-submission budget of an existing flow', async t => {
  const { flow, calls, advance } = setup(t, { login: async () => { throw new SmsLoginError('sms-code-invalid') } })
  const id = flow.start(phone).flowId
  await flow.send(id)
  for (let i = 0; i < 4; i++) await assert.rejects(flow.submit(id, '123456'), errorCode('sms-code-invalid'))
  advance(60000)
  await flow.send(id)
  await assert.rejects(flow.submit(id, '123456'), errorCode('sms-code-invalid'))
  await assert.rejects(flow.submit(id, '123456'), errorCode('flow-state'))
  assert.equal(calls.filter(c => c.key === 'login').length, 5)
})

test('settled operation snapshots do not leave the browser locked in a busy state', async t => {
  const { flow } = setup(t)
  const id = flow.start(phone).flowId
  assert.equal((await flow.send(id)).flow.busy, false)
  assert.equal((await flow.submit(id, '123456')).flow.busy, false)
})

for (const checkpoint of ['getLToken', 'getCookieToken']) {
  test(`cancellation during ${checkpoint} prevents candidate delivery and later exchanges`, async t => {
    const gate = deferred(), entered = deferred()
    const { flow, calls } = setup(t, { [checkpoint]: () => { entered.resolve(); return gate.promise } })
    const id = flow.start(phone).flowId
    await flow.send(id)
    const pending = flow.submit(id, '123456')
    await entered.promise
    assert.equal(calls.at(-1).key, checkpoint)
    flow.cancel(id)
    gate.resolve(checkpoint === 'getLToken' ? { ltoken: 'LTOKEN_SECRET' } : { cookieToken: 'COOKIE_SECRET' })
    await assert.rejects(pending, errorCode('flow-changed'))
    assert.equal(calls.length, checkpoint === 'getLToken' ? 3 : 4)
    assertPublic(flow)
  })
}

test('flow HTTP guard cannot shadow a stale outer service generation guard', async t => {
  const original = globalThis.fetch
  let dispatched = 0
  globalThis.fetch = async () => { dispatched++; return new Response(JSON.stringify({ retcode: 0, data: { action_type: 'login', countdown: 60 } })) }
  const flow = new SmsLoginFlow({ protocol: new SmsLoginProtocol({ deviceId: 'stable-device' }), isCurrent: () => true })
  t.after(() => { flow.dispose(); globalThis.fetch = original })
  const id = flow.start(phone).flowId
  await assert.rejects(withRequestGuard(() => false, () => flow.send(id)))
  assert.equal(dispatched, 0)
})
