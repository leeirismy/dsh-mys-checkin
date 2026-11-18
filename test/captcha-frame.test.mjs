import assert from 'node:assert/strict'
import vm from 'node:vm'
import test from 'node:test'
import { captchaFrameResponse } from '../lib/captcha-frame.js'

const nonce = '12345678-1234-1234-1234-123456789012'
async function frame(version = 'gt4') {
  const html = await captchaFrameResponse().text()
  const messages = [], scripts = [], listeners = new Map(), parent = { postMessage: (message) => messages.push(message) }
  let options, widgetCallback, destroyed = 0, onSuccess
  const widget = { onReady(fn) { fn(); return this }, onSuccess(fn) { onSuccess = fn; return this }, onError() { return this }, onClose() { return this }, showCaptcha() {}, verify() {}, destroy() { destroyed++ }, getValidate() { return version === 'gt4' ? { captcha_id: 'site', lot_number: 'lot', pass_token: 'token', gen_time: '123', captcha_output: 'proof', unexpected: 'SECRET' } : { geetest_challenge: 'challenge', geetest_validate: 'valid', geetest_seccode: 'valid|jordan', unexpected: 'SECRET' } } }
  const window = { parent, addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: (type) => listeners.delete(type), initGeetest4: (o, cb) => { options = o; widgetCallback = cb }, initGeetest: (o, cb) => { options = o; widgetCallback = cb } }
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], { window, document: { createElement: () => ({}), head: { appendChild: script => scripts.push(script) } } })
  const config = { captchaId: 'site', challenge: 'challenge', newCaptcha: true, offline: false, riskType: 'slide', userInfo: '{"session_id":"private"}', target: 'https://evil.invalid', product: 'popup' }
  const send = (data = {}, source = parent) => listeners.get('message')?.({ source, data: { type: 'mys-captcha:init', nonce, version, config, ...data } })
  return { html, send, scripts, messages, listeners, options: () => options, load() { scripts[0].onload(); widgetCallback(widget) }, success: () => onSuccess(), destroyCount: () => destroyed }
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
  f.success(); f.success()
  const successes = f.messages.filter(m => m.type === 'mys-captcha:success')
  assert.equal(successes.length, 1)
  assert.equal(successes[0].nonce, nonce)
  assert.equal(successes[0].result.unexpected, undefined)
  assert.equal(Object.keys(successes[0].result).length, version === 'gt4' ? 5 : 3)
  f.send({ type: 'mys-captcha:destroy' })
  assert.equal(f.destroyCount(), 1)
})

test('failed widget load sends a fixed error, not upstream contents, and never retries scripts', async () => {
  const f = await frame()
  f.send(); f.scripts[0].onerror(new Error('SECRET'))
  f.send()
  assert.equal(f.scripts.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(f.messages.at(-1))), { type: 'mys-captcha:error', nonce, code: 'widget-unavailable' })
})
