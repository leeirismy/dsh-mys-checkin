import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

// Callback-unit tests only: load the actual module factory, without DOM/render simulation.
function units() {
  let plugin
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8').replace('      inject: [\'slots\', \'locale\'],', '      units: { createSmsController, createCaptchaBridge, SmsDialog }, inject: [\'slots\', \'locale\'],')
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({ createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), useState: init => [typeof init === 'function' ? init() : init, () => {}], useRef: current => ({ current }), useEffect() {} })) } } }, URL, Date, JSON })
  return plugin.units
}
function harness(request = async () => ({})) {
  const calls = [], snapshots = [], confirmations = []
  const controller = units().createSmsController({ request: async (path, body) => { calls.push({ path, body }); return request(path, body) }, changed: s => snapshots.push(s), confirmed: d => confirmations.push(d), now: () => 1000 })
  return { c: controller, calls, confirmations, view: () => snapshots.at(-1) }
}
const flow = (extra = {}) => ({ flowId: 'flow-one', status: 'code-sent', expiresAt: 301000, resendAt: 61000, phoneMasked: '138****8000', ...extra })
const challenge = { challengeId: 'host-one', version: 'gt4', expiresAt: 121000, config: { captchaId: 'site', userInfo: '{"session_id":"private"}' } }
const proof = { captcha_id: 'site', lot_number: 'lot', pass_token: 'token', gen_time: '123', captcha_output: 'proof' }

test('SMS dialog describes labeled native phone/code inputs, explicit actions and Enter submission without exposing raw errors', () => {
  const { SmsDialog } = units(), calls = []
  const controller = { cancel: () => calls.push('cancel'), send: () => calls.push('send'), submit: () => calls.push('submit'), setPhone() {}, setCode() {} }
  const describe = session => {
    const root = SmsDialog({ t: key => key, session, controller }), nodes = []
    function visit(n) { if (!n || typeof n !== 'object') return; nodes.push(n); for (const child of n.props?.children?.flat(Infinity) ?? []) visit(child) }
    visit(root); return nodes
  }
  const base = { phone: '', code: '', flow: null, busy: false, error: null }
  let nodes = describe(base)
  assert.equal(nodes.find(n => n.props.role === 'dialog').props.tabIndex, -1)
  const tel = nodes.find(n => n.type === 'input')
  assert.equal(tel.props.autoComplete, 'tel-national'); assert.equal(tel.props.inputMode, 'tel')
  assert.ok(nodes.some(n => n.type === 'label' && n.props.children[0] === 'smsPhone'))
  assert.equal(calls.length, 0)
  nodes.find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }); assert.equal(calls.at(-1), 'send')
  nodes = describe({ ...base, flow: flow({ expiresAt: Date.now() + 300000, resendAt: 0 }), error: 'smsWrongCode' })
  const code = nodes.find(n => n.type === 'input' && n.props.autoComplete === 'one-time-code')
  assert.equal(code.props.inputMode, 'numeric'); assert.equal(code.props.maxLength, 6)
  assert.ok(nodes.some(n => n.props.role === 'alert' && n.props.children[0] === 'smsWrongCode'))
  nodes.find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }); assert.equal(calls.at(-1), 'submit')
  nodes.find(n => n.props.role === 'dialog').props.onKeyDown({ key: 'Escape', preventDefault() {} }); assert.equal(calls.at(-1), 'cancel')
  nodes = describe({ ...base, flow: flow({ expiresAt: Date.now() + 300000, resendAt: Date.now() + 60000 }) })
  assert.equal(nodes.find(n => n.props.role === 'status').props.children[0], 'smsCodeSent')
  assert.ok(nodes.some(n => n.props['aria-live'] === 'off'))
  nodes = describe({ ...base, busy: true }); const before = calls.length
  nodes.find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }); assert.equal(calls.length, before)
})

test('opening and missing inputs never send SMS; sending explicitly clears full phone and countdown blocks duplicates', async () => {
  const h = harness(async path => ({ ok: true, flow: flow(path.endsWith('start') ? { status: 'phone-ready', resendAt: 0 } : {}) }))
  h.c.open(); assert.equal(h.calls.length, 0)
  await h.c.send(); assert.equal(h.calls.length, 0); assert.equal(h.view().error, 'smsBadPhone')
  h.c.setPhone('13800138000'); await h.c.send()
  assert.deepEqual(h.calls.map(c => c.path), ['login/start', 'login/send'])
  assert.equal(h.calls[0].body.phone, '13800138000')
  assert.equal(h.view().phone, '')
  await h.c.send(); assert.equal(h.calls.length, 2)
  await h.c.submit(); assert.equal(h.calls.length, 2); assert.equal(h.view().error, 'smsBadCode')
})

test('pending send holds a synchronous duplicate lock; close clears input and cancels only its captured flow', async () => {
  let release, reachedSend
  const atSend = new Promise(resolve => { reachedSend = resolve })
  const h = harness(async path => path.endsWith('send') ? new Promise(r => { release = r; reachedSend() }) : { ok: true, flow: flow({ status: 'phone-ready', resendAt: 0 }) })
  h.c.open(); h.c.setPhone('13800138000')
  const pending = h.c.send(); await atSend
  await h.c.send(); assert.equal(h.calls.length, 2)
  h.c.setCode('123456'); h.c.cancel(); assert.equal(h.view(), null)
  assert.equal(h.calls.at(-1).body.flowId, 'flow-one')
  h.c.open(); release({ ok: true, flow: flow() }); await pending
  assert.equal(h.view().flow, null); assert.equal(h.view().code, '')
})

test('wrong code renders only a localized fixed error and explicit retry does not send another SMS', async () => {
  let tries = 0
  const h = harness(async path => path.endsWith('submit') ? (++tries === 1 ? { ok: false, flow: flow(), error: { code: 'sms-code-invalid', message: 'SECRET upstream' } } : { ok: true, state: 'confirmed' }) : { ok: true, flow: flow() })
  h.c.open(); h.c.setPhone('13800138000'); await h.c.send()
  h.c.setCode('123456'); await h.c.submit()
  assert.equal(h.view().error, 'smsWrongCode'); assert.equal(h.view().code, '')
  h.c.setCode('654321'); await h.c.submit()
  assert.equal(h.confirmations.length, 1); assert.equal(h.view(), null)
  assert.equal(h.calls.filter(c => c.path === 'login/send').length, 1)
})

test('state read is GET-only and never replays a challenge; stale challenge success cannot mutate a closed flow', async () => {
  const h = harness(async path => ({ ok: true, flow: flow({ status: 'verification-required', challenge: { challengeId: 'host-one' } }), ...(path === 'login/send' ? { challenge } : {}) }))
  h.c.open(); h.c.setPhone('13800138000'); await h.c.send(); await h.c.readState()
  assert.equal(h.calls.at(-1).body, undefined)
  h.c.cancel(); const count = h.calls.length
  await h.c.solve('host-one', proof)
  assert.equal(h.calls.length, count)
})

for (const [code, key] of [['official-action-required', 'smsOfficialAction'], ['game-validation-failed', 'smsGameValidation'], ['community-validation-failed', 'smsCommunityValidation'], ['outcome-unknown', 'smsOutcomeUnknown'], ['upstream-rejected', 'smsRejected']]) test(`safe ${code} recovery category and null host flow cannot retain a stale checkpoint`, async () => {
  const h = harness(async path => path.endsWith('submit') ? { ok: false, flow: null, error: { code, message: 'SECRET' } } : { ok: true, flow: flow() })
  h.c.open(); h.c.setPhone('13800138000'); await h.c.send(); h.c.setCode('123456'); await h.c.submit()
  assert.equal(h.view().error, key); assert.equal(h.view().flow, null); assert.equal(h.view().fatal, true)
  const before = h.calls.length; await h.c.send(); assert.equal(h.calls.length, before)
  assert.equal(JSON.stringify(h.view()).includes('SECRET'), false)
})

test('widget loading failure invalidates its rendering checkpoint and cannot continue or resend', async () => {
  const h = harness(async () => ({ ok: true, flow: flow({ status: 'verification-required', resendAt: 0 }), challenge }))
  h.c.open(); h.c.setPhone('13800138000'); await h.c.send()
  h.c.widgetError(); const before = h.calls.length
  await h.c.solve('host-one', proof); await h.c.send()
  assert.equal(h.calls.length, before)
  assert.equal(h.view().challenge, null); assert.equal(h.view().fatal, true)
})

test('official widget readiness clears the load deadline through the bound bridge callback', () => {
  const { createCaptchaBridge } = units(), sent = [], frameWindow = { postMessage: (...args) => sent.push(args) }
  let ready = 0
  const bridge = createCaptchaBridge({ getWindow: () => frameWindow, nonce: 'fresh', challenge, onResult() {}, onError() {}, onReady() { ready++ }, now: () => 1000 })
  bridge.load()
  assert.equal(sent.length, 1); assert.equal(sent[0][0].nonce, 'fresh')
  assert.equal(sent[0][0].config.userInfo, challenge.config.userInfo)
  assert.equal(sent[0][0].config.target, undefined)
  bridge.receive({ source: {}, data: { nonce: 'fresh', type: 'mys-captcha:ready' } }); assert.equal(ready, 0)
  bridge.receive({ source: frameWindow, data: { nonce: 'fresh', type: 'mys-captcha:ready' } }); assert.equal(ready, 1)
})

test('cancel before start returns sends only a late matching cancellation, never a late SMS', async () => {
  let release
  const h = harness(async path => path.endsWith('start') ? new Promise(r => { release = r }) : { ok: true })
  h.c.open(); h.c.setPhone('13800138000'); const pending = h.c.send()
  h.c.cancel(); h.c.open(); h.c.setPhone('13900139000')
  release({ ok: true, flow: flow() }); await pending
  assert.equal(h.calls.filter(c => c.path === 'login/send').length, 0)
  assert.equal(h.calls.at(-1).path, 'login/cancel'); assert.equal(h.calls.at(-1).body.flowId, 'flow-one')
  assert.equal(h.view().phone, '13900139000')
})

test('opaque CAPTCHA bridge rejects wrong source, nonce, malformed/oversized proof, and duplicate or expired success', () => {
  const { createCaptchaBridge } = units(), frameWindow = { postMessage() {} }, results = [], errors = []
  const bridge = createCaptchaBridge({ getWindow: () => frameWindow, nonce: 'nonce', challenge, onResult: (...v) => results.push(v), onError: () => errors.push(true), now: () => 1000 })
  const event = { source: frameWindow, origin: 'null', data: { type: 'mys-captcha:success', nonce: 'nonce', result: { ...proof, unexpected: 'SECRET' } } }
  bridge.receive({ ...event, source: {} }); bridge.receive({ ...event, data: { ...event.data, nonce: 'other' } })
  bridge.receive({ ...event, data: { ...event.data, result: { ...proof, pass_token: 'a'.repeat(8193) } } })
  bridge.receive({ ...event, data: { ...event.data, result: [] } })
  assert.equal(results.length, 0)
  bridge.receive(event); bridge.receive(event)
  assert.equal(results.length, 1); assert.equal(results[0][0], 'host-one'); assert.equal(results[0][1].unexpected, undefined)
  bridge.dispose(); bridge.receive(event); assert.equal(results.length, 1)
  const expired = createCaptchaBridge({ getWindow: () => frameWindow, nonce: 'nonce', challenge, onResult: () => results.push('bad'), onError() {}, now: () => 999999 })
  expired.receive(event); assert.equal(results.length, 1)
})
