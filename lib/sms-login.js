/** Official CN SMS protocol. Independent implementation; no browser/store access.
 * Protocol reference (data only):
 * https://github.com/IKUNHEIHIE/miyoushe-checkin/blob/main/backend/src/upstream.ts
 * Retrieved source SHA256: 332a0b145b524a334d7aef42c54a04d26b574442f0bf7dde559e1962d16c973d
 * RSA public key is protocol material, not a credential.
 */
import { constants, publicEncrypt } from 'node:crypto'
import { request } from './http.js'

export const SMS_APP_VERSION = '2.116.0'
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
function parseChallenge(raw) {
  const code = 'invalid-challenge'
  if (raw.length > 16384) fail(code)
  let envelope, data
  try {
    envelope = record(JSON.parse(raw), code)
    if (typeof envelope.data !== 'string' || envelope.data.length > 12288) fail(code)
    data = record(JSON.parse(envelope.data), code)
  } catch { fail(code) }
  const sessionId = text(envelope.session_id, 2048, /^[A-Za-z0-9_.:-]+$/, code)
  if (data.use_v4 !== undefined && typeof data.use_v4 !== 'boolean') fail(code)
  const version = data.use_v4 === true ? 'gt4' : 'gt3'
  const config = {
    captchaId: text(data.gt, 256, /^[A-Za-z0-9_-]+$/, code),
    challenge: data.challenge === undefined ? null : text(data.challenge, 1024, /^[A-Za-z0-9_-]+$/, code),
    newCaptcha: data.new_captcha === undefined ? null : data.new_captcha,
    offline: data.success === 0,
    product: 'bind', language: 'zho',
    riskType: data.risk_type === undefined ? null : text(data.risk_type, 64, /^[A-Za-z0-9_-]+$/, code),
    userInfo: JSON.stringify({ session_id: sessionId }),
  }
  if (config.newCaptcha !== null && typeof config.newCaptcha !== 'boolean') fail(code)
  if (data.success !== undefined && ![0, 1].includes(data.success)) fail(code)
  if (version === 'gt3' && config.challenge === null) fail(code)
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
  async call(path, { stage, body, root, proof }) {
    const method = body === undefined ? 'GET' : 'POST'
    const headers = { ...this.headers }
    if (root) {
      const r = identity(root)
      headers.Cookie = `stuid=${r.aid}; stoken=${r.stoken}; mid=${r.mid}`
    }
    if (proof !== undefined) headers['x-rpc-aigis'] = text(proof, 20000, /^[A-Za-z0-9_.:-]+;[A-Za-z0-9+/=]+$/, 'invalid-proof')
    let response
    try {
      response = await request(PASSPORT + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), retries: 0, maxResponseBytes: 131072 })
    } catch { fail(method === 'POST' ? 'outcome-unknown' : 'network-error', { stage }) }
    const diagnostic = { stage, httpStatus: response.status }
    const aigis = response.headers.get('x-rpc-aigis')
    if (aigis !== null) throw parseChallenge(aigis)
    if (!response.ok) fail(method === 'POST' ? 'outcome-unknown' : 'network-error', diagnostic)
    if (!response.json || typeof response.json !== 'object' || Array.isArray(response.json) || !Number.isInteger(response.json.retcode)) {
      fail(method === 'POST' ? 'outcome-unknown' : 'invalid-response', diagnostic)
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
  async getLToken({ root, proof }) {
    const r = identity(root)
    const data = await this.call('/account/auth/api/getLTokenBySToken', { stage: 'ltoken', root: r, proof })
    if (data.uid !== undefined && text(data.uid, 32, /^\d+$/) !== r.aid) fail('account-mismatch')
    return { ltoken: text(data.ltoken) }
  }
  async getCookieToken({ root, proof }) {
    const r = identity(root)
    const data = await this.call('/account/auth/api/getCookieAccountInfoBySToken', { stage: 'cookie', root: r, proof })
    const uid = text(data.uid, 32, /^\d+$/)
    if (uid !== r.aid) fail('account-mismatch')
    return { cookieToken: text(data.cookie_token) }
  }
}
