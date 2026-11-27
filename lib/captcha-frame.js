import { createHash } from 'node:crypto'

// This function runs only inside an opaque, allow-scripts-only iframe.
// No host requests, account data, dynamic URLs or parent dependencies.
function bootstrap() {
  let nonce, widget, openWidget, opening = false, started = false, done = false
  const parent = window.parent
  const emit = (type, extra = {}) => parent.postMessage({ type: `mys-captcha:${type}`, nonce, ...extra }, '*')
  const fail = () => { if (!done) { done = true; emit('error', { code: 'widget-unavailable' }) } }
  const guarded = fn => (...args) => { try { fn(...args) } catch { fail() } }
  const destroy = () => { done = true; widget?.destroy?.(); widget = null; window.removeEventListener('message', receive) }
  function visible(panel) {
    const r = panel.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight)) return false
    for (let node = panel; node; node = node.parentElement) {
      const style = window.getComputedStyle(node)
      if (node.hidden || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0' || style.contentVisibility === 'hidden') return false
    }
    return true
  }
  function receive(event) {
    if (event.source !== parent) return
    const data = event.data
    if (!data || typeof data !== 'object') return
    if (data.type === 'mys-captcha:destroy' && nonce && data.nonce === nonce) { destroy(); return }
    if (data.type === 'mys-captcha:open') {
      if (!done && !opening && openWidget && nonce === data.nonce) {
        opening = true
        try { openWidget() } catch { fail() }
      }
      return
    }
    if (started || data.type !== 'mys-captcha:init' || !/^[a-f0-9-]{36}$/.test(data.nonce) || !['gt3', 'gt4'].includes(data.version)) return
    const c = data.config
    if (!c || typeof c.captchaId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(c.captchaId)) return
    if (data.version === 'gt3' && (typeof c.challenge !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(c.challenge))) return
    if (c.userInfo != null && (typeof c.userInfo !== 'string' || c.userInfo.length > 4096)) return
    started = true; nonce = data.nonce
    const v4 = data.version === 'gt4'
    const options = v4 ? { captchaId: c.captchaId, product: 'bind', protocol: 'https://', language: c.language === 'eng' ? 'eng' : 'zho' }
      : { gt: c.captchaId, challenge: c.challenge, new_captcha: c.newCaptcha === true, offline: c.offline === true, product: 'bind', lang: c.language === 'eng' ? 'en' : 'zh-cn', https: true }
    if (typeof c.riskType === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(c.riskType)) options.riskType = c.riskType
    if (typeof c.userInfo === 'string') options.userInfo = c.userInfo
    const script = document.createElement('script')
    script.src = v4 ? 'https://static.geetest.com/v4/gt4.js' : 'https://static.geetest.com/static/tools/gt.js'
    script.onerror = fail
    script.onload = () => {
      if (done) return
      try {
        const init = v4 ? window.initGeetest4 : window.initGeetest
        init(options, guarded((instance) => {
          if (done) { instance.destroy?.(); return }
          widget = instance
          instance.onSuccess(() => {
            if (done || !opening) return
            try {
              const raw = instance.getValidate(), result = {}
              const fields = v4 ? ['captcha_id', 'lot_number', 'pass_token', 'gen_time', 'captcha_output'] : ['geetest_challenge', 'geetest_validate', 'geetest_seccode']
              for (const field of fields) {
                const value = raw?.[field]
                if (typeof value !== 'string' || !/^[A-Za-z0-9_~+/.=|:-]{1,8192}$/.test(value)) { fail(); return }
                result[field] = value
              }
              if (JSON.stringify(result).length > 12288) { fail(); return }
              done = true; emit('success', { result })
            } catch { fail() }
          })
          instance.onError(fail)
          instance.onClose?.(fail)
          const panels = v4 ? '[class*="geetest_box"], [class*="geetest_window"]' : '.geetest_panel_box, .geetest_panel_next'
          // Accept instance-suffixed GT4 class tokens, not tip/background descendants.
          const gt4Panel = /(?:^|\s)geetest_(?:box|window)(?:_(?=[a-zA-Z0-9]*[0-9A-Z])[a-zA-Z0-9]{6,})?(?=\s|$)/
          let opened = false, remaining = 120
          function checkPanel() {
            if (!opening || done || opened) return
            try {
              if (Array.from(document.querySelectorAll(panels)).some(panel => (!v4 || gt4Panel.test(panel.className)) && visible(panel))) {
                opened = true; emit('opened')
              }
            } catch { fail() }
          }
          function poll() {
            checkPanel()
            if (!done && !opened && --remaining > 0) window.setTimeout(poll, 100)
          }
          // GT4 next-ready means resources loaded, not necessarily displayed.
          if (v4) instance.onNextReady?.(checkPanel)
          instance.onReady(() => {
            if (done || openWidget) return
            openWidget = () => {
              if (v4) instance.showCaptcha(); else instance.verify()
              poll()
            }
            emit('ready')
          })
        }))
      } catch { fail() }
    }
    document.head.appendChild(script)
  }
  window.addEventListener('message', receive)
  window.addEventListener('pagehide', destroy)
}
const script = `(${bootstrap.toString()})()`
const hash = createHash('sha256').update(script).digest('base64')
const vendors = 'https://*.geetest.com https://*.geevisit.com'
const policy = `default-src 'none'; script-src 'sha256-${hash}' https://static.geetest.com https://static.geevisit.com https://gcaptcha4.geetest.com https://gcaptcha4.geevisit.com https://api.geetest.com https://api.geevisit.com; connect-src ${vendors}; img-src data: blob: ${vendors}; style-src 'unsafe-inline' ${vendors}; font-src ${vendors}; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'`
// The meta policy also applies to the authenticated-fetch/srcDoc Desktop path.
const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><script>${script}</script></body></html>`
export function captchaFrameResponse() {
  return new Response(html, { headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': `${policy}; frame-ancestors 'self'`,
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
  } })
}
