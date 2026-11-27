/** Official CN SMS protocol. Independent implementation; no browser/store access.
 * Protocol reference (data only):
 * https://github.com/IKUNHEIHIE/miyoushe-checkin/blob/main/backend/src/upstream.ts
 * Retrieved source SHA256: 332a0b145b524a334d7aef42c54a04d26b574442f0bf7dde559e1962d16c973d
 * RSA public key is protocol material, not a credential.
 */
import { constants, createHash, publicEncrypt, randomUUID } from 'node:crypto'
import { randomToken } from './ds.js'
import { request } from './http.js'

export const SMS_APP_VERSION = '2.116.0'
const LIFECYCLE_ID = randomUUID()
const EXCHANGE_PATH = '/account/ma-cn-session/app/exchange'
const PASSPORT = 'https://passport-api.mihoyo.com'
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDDvekdPMHN3AYhm/vktJT+YJr7cI5DcsNKqdsx5DZX0gDuWFuIjzdwButrIYPNmRJ1G8ybDIF7oDW2eEpm5sMbL9zs
9ExXCdvqrn51qELbqj0XxtMTIpaCHFSI50PfPpTFV9Xt/hmyVwokoOXFlAEgCn+Q
CgGs52bFoYMtyi+xEQIDAQAB
-----END PUBLIC KEY-----`
const MESSAGES = {
  'bad-phone': '请输入有效的中国大陆手机号',
  'bad-code': '请输入六位短信验证码',
  'invalid-response': '官方登录接口响应格式无效，请重新操作',
  'invalid-challenge': '官方人工验证配置无效，请稍后重新操作',
  'invalid-proof': '人工验证结果无效或不完整，请重新验证',
  'outcome-unknown': '请求结果无法确认，请勿立即重复提交',
  'network-error': '官方查询失败，请稍后重试',
  'challenge-failed': '人工验证未通过，请重新验证',
  'sms-code-invalid': '短信验证码无效或已过期',
  'rate-limited': '官方要求稍后重试，请等待后再操作',
  'upstream-rejected': '官方暂时无法完成此操作，请稍后重试或使用官方客户端处理',
  'official-action-required': '此账号需要先在官方客户端完成实名、真人验证或账号恢复',
  'account-mismatch': '官方返回的凭据账号不一致，未保存本次登录',
}
export class SmsLoginError extends Error {
  constructor(code, diagnostic = {}) {
    super(MESSAGES[code] ?? MESSAGES['invalid-response'])
    this.name = 'SmsLoginError'
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'invalid-response'
    this.diagnostic = {}
    if (code === 'invalid-challenge' && ['header', 'data', 'session_id', 'mmt_type', 'use_v4', 'gt', 'challenge', 'new_captcha', 'success', 'risk_type'].includes(diagnostic.challengeField)) this.diagnostic.challengeField = diagnostic.challengeField
    if (['sms', 'login', 'ltoken', 'cookie'].includes(diagnostic.stage)) this.diagnostic.stage = diagnostic.stage
    if (Number.isInteger(diagnostic.httpStatus) && diagnostic.httpStatus >= 100 && diagnostic.httpStatus <= 599) this.diagnostic.httpStatus = diagnostic.httpStatus
    if (Number.isInteger(diagnostic.retcode) && Math.abs(diagnostic.retcode) <= 2147483647) this.diagnostic.retcode = diagnostic.retcode
  }
}
function fail(code = 'invalid-response', diagnostic) { throw new SmsLoginError(code, diagnostic) }
function record(value, code = 'invalid-response') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code)
  return value
}
function text(value, max = 8192, pattern = /^[A-Za-z0-9_~+/.=:-]+$/, code = 'invalid-response') {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || !pattern.test(value)) fail(code)
  return value
}
function identity(root) {
  record(root)
  return { aid: text(root.aid, 32, /^\d+$/), mid: text(root.mid, 256, /^[A-Za-z0-9_-]+$/), stoken: text(root.stoken) }
}
export function encryptSmsField(value, publicKey = PUBLIC_KEY) {
  return publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(value)).toString('base64')
}
export class SmsChallenge extends Error {
  constructor({ version, sessionId, config }) {
    super('需要用户完成人工验证')
    this.name = 'SmsChallenge'
    // Never accidentally serialize upstream verification-session identifiers.
    Object.defineProperties(this, {
      version: { value: version }, sessionId: { value: sessionId }, config: { value: Object.freeze(config) },
    })
  }
}
function parseChallenge(raw, diagnostic) {
  const invalid = challengeField => fail('invalid-challenge', { ...diagnostic, challengeField })
  const object = (v, field) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) invalid(field)
    return v
  }
  const decode = (v, field) => {
    let parsed
    try { parsed = JSON.parse(v) } catch { invalid(field) }
    return object(parsed, field)
  }
  const id = (v, field, max, pattern = /^[A-Za-z0-9_-]+$/) => {
    if (typeof v !== 'string' || !v.length || v.length > max || !pattern.test(v)) invalid(field)
    return v
  }
  const flag = (v, field, fallback) => {
    if (v === undefined || v === null) return fallback
    if ([true, 1, '1', 'true'].includes(v)) return true
    if ([false, 0, '0', 'false'].includes(v)) return false
    invalid(field)
  }
  if (raw.length > 16384) invalid('header')
  const envelope = decode(raw, 'header')
  const sessionId = id(envelope.session_id, 'session_id', 2048, /^[A-Za-z0-9_.:-]+$/)
  if (envelope.mmt_type !== undefined && ![1, '1'].includes(envelope.mmt_type)) invalid('mmt_type')
  const nested = envelope.data
  // The whole header is already bounded; apply the nested string limit before its second JSON decode.
  if (typeof nested === 'string' && nested.length > 12288) invalid('data')
  const data = typeof nested === 'string' ? decode(nested, 'data') : object(nested, 'data')
  const version = flag(data.use_v4, 'use_v4', false) ? 'gt4' : 'gt3'
  const absent = v => v == null || v === ''
  const config = {
    captchaId: id(data.gt, 'gt', 256),
    challenge: version === 'gt4' && absent(data.challenge) ? null : id(data.challenge, 'challenge', 1024),
    newCaptcha: flag(data.new_captcha, 'new_captcha', null),
    offline: !flag(data.success, 'success', true),
    product: 'bind', language: 'zho',
    riskType: absent(data.risk_type) ? null : id(data.risk_type, 'risk_type', 64),
    userInfo: JSON.stringify({ session_id: sessionId }),
  }
  return new SmsChallenge({ version, sessionId, config })
}
const PROOF_FIELDS = {
  gt3: ['geetest_challenge', 'geetest_validate', 'geetest_seccode'],
  gt4: ['captcha_id', 'lot_number', 'pass_token', 'gen_time', 'captcha_output'],
}
export function validateCaptchaResult(version, result) {
  const fields = Object.hasOwn(PROOF_FIELDS, version) ? PROOF_FIELDS[version] : null
  if (!fields) fail('invalid-proof')
  record(result, 'invalid-proof')
  const clean = {}
  for (const key of fields) clean[key] = text(result[key], 8192, /^[A-Za-z0-9_~+/.=|:-]+$/, 'invalid-proof')
  if (Buffer.byteLength(JSON.stringify(clean)) > 12288) fail('invalid-proof')
  return clean
}
export function makeAigis(sessionId, result) {
  text(sessionId, 2048, /^[A-Za-z0-9_.:-]+$/, 'invalid-proof')
  const version = Object.hasOwn(record(result, 'invalid-proof'), 'captcha_id') ? 'gt4' : 'gt3'
  return `${sessionId};${Buffer.from(JSON.stringify(validateCaptchaResult(version, result))).toString('base64')}`
}
function businessError(retcode, diagnostic) {
  if (retcode === -3102) fail('challenge-failed', diagnostic)
  if (retcode === -3202 || retcode === -3207) fail('sms-code-invalid', diagnostic)
  if (retcode === -3101) fail('rate-limited', diagnostic)
  fail('upstream-rejected', diagnostic)
}
// Display metadata was historically free-form. Preserve header-safe Latin-1;
// unsupported Unicode/control/oversized values get an SMS-only safe fallback.
// Never mutate saved configuration or let cosmetic metadata prevent mounting.
function deviceHeader(value, fallback) {
  return typeof value === 'string' && value.length <= 128 && /^[\x20-\x7E\xA0-\xFF]+$/.test(value) ? value : fallback
}
export class SmsLoginProtocol {
  constructor({ deviceId, device = {}, appVersion = SMS_APP_VERSION }) {
    this.headers = Object.freeze({
      'content-type': 'application/json',
      'x-rpc-device_id': text(deviceId, 128, /^[A-Za-z0-9_-]+$/),
      'x-rpc-device_name': deviceHeader(device.name, 'Self-hosted WebUI'),
      'x-rpc-device_model': deviceHeader(device.model, 'Windows'),
      'x-rpc-app_id': 'bll8iq97cem8', 'x-rpc-client_type': '2',
      'x-rpc-app_version': text(appVersion, 32, /^\d+\.\d+\.\d+$/),
      'x-rpc-game_biz': 'bbs_cn',
      'User-Agent': `Mozilla/5.0 miHoYoBBS/${appVersion}`,
      Referer: 'https://user.miyoushe.com/',
    })
  }
  async call(path, { stage, body, proof, timeoutMs }) {
    const payload = JSON.stringify(body)
    const headers = { ...this.headers }
    if (path === EXCHANGE_PATH) {
      const t = Math.floor(Date.now() / 1000), r = randomToken()
      const digest = createHash('md5').update(`salt=JwYDpKvLj6MrMqqYU6jTKF17KNO2PXoS&t=${t}&r=${r}&b=${payload}&q=`).digest('hex')
      headers.DS = `${t},${r},${digest}`
      headers['x-rpc-sdk_version'] = headers['x-rpc-account_version'] = '2.44.0'
      headers['x-rpc-lifecycle_id'] = LIFECYCLE_ID
    }
    if (proof !== undefined) headers['x-rpc-aigis'] = text(proof, 20000, /^[A-Za-z0-9_.:-]+;[A-Za-z0-9+/=]+$/, 'invalid-proof')
    let response
    try {
      response = await request(PASSPORT + path, { method: 'POST', headers, body: payload, timeoutMs, retries: 0, maxResponseBytes: 131072 })
    } catch { fail('outcome-unknown', { stage }) }
    const diagnostic = { stage, httpStatus: response.status }
    const aigis = response.headers.get('x-rpc-aigis')
    if (aigis !== null) throw parseChallenge(aigis, { ...diagnostic, retcode: response.json?.retcode })
    if (!response.ok) fail('outcome-unknown', diagnostic)
    if (!response.json || typeof response.json !== 'object' || Array.isArray(response.json) || !Number.isInteger(response.json.retcode)) {
      fail('outcome-unknown', diagnostic)
    }
    diagnostic.retcode = response.json.retcode
    if (diagnostic.retcode !== 0) businessError(diagnostic.retcode, diagnostic)
    return record(response.json.data)
  }
  async sendSms({ phone, proof }) {
    text(phone, 11, /^1[3-9]\d{9}$/, 'bad-phone')
    const data = await this.call('/account/ma-cn-verifier/verifier/createLoginCaptcha', {
      stage: 'sms', proof, body: { area_code: encryptSmsField('+86'), mobile: encryptSmsField(phone) },
    })
    if (!Number.isFinite(data.countdown) || data.countdown < 0) fail()
    return { actionType: text(data.action_type, 128), countdown: Math.min(3600, Math.max(60, Math.ceil(data.countdown))) }
  }
  async login({ phone, code, actionType, proof }) {
    text(phone, 11, /^1[3-9]\d{9}$/, 'bad-phone')
    text(code, 6, /^\d{6}$/, 'bad-code')
    text(actionType, 128)
    const data = await this.call('/account/ma-cn-passport/app/loginByMobileCaptcha', {
      stage: 'login', proof, body: { area_code: encryptSmsField('+86'), mobile: encryptSmsField(phone), captcha: code, action_type: actionType },
    })
    if (data.need_realperson || data.realname_info?.required || data.reactivate_info?.required) fail('official-action-required')
    const user = record(data.user_info), token = record(data.token)
    if (token.token_type !== 1) fail()
    return identity({ aid: user.aid, mid: user.mid, stoken: token.token })
  }
  async exchange({ root, proof, timeoutMs }, type, stage) {
    const r = identity(root)
    if (!r.stoken.startsWith('v2_')) fail('invalid-response', { stage })
    const data = await this.call(EXCHANGE_PATH, { stage, proof, timeoutMs,
      body: { dst_token_type: type, src_token: { token: r.stoken, token_type: 1 }, mid: r.mid } })
    const user = data.user_info, ticket = data.token
    if (!user?.aid || !user.mid || ticket?.token_type !== type) fail('invalid-response', { stage })
    if (user.aid !== r.aid || user.mid !== r.mid) fail('account-mismatch', { stage })
    return text(ticket.token)
  }
  async getLToken(options) { return { ltoken: await this.exchange(options, 2, 'ltoken') } }
  async getCookieToken(options) { return { cookieToken: await this.exchange(options, 4, 'cookie') } }
}
