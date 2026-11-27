import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

// Callback-unit tests only: load the actual module factory, without DOM/render simulation.
function units(localStorage, hookStates = []) {
  let plugin
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8').replace('      inject: [\'slots\', \'locale\'],', '      units: { createSmsController, createCaptchaBridge, CaptchaFrame, SmsDialog, SendDiagnostic, readSendDiagnostic }, inject: [\'slots\', \'locale\'],')
  vm.runInNewContext(source, { window: { localStorage, __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({ createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), useState: init => [hookStates.length ? hookStates.shift() : typeof init === 'function' ? init() : init, () => {}], useRef: current => ({ current }), useEffect() {} })) } } }, URL, Date, JSON })
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

test('send feedback above the countdown follows this SMS attempt, including challenge and ambiguous results', async () => {
  let resolveSend, started
  const ready = { ok: true, flow: flow({ status: 'phone-ready', expiresAt: Date.now() + 300000, resendAt: Date.now() + 60000 }) }
  const challenged = { ...ready, flow: { ...ready.flow, status: 'verification-required', challenge: { challengeId: challenge.challengeId, checkpoint: 'sms' } }, challenge }
  for (const outcome of ['challenge', 'unknown', 'lost', 'rejected', 'terminal', 'no-widget']) {
    const pending = new Promise(r => { started = r })
    const h = harness(async path => {
      if (path === 'login/start') return ready
      if (path === 'login/state') return ready
      if (path === 'login/challenge') return { ok: true, flow: { ...ready.flow, status: 'code-sent' } }
      if (path === 'login/send') return new Promise((resolve, reject) => { resolveSend = () => outcome === 'lost' ? reject(new Error()) : resolve(outcome === 'challenge' ? challenged : outcome === 'no-widget' ? { ...challenged, challenge: undefined } : { ...ready, flow: outcome === 'terminal' ? { ...ready.flow, status: 'error' } : ready.flow, ok: false, error: { code: outcome === 'rejected' ? 'upstream-rejected' : 'outcome-unknown' } }); started() })
    })
    const labels = () => units().SmsDialog({ t: k => k, session: h.view(), controller: h.c }).props.children[0].props.children.find(n => n?.type === 'form').props.children.filter(n => n?.props?.role === 'status' || n?.props?.['aria-live'] === 'off').flatMap(n => n.props.children)
    h.c.open(); h.c.setPhone('13800138000'); const work = h.c.send()
    // Allow the local start step to publish a flow and dispatch the actual send.
    await pending
    assert.ok(labels().includes('smsSendPending'))
    resolveSend(); await work
    if (outcome === 'challenge') {
      assert.ok(labels().indexOf('smsSendChallenge') >= 0 && labels().indexOf('smsSendChallenge') < labels().indexOf('smsCountdown'))
      await h.c.solve(challenge.challengeId, proof); assert.ok(labels().includes('smsCodeSent'))
    } else if (outcome === 'no-widget') {
      assert.ok(labels().includes('smsSendChallengeUnavailable'))
    } else {
      assert.ok(labels().includes(outcome === 'rejected' ? 'smsSendRejected' : 'smsSendUnknown'))
      await h.c.readState(); assert.ok(!labels().includes('smsCodeSent'))
    }
  }
})

test('a read-only poll recovers the latest official send error after a lost reply', async () => {
  const h = harness(async path => {
    if (path === 'login/start') return { ok: true, flow: flow({ status: 'phone-ready', resendAt: 0 }) }
    if (path === 'login/state') return { ok: true, flow: flow({ status: 'phone-ready', error: { code: 'upstream-rejected', diagnostic: { stage: 'sms', retcode: -777 } } }) }
    throw new Error('reply lost')
  })
  h.c.open(); h.c.setPhone('13800138000'); await h.c.send(); await h.c.readState()
  assert.equal(h.view().error, 'smsRejected'); assert.equal(h.view().retcode, -777)
  assert.equal(h.view().sendHint, 'smsSendRejected')
  assert.equal(h.calls.filter(x => x.path === 'login/send').length, 1)
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

test('login rejection shows only supplied stage and integer retcode in the alert, never stale or raw diagnostics', async () => {
  for (const [diagnostic, expected] of [
    [{ stage: 'ltoken', retcode: -7777, extra: 'SECRET' }, ['ltoken', '-7777']],
    [{ stage: 'login' }, ['login']], [{ stage: 'SECRET', retcode: -8888 }, ['-8888']],
    [{ stage: 'SECRET', retcode: 'SECRET' }, []],
  ]) {
    const h = harness(async path => path.endsWith('submit')
      ? { ok: false, flow: flow(), error: { code: 'upstream-rejected', message: 'SECRET' }, diagnostic }
      : { ok: true, flow: flow() })
    const alert = () => {
      const tree = units().SmsDialog({ t: key => key, session: h.view(), controller: h.c })
      function find(n) { return n?.props?.role === 'alert' ? n : n?.props?.children.map(find).find(Boolean) }
      function text(n) { return n?.props ? n.props.children.map(text).join(' ') : String(n ?? '') }
      return text(find(tree))
    }
    h.c.open(); h.c.setPhone('13800138000'); await h.c.send(); h.c.setCode('123456'); await h.c.submit()
    assert.match(alert(), /smsRejected/)
    for (const value of expected) assert.ok(alert().includes(value), `missing ${value} from ${alert()}`)
    assert.doesNotMatch(alert(), /SECRET|undefined/)
    await h.c.submit() // empty input yields a new, local error
    assert.match(alert(), /smsBadCode/); assert.doesNotMatch(alert(), /ltoken|login|-7777|-8888/)
  }
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
  const before = h.calls.length
  h.c.widgetError('open-failed'); assert.equal(h.view().error, 'smsWidgetOpenFailed')
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

test('captcha status is visible while loading, then offers a non-submit button, then shows opening feedback', () => {
  for (const [phase, label] of [['loading', 'smsWidgetLoading'], ['ready', 'smsWidgetStart'], ['opening', 'smsWidgetOpening']]) {
    const tree = units(undefined, ['frame HTML', phase]).CaptchaFrame({ t: k => k, challenge, onResult() {}, onError() {} })
    const [feedback, viewport] = tree.props.children
    assert.equal(feedback.props.children[0], label)
    if (phase === 'ready') { assert.equal(feedback.type, 'button'); assert.equal(feedback.props.type, 'button') }
    assert.equal(viewport.props['data-active'], phase === 'opening')
  }
})

test('only a click opens a ready widget; missing panel acknowledgement fails once', () => {
  const { createCaptchaBridge } = units(), sent = [], phases = [], errors = [], timers = new Map()
  const frame = { postMessage: m => sent.push(m.type) }
  const bridge = createCaptchaBridge({ getWindow: () => frame, nonce: 'n', challenge, now: () => 1000, onResult() {},
    onError: reason => errors.push(reason), onPhase: phase => phases.push(phase),
    arm: (fn, ms) => { timers.set(fn, ms); return fn }, disarm: fn => timers.delete(fn) })
  const msg = type => bridge.receive({ source: frame, data: { type: 'mys-captcha:' + type, nonce: 'n' } })
  bridge.open(); msg('opened'); assert.deepEqual(sent, [])
  msg('ready'); assert.deepEqual(phases, ['ready']); assert.deepEqual(sent, [])
  msg('opened'); assert.deepEqual(phases, ['ready']) // An unsolicited panel signal must not skip the click.
  bridge.open(); bridge.open(); msg('ready'); assert.deepEqual(sent, ['mys-captcha:open']); assert.deepEqual(phases, ['ready', 'opening'])
  assert.deepEqual([...timers.values()], [12000]); [...timers.keys()][0](); msg('opened'); assert.deepEqual(errors, ['open-failed']); assert.deepEqual(phases, ['ready', 'opening'])
})

test('visible panel cancels its own opening watchdog', () => {
  const timers = new Set(), states = [], frame = { postMessage() {} }
  const b = units().createCaptchaBridge({ getWindow: () => frame, nonce: 'n', challenge, now: () => 1000, onError: assert.fail, onResult() {}, onPhase: p => states.push(p), arm: f => { timers.add(f); return f }, disarm: f => timers.delete(f) })
  const msg = type => b.receive({ source: frame, data: { type: 'mys-captcha:' + type, nonce: 'n' } })
  msg('ready'); b.open(); msg('opened'); assert.deepEqual(states, ['ready', 'opening', 'opened']); assert.equal(timers.size, 0); b.dispose()
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
  const bridge = createCaptchaBridge({ getWindow: () => frameWindow, nonce: 'nonce', challenge, onResult: (...v) => results.push(v), onError: () => errors.push(true), arm: () => 0, disarm() {}, now: () => 1000 })
  bridge.receive({ source: frameWindow, data: { nonce: 'nonce', type: 'mys-captcha:ready' } })
  bridge.open()
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

function diagnosticHarness(respond) {
  const stored = new Map(), storage = { getItem: k => stored.get(k), setItem: (k, v) => stored.set(k, v) }
  const api = units(storage)
  const c = api.createSmsController({ request: respond, changed() {}, confirmed() {}, now: () => 1000 })
  c.open(); c.setPhone('13800138000')
  return { c, stored, latest: () => units(storage).readSendDiagnostic() }
}

test('latest local diagnostic survives close and remount, whitelists fields, and distinguishes start, send and polling', async () => {
  let failStart = true
  const h = diagnosticHarness(async path => {
    if (path === 'login/start' && failStart) throw new Error('SECRET 13800138000')
    if (path === 'login/start') return { ok: true, flow: flow({ status: 'phone-ready', resendAt: 0 }) }
    if (path === 'login/send') return { ok: false, flow: flow({ status: 'phone-ready' }), error: { code: 'upstream-rejected', message: 'SECRET' }, diagnostic: { retcode: -777, token: 'SECRET' } }
    if (path === 'login/state') throw new Error('SECRET')
    return { ok: true }
  })
  await h.c.send(); h.c.cancel(); assert.equal(h.latest().step, 'start')
  failStart = false; h.c.open(); h.c.setPhone('13800138000'); await h.c.send()
  assert.equal(h.latest().step, 'send'); assert.equal(h.latest().retcode, -777)
  await h.c.readState(); h.c.cancel(); const d = h.latest()
  assert.equal(d.pollFailed, true); assert.equal(d.result, 'rejected'); assert.equal(d.code, 'upstream-rejected')
  assert.equal(h.stored.size, 1); assert.doesNotMatch([...h.stored.values()][0], /SECRET|13800138000|flow-one|138\*|token/)
})

test('invalid-challenge persists and shows only an allowed field name after polling and remount', async () => {
  const { SendDiagnostic } = units()
  for (const [code, field, expected] of [
    ...['header', 'data', 'session_id', 'mmt_type', 'use_v4', 'gt', 'challenge', 'new_captcha', 'success', 'risk_type'].map(f => ['invalid-challenge', f, f]),
    ['invalid-challenge', 'session_id: SECRET'], ['invalid-challenge', ['gt']], ['invalid-challenge', undefined], ['upstream-rejected', 'gt'],
  ]) {
    const h = diagnosticHarness(async path => {
      if (path === 'login/start') return { ok: true, flow: flow({ status: 'phone-ready', resendAt: 0 }) }
      if (path === 'login/state') throw new Error('poll failed')
      return { ok: false, flow: flow({ status: 'phone-ready' }), error: { code }, diagnostic: { challengeField: field, challengeValue: 'SECRET' } }
    })
    await h.c.send(); await h.c.readState()
    const value = h.latest(), [raw] = h.stored.values()
    assert.equal(value.pollFailed, true); assert.equal(value.code, code)
    assert.equal(value.challengeField, expected); assert.equal(Object.hasOwn(JSON.parse(raw), 'challengeField'), expected !== undefined)
    const text = SendDiagnostic({ t: k => k, value }).props.children[1].props.children[0]
    assert.equal(text.includes('challengeField:'), expected !== undefined)
    if (expected) assert.ok(text.includes(`challengeField: ${expected}`))
    assert.doesNotMatch(raw + text, /SECRET|challengeValue/)
  }
})

test('closed in-flight send stays unconfirmed; late success never overwrites it', async () => {
  let release, started; const entered = new Promise(r => { started = r })
  const h = diagnosticHarness(async path => {
    if (path === 'login/start') return { ok: true, flow: flow({ status: 'phone-ready', resendAt: 0 }) }
    if (path === 'login/send') { started(); return new Promise(r => { release = r }) }
    return { ok: true }
  })
  const attempt = h.c.send(); await entered; h.c.cancel(); release({ ok: true, flow: flow() }); await attempt
  assert.equal(h.latest().step, 'send'); assert.equal(h.latest().result, 'unknown')
})
