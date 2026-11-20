/** In-memory, single-owner login flow. No persistence and no sign-in writes. */
import { randomUUID } from 'node:crypto'
import { withRequestGuard } from './http.js'
import { SmsChallenge, SmsLoginError, makeAigis, validateCaptchaResult } from './sms-login.js'

const TTL = 300000, CHALLENGE_TTL = 120000
const ERRORS = {
  'flow-changed': '登录流程已变更，请重新操作',
  'flow-expired': '登录流程已过期，请重新发起登录',
  'flow-busy': '当前登录请求仍在处理中，请稍候',
  'flow-state': '当前流程不能执行此操作，请重新发起登录',
  'sms-cooldown': '请等待倒计时结束后再发送短信',
  'challenge-stale': '人工验证已变更或已使用，请使用当前验证',
  'challenge-expired': '人工验证已过期，请重新发起验证',
  'challenge-limit': '人工验证重试次数已达上限，请稍后重新登录',
  'login-failed': '登录请求未完成，请重新发起登录',
}
export class SmsFlowError extends Error {
  constructor(code) {
    super(ERRORS[code] ?? ERRORS['login-failed'])
    this.name = 'SmsFlowError'
    this.code = Object.hasOwn(ERRORS, code) ? code : 'login-failed'
  }
}
function fail(code) { throw new SmsFlowError(code) }
function publicError(error) {
  return { code: error.code, message: error.message, ...(error.diagnostic ? { diagnostic: { ...error.diagnostic } } : {}) }
}
export class SmsLoginFlow {
  #flow = null
  #resendAt = 0
  #disposed = false
  #timer = null
  constructor({ protocol, now = Date.now, isCurrent = () => true }) {
    this.protocol = protocol
    this.now = now
    this.isCurrent = isCurrent
  }
  #purge(f) {
    f.phone = undefined
    f.code = undefined
    f.actionType = undefined
    f.root = undefined
    f.ltoken = undefined
    f.challenge = null
  }
  #expire(f) {
    this.#purge(f)
    f.status = 'expired'
    f.error = publicError(new SmsFlowError('flow-expired'))
  }
  #live(f) {
    return !this.#disposed && this.#flow === f && this.now() < f.expiresAt && this.isCurrent(f.flowId)
  }
  #check(f) {
    if (this.#flow === f && this.now() >= f.expiresAt) {
      this.#expire(f)
      fail('flow-expired')
    }
    if (!this.#live(f)) {
      this.#purge(f)
      fail('flow-changed')
    }
  }
  #get(id) {
    const f = this.#flow
    if (!f || f.flowId !== id) fail('flow-changed')
    this.#check(f)
    return f
  }
  #idle(f) { if (f.busy) fail('flow-busy') }
  start(phone) {
    if (this.#disposed) fail('flow-changed')
    if (typeof phone !== 'string' || !/^1[3-9]\d{9}$/.test(phone)) throw new SmsLoginError('bad-phone')
    this.cancel()
    const createdAt = this.now()
    const f = this.#flow = {
      flowId: randomUUID(), createdAt, expiresAt: createdAt + TTL,
      phone, phoneMasked: `${phone.slice(0, 3)}****${phone.slice(-4)}`,
      status: 'phone-ready', checkpoint: 'sms', busy: false,
      codeTries: 0, challengeTries: 0, challenge: null, error: null,
    }
    this.#timer = setTimeout(() => { if (this.#flow === f) this.#expire(f) }, TTL)
    this.#timer.unref?.()
    return this.view()
  }
  view() {
    const f = this.#flow
    if (!f) return null
    if (this.now() >= f.expiresAt) this.#expire(f)
    const c = f.challenge
    return {
      flowId: f.flowId, status: f.status, createdAt: f.createdAt, expiresAt: f.expiresAt,
      resendAt: this.#resendAt, phoneMasked: f.phoneMasked, busy: f.busy,
      challenge: c ? { challengeId: c.id, version: c.version, expiresAt: c.expiresAt, checkpoint: f.checkpoint } : null,
      error: f.error ? structuredClone(f.error) : null,
    }
  }
  async send(id) {
    const f = this.#get(id)
    this.#idle(f)
    if (!f.phone || ['candidate-ready', 'error', 'expired'].includes(f.status)) fail('flow-state')
    if (this.now() < this.#resendAt) fail('sms-cooldown')
    // Reserve before dispatch; unknown outcomes and cancellation cannot undo it.
    this.#resendAt = this.now() + 60000
    f.code = f.root = f.ltoken = f.actionType = undefined
    f.challenge = null
    f.checkpoint = 'sms'
    f.challengeTries = 0
    return this.#run(f, () => this.#advance(f))
  }
  async submit(id, code) {
    const f = this.#get(id)
    this.#idle(f)
    if (f.status !== 'code-sent' || !f.actionType || f.codeTries >= 5) fail('flow-state')
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new SmsLoginError('bad-code')
    f.codeTries++
    f.code = code
    f.checkpoint = 'login'
    f.challengeTries = 0
    return this.#run(f, () => this.#advance(f))
  }
  async solve(id, challengeId, result) {
    const f = this.#get(id)
    this.#idle(f)
    const c = f.challenge
    if (!c || c.id !== challengeId) fail('challenge-stale')
    if (this.now() >= c.expiresAt) {
      f.challenge = null
      if (f.checkpoint === 'sms') f.status = 'phone-ready'
      else { this.#purge(f); f.status = 'error' }
      fail('challenge-expired')
    }
    const clean = validateCaptchaResult(c.version, result)
    if (c.version === 'gt4' && clean.captcha_id !== c.config.captchaId) throw new SmsLoginError('invalid-proof')
    const proof = makeAigis(c.sessionId, clean)
    f.challenge = null // one-shot even if the following request fails
    f.challengeTries++
    return this.#run(f, () => this.#advance(f, proof))
  }
  async #run(f, operation) {
    this.#check(f)
    f.busy = true
    f.error = null
    f.status = 'processing'
    let settled
    try {
      settled = await withRequestGuard(() => this.#live(f), async () => {
        try {
          const result = await operation()
          this.#check(f)
          return result
        } catch (error) {
          this.#check(f)
          if (error instanceof SmsChallenge) {
            if (f.challengeTries >= 3) {
              this.#purge(f)
              f.status = 'error'
              const limit = new SmsFlowError('challenge-limit')
              f.error = publicError(limit)
              throw limit
            }
            const c = f.challenge = {
              id: randomUUID(), version: error.version, sessionId: error.sessionId,
              config: error.config, expiresAt: Math.min(f.expiresAt, this.now() + CHALLENGE_TTL),
            }
            f.status = 'verification-required'
            return { flow: this.view(), challenge: { challengeId: c.id, version: c.version, expiresAt: c.expiresAt, config: { ...c.config } } }
          }
          const safe = error instanceof SmsLoginError || error instanceof SmsFlowError ? error : new SmsFlowError('login-failed')
          f.error = publicError(safe)
          if (f.checkpoint === 'sms') f.status = 'phone-ready'
          else if (safe.code === 'sms-code-invalid' && f.codeTries < 5) {
            f.code = undefined
            f.status = 'code-sent'
          } else { this.#purge(f); f.status = 'error' }
          throw safe
        }
      })
    } finally { f.busy = false }
    settled.flow = this.view()
    return settled
  }
  async #advance(f, initialProof) {
    let proof = initialProof
    if (f.checkpoint === 'sms') {
      const data = await this.protocol.sendSms({ phone: f.phone, proof })
      this.#check(f)
      this.#resendAt = Math.max(this.#resendAt, this.now() + Math.min(3600, Math.max(60, data.countdown)) * 1000)
      f.actionType = data.actionType
      f.status = 'code-sent'
      f.checkpoint = 'login'
      f.challengeTries = 0
      return { flow: this.view() }
    }
    if (f.checkpoint === 'login') {
      const root = await this.protocol.login({ phone: f.phone, code: f.code, actionType: f.actionType, proof })
      this.#check(f)
      f.root = root
      f.code = undefined
      f.checkpoint = 'ltoken'
      f.challengeTries = 0
      proof = undefined
    }
    if (f.checkpoint === 'ltoken') {
      const data = await this.protocol.getLToken({ root: f.root, proof })
      this.#check(f)
      f.ltoken = data.ltoken
      f.checkpoint = 'cookie'
      f.challengeTries = 0
      proof = undefined
    }
    if (f.checkpoint === 'cookie') {
      const data = await this.protocol.getCookieToken({ root: f.root, proof })
      this.#check(f)
      const candidate = { ...f.root, ltoken: f.ltoken, cookieToken: data.cookieToken }
      this.#purge(f)
      f.checkpoint = 'verify'
      f.status = 'candidate-ready'
      return { flow: this.view(), candidate }
    }
    fail('flow-state')
  }
  cancel(id) {
    if (id !== undefined && this.#flow?.flowId !== id) return false
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    if (this.#flow) this.#purge(this.#flow)
    this.#flow = null
    return true
  }
  dispose() { this.cancel(); this.#disposed = true }
}
