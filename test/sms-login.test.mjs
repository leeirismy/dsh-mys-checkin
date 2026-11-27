import test from 'node:test'
import assert from 'node:assert/strict'
import { constants, createHash, generateKeyPairSync, privateDecrypt } from 'node:crypto'
import { SmsLoginProtocol, SmsLoginError, SmsChallenge, encryptSmsField, validateCaptchaResult, makeAigis } from '../lib/sms-login.js'
import { withRequestGuard } from '../lib/http.js'

const phone = '13800000000'
const root = { aid: '123456', mid: 'mid_123', stoken: 'v2_ROOT_SECRET' }
const successLogin = () => ({ user_info: { aid: '123456', mid: 'mid_123' }, token: { token_type: 1, token: 'v2_ROOT_SECRET' } })
const gt4 = { captcha_id: 'captcha_123', lot_number: 'lot_123', pass_token: 'PASS_SECRET', gen_time: '1800000000', captcha_output: 'OUTPUT_SECRET' }
const gt3 = { geetest_challenge: 'challenge123', geetest_validate: 'validate123', geetest_seccode: 'validate123|jordan' }
function response(data, retcode = 0, headers = {}, status = 200) {
  return new Response(JSON.stringify({ retcode, message: 'UPSTREAM_SECRET', data }), { status, headers })
}
function setup(t, replies) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : undefined })
    const next = replies.shift()
    assert.notEqual(next, undefined, 'unexpected extra request')
    if (typeof next === 'function') return next()
    if (next instanceof Error) throw next
    return next
  }
  t.after(() => { globalThis.fetch = original })
  return { protocol: new SmsLoginProtocol({ deviceId: 'stable-device', device: { name: 'local-device', model: 'local-model' } }), calls }
}
function safeError(code, retcode) {
  return error => {
    assert.ok(error instanceof SmsLoginError)
    assert.equal(error.code, code)
    if (retcode !== undefined) assert.equal(error.diagnostic.retcode, retcode)
    assert.doesNotMatch(JSON.stringify(error), /UPSTREAM_SECRET|ROOT_SECRET|13800000000/)
    assert.doesNotMatch(error.stack, /UPSTREAM_SECRET|ROOT_SECRET|13800000000/)
    return true
  }
}

test('SMS encryption uses randomized RSA PKCS1 v1.5 instead of leaking phone or country code', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
  const first = encryptSmsField(phone, publicKey)
  assert.notEqual(first, encryptSmsField(phone, publicKey))
  const block = privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, Buffer.from(first, 'base64'))
  assert.equal(block[0], 0)
  assert.equal(block[1], 2)
  const delimiter = block.indexOf(0, 2)
  assert.ok(delimiter >= 10)
  assert.equal(block.subarray(delimiter + 1).toString(), phone)
})

test('SMS send and code login use official encrypted POSTs, stable device, action_type, and no old Cookie', async t => {
  const { protocol, calls } = setup(t, [response({ action_type: 'login', countdown: 80 }), response(successLogin())])
  assert.deepEqual(await protocol.sendSms({ phone }), { actionType: 'login', countdown: 80 })
  assert.deepEqual(await protocol.login({ phone, code: '123456', actionType: 'login' }), root)
  assert.deepEqual(calls.map(c => c.url), [
    'https://passport-api.mihoyo.com/account/ma-cn-verifier/verifier/createLoginCaptcha',
    'https://passport-api.mihoyo.com/account/ma-cn-passport/app/loginByMobileCaptcha',
  ])
  for (const { options, body } of calls) {
    assert.equal(options.method, 'POST')
    assert.equal(options.redirect, 'manual')
    assert.equal(options.headers['x-rpc-device_id'], 'stable-device')
    assert.equal(options.headers['x-rpc-client_type'], '2')
    assert.equal(options.headers['x-rpc-app_id'], 'bll8iq97cem8')
    assert.equal(options.headers['x-rpc-app_version'], '2.116.0')
    assert.equal(options.headers['x-rpc-game_biz'], 'bbs_cn')
    assert.equal(options.headers.Cookie, undefined)
    assert.equal(Buffer.from(body.mobile, 'base64').length, 128)
    assert.equal(Buffer.from(body.area_code, 'base64').length, 128)
    assert.notEqual(body.mobile, phone)
    assert.notEqual(body.area_code, '+86')
  }
  assert.equal(calls[1].body.captcha, '123456')
  assert.equal(calls[1].body.action_type, 'login')
})

test('nonzero business retcode with data:null is not misclassified as invalid response', async t => {
  const { protocol } = setup(t, [response(null, -3102), response(null, -3202), response(null, -5300)])
  await assert.rejects(protocol.sendSms({ phone }), safeError('challenge-failed', -3102))
  await assert.rejects(protocol.login({ phone, code: '123456', actionType: 'login' }), safeError('sms-code-invalid', -3202))
  await assert.rejects(protocol.sendSms({ phone }), safeError('upstream-rejected', -5300))
})

test('unknown SMS POST outcomes and login body failures dispatch once without retry or leaking cause', async t => {
  const { protocol, calls } = setup(t, [new Error(`UPSTREAM_SECRET ${phone}`), () => new Response(new ReadableStream({ pull(controller) { controller.error(new Error('UPSTREAM_SECRET')) } })), new Response('not-json')])
  await assert.rejects(protocol.sendSms({ phone }), safeError('outcome-unknown'))
  assert.equal(calls.length, 1)
  await assert.rejects(protocol.login({ phone, code: '123456', actionType: 'login' }), safeError('outcome-unknown'))
  assert.equal(calls.length, 2)
  await assert.rejects(protocol.sendSms({ phone }), safeError('outcome-unknown'))
  assert.equal(calls.length, 3)
})

test('login cannot accept unsafe/incomplete root tokens or official extra identity requirements', async t => {
  const malformed = [
    { ...successLogin(), token: { token_type: 2, token: 'other-token' } },
    { ...successLogin(), token: { token_type: '1', token: 'other-token' } },
    { ...successLogin(), token: { token_type: 1, token: '' } },
    { ...successLogin(), user_info: { aid: '123;stuid=456', mid: 'mid_123' } },
    { ...successLogin(), user_info: { aid: '123456', mid: 'mid;stoken=evil' } },
    { ...successLogin(), token: { token_type: 1, token: 'v2_X\r\nCookie: stolen' } },
    null, {},
  ]
  const blocked = [{ ...successLogin(), need_realperson: true }, { ...successLogin(), realname_info: { required: true } }, { ...successLogin(), reactivate_info: { required: true } }]
  const { protocol } = setup(t, [...malformed, ...blocked].map(d => response(d)))
  for (const _ of malformed) await assert.rejects(protocol.login({ phone, code: '123456', actionType: 'login' }), safeError('invalid-response'))
  for (const _ of blocked) await assert.rejects(protocol.login({ phone, code: '123456', actionType: 'login' }), safeError('official-action-required'))
})

const ticket = (type, token, aid = root.aid, mid = root.mid) => ({ token: { token_type: type, token }, user_info: { aid, mid } })
test('both V2 tickets use a signed POST and never put the source token in headers or URL', async t => {
  const { protocol, calls } = setup(t, [response(ticket(2, 'opaqueLT')), response(ticket(4, 'opaqueCT'))])
  assert.deepEqual(await protocol.getLToken({ root }), { ltoken: 'opaqueLT' })
  assert.deepEqual(await protocol.getCookieToken({ root }), { cookieToken: 'opaqueCT' })
  for (const [i, { url, options, body }] of calls.entries()) {
    assert.equal(url, 'https://passport-api.mihoyo.com/account/ma-cn-session/app/exchange')
    assert.equal(options.method, 'POST'); assert.equal(options.headers.Cookie, undefined)
    assert.deepEqual(body, { dst_token_type: [2, 4][i], src_token: { token: root.stoken, token_type: 1 }, mid: root.mid })
    const [time, nonce, hash] = options.headers.DS.split(',')
    assert.match(nonce, /^[a-zA-Z0-9]{6}$/)
    assert.equal(hash, createHash('md5').update(`salt=JwYDpKvLj6MrMqqYU6jTKF17KNO2PXoS&t=${time}&r=${nonce}&b=${options.body}&q=`).digest('hex'))
  }
})

test('V2 exchanges reject missing or conflicting identity, wrong ticket type and unsafe values', async t => {
  const fixtures = [[ticket(2, 'OTHER', '654321'), 'account-mismatch'], [ticket(2, 'OTHER', root.aid, 'otherMID'), 'account-mismatch'],
    [{ token: { token: 'secret', token_type: 2 } }, 'invalid-response'], [ticket(4, 'wrong-type'), 'invalid-response'], [ticket(2, 'token; bad'), 'invalid-response']]
  const { protocol } = setup(t, fixtures.map(([d]) => response(d)))
  for (const [, code] of fixtures) await assert.rejects(protocol.getLToken({ root }), safeError(code))
})

test('Aigis GT4/GT3 headers are parsed before business rejection with bounded render configuration', async t => {
  const header = use_v4 => JSON.stringify({ session_id: 'session_123', data: JSON.stringify({ use_v4, gt: 'captcha_123', challenge: 'challenge_123', success: 1, new_captcha: true, risk_type: 'slide', ignored: 'UPSTREAM_SECRET' }) })
  const { protocol } = setup(t, [response(null, -3101, { 'x-rpc-aigis': header(true) }), response(null, -3101, { 'x-rpc-aigis': header(false) })])
  for (const version of ['gt4', 'gt3']) {
    await assert.rejects(protocol.sendSms({ phone }), error => {
      assert.ok(error instanceof SmsChallenge)
      assert.equal(error.version, version)
      assert.equal(error.sessionId, 'session_123')
      assert.equal(error.config.captchaId, 'captcha_123')
      assert.equal(error.config.ignored, undefined)
      assert.doesNotMatch(JSON.stringify(error), /session_123|UPSTREAM_SECRET/)
      return true
    })
  }
})

test('GT4 permits empty optional widget fields and explicit flag encodings without weakening GT3', async t => {
  const fixtures = [
    [true, { use_v4: true, gt: 'site', challenge: '', risk_type: '' }],
    [false, { use_v4: 1, gt: 'site', challenge: null, new_captcha: 1, success: '1' }],
    [true, { use_v4: 'false', gt: 'site', challenge: 'CHALLENGE', new_captcha: '0', success: 0 }],
  ]
  const replies = fixtures.map(([nested, data]) => response(null, -3101, { 'x-rpc-aigis': JSON.stringify({ session_id: 'session', mmt_type: 1, data: nested ? JSON.stringify(data) : data }) }))
  const { protocol, calls } = setup(t, replies)
  for (const [i] of fixtures.entries()) await assert.rejects(protocol.sendSms({ phone }), e => {
    assert.ok(e instanceof SmsChallenge); assert.equal(e.version, i === 2 ? 'gt3' : 'gt4'); assert.equal(e.config.riskType, null)
    assert.equal(e.config.challenge, i === 2 ? 'CHALLENGE' : null); assert.equal(e.config.offline, i === 2); return true
  })
  assert.equal(calls.length, 3)
})

test('invalid challenges report only the offending static field, never its value', async t => {
  const cases = [ ['use_v4', { use_v4: 'SECRET' }], ['challenge', { use_v4: false, challenge: '' }], ['gt', { gt: 'https://SECRET' }], ['risk_type', { risk_type: ['SECRET'] }] ]
  const { protocol } = setup(t, cases.map(([, fields]) => response(null, -3101, { 'x-rpc-aigis': JSON.stringify({ session_id: 'SECRET', data: { gt: 'site', use_v4: true, ...fields } }) })))
  for (const [field] of cases) await assert.rejects(protocol.sendSms({ phone }), e => {
    assert.equal(e.code, 'invalid-challenge'); assert.equal(e.diagnostic.challengeField, field); assert.equal(e.diagnostic.stage, 'sms'); assert.equal(e.diagnostic.retcode, -3101); assert.doesNotMatch(JSON.stringify(e), /SECRET/); return true
  })
})

test('malformed or oversized CAPTCHA config cannot escape as upstream text or become a valid challenge', async t => {
  const headers = [ '{UPSTREAM_SECRET', JSON.stringify({ session_id: 'x\r\nevil', data: '{}' }), JSON.stringify({ session_id: 'session', data: JSON.stringify({ gt: 'https://evil.invalid', use_v4: 'false' }) }), 'a'.repeat(17000) ]
  headers.push(JSON.stringify({ session_id: 'session', mmt_type: 99, data: { gt: 'site', use_v4: true } }), JSON.stringify({ session_id: 'session', data: [] }))
  const { protocol } = setup(t, headers.map(value => response(null, -3101, { 'x-rpc-aigis': value })))
  for (const _ of headers) await assert.rejects(protocol.sendSms({ phone }), safeError('invalid-challenge'))
})

test('only complete bounded GT3/GT4 results produce the exact official proof encoding', () => {
  assert.deepEqual(validateCaptchaResult('gt4', { ...gt4, stolen: 'evil' }), gt4)
  assert.deepEqual(validateCaptchaResult('gt3', gt3), gt3)
  assert.equal(makeAigis('session_123', gt4), 'session_123;' + Buffer.from(JSON.stringify(gt4)).toString('base64'))
  for (const [version, payload] of [['unknown', gt4], ['gt4', {}], ['gt3', gt4], ['gt4', { ...gt4, captcha_output: 'a'.repeat(9000) }], ['gt4', { ...gt4, pass_token: 'x\r\ny' }]]) {
    assert.throws(() => validateCaptchaResult(version, payload), safeError('invalid-proof'))
  }
})

test('oversized official bodies are bounded and never trigger a silent POST retry', async t => {
  const { protocol, calls } = setup(t, [response({ action_type: 'x'.repeat(150000), countdown: 60 })])
  await assert.rejects(protocol.sendSms({ phone }), safeError('outcome-unknown'))
  assert.equal(calls.length, 1)
})

test('invalid local inputs and stale request guards dispatch no official requests', async t => {
  const { protocol, calls } = setup(t, [])
  await assert.rejects(protocol.sendSms({ phone: 'not-mobile' }), safeError('bad-phone'))
  await assert.rejects(protocol.login({ phone, code: '12a456', actionType: 'login' }), safeError('bad-code'))
  await assert.rejects(protocol.getCookieToken({ root: { ...root, aid: '1;mid=evil' } }), safeError('invalid-response'))
  await assert.rejects(withRequestGuard(() => false, () => protocol.sendSms({ phone })), safeError('outcome-unknown'))
  assert.equal(calls.length, 0)
})
