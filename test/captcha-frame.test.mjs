import assert from 'node:assert/strict'
import vm from 'node:vm'
import test from 'node:test'
import { captchaFrameResponse } from '../lib/captcha-frame.js'

const nonce = '12345678-1234-1234-1234-123456789012'
async function frame(version = 'gt4') {
  const html = await captchaFrameResponse().text()
  const messages = [], scripts = [], listeners = new Map(), parent = { postMessage: (message) => messages.push(message) }
  let options, widgetCallback, destroyed = 0, onSuccess
  const calls = [], panels = [], timers = []
  let nextReady
  const tick = () => timers.shift()?.()
  const widget = { onNextReady(fn) { nextReady = fn; return this }, onReady(fn) { fn(); return this }, onSuccess(fn) { onSuccess = fn; return this }, onError() { return this }, onClose() { return this }, showCaptcha() { calls.push('showCaptcha') }, verify() { calls.push('verify') }, destroy() { destroyed++ }, getValidate() { return version === 'gt4' ? { captcha_id: 'site', lot_number: 'lot', pass_token: 'token', gen_time: '123', captcha_output: 'proof', unexpected: 'SECRET' } : { geetest_challenge: 'challenge', geetest_validate: 'valid', geetest_seccode: 'valid|jordan', unexpected: 'SECRET' } } }
  const window = { parent, addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: (type) => listeners.delete(type), initGeetest4: (o, cb) => { options = o; widgetCallback = cb }, initGeetest: (o, cb) => { options = o; widgetCallback = cb } }
  Object.assign(window, { innerWidth: 480, innerHeight: 420, getComputedStyle: el => el.style, setTimeout: fn => timers.push(fn) })
  const document = {
    createElement: () => ({}), head: { appendChild: script => scripts.push(script) },
    querySelectorAll: selectors => panels.filter(panel => selectors.split(/,\s*/).some(selector => {
      if (selector.startsWith('.')) return panel.className.split(/\s+/).includes(selector.slice(1))
      const contains = selector.match(/^\[class\*="([^"]+)"\]$/)
      return contains && panel.className.includes(contains[1])
    })),
  }
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], { window, document })
  const config = { captchaId: 'site', challenge: 'challenge', newCaptcha: true, offline: false, riskType: 'slide', userInfo: '{"session_id":"private"}', target: 'https://evil.invalid', product: 'popup' }
  const send = (data = {}, source = parent) => listeners.get('message')?.({ source, data: { type: 'mys-captcha:init', nonce, version, config, ...data } })
  return { html, send, scripts, messages, calls, listeners, panels, timers, tick, widget, resources: () => nextReady?.(), options: () => options, load() { scripts[0].onload(); widgetCallback(widget) }, success: () => onSuccess(), destroyCount: () => destroyed }
}

test('static CAPTCHA document is no-store and refuses host/network capabilities outside the official widget', async () => {
  const response = captchaFrameResponse()
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(response.headers.get('content-type'), /^text\/html/)
  const csp = response.headers.get('content-security-policy')
  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /form-action 'none'/)
  assert.match(csp, /base-uri 'none'/)
  const scriptSources = csp.split(';').find(v => v.trim().startsWith('script-src')).split(/\s+/)
  // Official loaders use JSONP, so these API endpoints need script permission,
  // not merely connect-src. This asserts policy behavior, not source spelling.
  for (const origin of ['https://gcaptcha4.geetest.com', 'https://gcaptcha4.geevisit.com', 'https://api.geetest.com']) assert.ok(scriptSources.includes(origin))
  assert.doesNotMatch(csp, /unsafe-eval|http:|connect-src[^;]*'self'/)
  const html = await response.text()
  assert.match(html, /http-equiv="Content-Security-Policy"/)
  assert.doesNotMatch(html, /api\/mys|phone|stoken|cookie_token|https:\/\/evil/)
})

for (const version of ['gt4', 'gt3']) test(`${version} sandbox only initializes from its parent and returns whitelisted proof once`, async () => {
  const f = await frame(version)
  f.send({}, {})
  f.send({ nonce: 'bad' })
  assert.equal(f.scripts.length, 0)
  f.send()
  assert.equal(f.scripts.length, 1)
  assert.equal(f.scripts[0].src, version === 'gt4' ? 'https://static.geetest.com/v4/gt4.js' : 'https://static.geetest.com/static/tools/gt.js')
  f.load()
  assert.equal(f.options().target, undefined)
  assert.equal(f.options().product, 'bind')
  if (version === 'gt4') assert.equal(f.options().protocol, 'https://')
  f.success()
  assert.deepEqual(f.messages.map(m => m.type), ['mys-captcha:ready'])
  f.send({ type: 'mys-captcha:open' })
  f.success(); f.success()
  const successes = f.messages.filter(m => m.type === 'mys-captcha:success')
  assert.equal(successes.length, 1)
  assert.equal(successes[0].nonce, nonce)
  assert.equal(successes[0].result.unexpected, undefined)
  assert.equal(Object.keys(successes[0].result).length, version === 'gt4' ? 5 : 3)
  f.send({ type: 'mys-captcha:destroy' })
  assert.equal(f.destroyCount(), 1)
})

for (const version of ['gt4', 'gt3']) test(`${version} waits for one authenticated open after ready`, async () => {
  const f = await frame(version), open = { type: 'mys-captcha:open' }
  f.send(); f.send(open); f.load()
  assert.deepEqual(f.messages.map(m => m.type), ['mys-captcha:ready'])
  f.send(open, {}); f.send({ ...open, nonce: 'wrong' })
  assert.deepEqual(f.calls, [])
  f.send(open); f.send(open)
  assert.deepEqual(f.calls, [version === 'gt4' ? 'showCaptcha' : 'verify'])
})

const rect = { width: 300, height: 260, left: 20, top: 30, right: 320, bottom: 290 }
for (const [version, className] of [['gt4', 'geetest_box'], ['gt4', 'geetest_window'], ['gt4', 'other geetest_box_a5F3wm89'], ['gt4', 'geetest_window_123abc'], ['gt3', 'geetest_panel_box'], ['gt3', 'geetest_panel_next']]) {
  test(`${version} reports a visible ${className} once, not readiness, resources, or a hidden panel`, async () => {
    const f = await frame(version)
    const ancestor = { style: { opacity: '0' } }
    const panel = { className, style: {}, parentElement: ancestor, getBoundingClientRect: () => rect }
    for (const name of ['geetest_mask', 'geetest_box_tip', 'geetest_window_background', 'not_geetest_box_ab12cd']) {
      f.panels.push({ ...panel, className: name, parentElement: null })
    }
    f.panels.push(panel)
    f.send(); f.load(); f.resources(); f.send({ type: 'mys-captcha:open' }); f.resources(); f.tick()
    ancestor.style.opacity = '1'
    panel.getBoundingClientRect = () => ({ ...rect, left: 500, right: 800 })
    f.tick()
    panel.getBoundingClientRect = () => ({ ...rect, height: 0, bottom: rect.top })
    f.tick()
    assert.deepEqual(f.messages.map(m => m.type), ['mys-captcha:ready'])
    panel.getBoundingClientRect = () => rect
    f.tick(); f.resources(); f.tick()
    assert.deepEqual(f.messages.map(m => [m.type, m.nonce]), [['mys-captcha:ready', nonce], ['mys-captcha:opened', nonce]])
  })
}

test('no known panel leaves the timeout to the parent and stops polling', async () => {
  const f = await frame()
  f.send(); f.load(); f.send({ type: 'mys-captcha:open' }); f.resources()
  for (let i = 0; i < 500 && f.timers.length; i++) f.tick()
  assert.equal(f.timers.length, 0)
  assert.deepEqual(f.messages.map(m => m.type), ['mys-captcha:ready'])
})

for (const stage of ['onNextReady', 'showCaptcha']) test(`${stage} exceptions send only a fixed terminal error`, async () => {
  const f = await frame()
  f.widget[stage] = () => { throw new Error('SECRET') }
  f.send(); f.load(); f.send({ type: 'mys-captcha:open' }); f.send({ type: 'mys-captcha:open' })
  const errors = f.messages.filter(m => m.type === 'mys-captcha:error')
  assert.deepEqual(JSON.parse(JSON.stringify(errors)), [{ type: 'mys-captcha:error', nonce, code: 'widget-unavailable' }])
  assert.ok(!f.messages.some(m => m.type === 'mys-captcha:opened'))
})

test('failed widget load sends a fixed error, not upstream contents, and never retries scripts', async () => {
  const f = await frame()
  f.send(); f.scripts[0].onerror(new Error('SECRET'))
  f.send()
  assert.equal(f.scripts.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(f.messages.at(-1))), { type: 'mys-captcha:error', nonce, code: 'widget-unavailable' })
})
