/**
 * Community sign-in only. Protocol values/field mapping adapted from
 * MihoyoBBSTools (MIT, Womsxd); see THIRD_PARTY_NOTICES.md.
 * No task execution, CAPTCHA solving, or game API policy is shared here.
 */
import { DABIEYE } from './config.js'
import { cookieHeader, credentialCookies, ensureIdentityCookies, sessionStoken, signDs2, appUserAgent } from './ds.js'
import { request } from './http.js'
import { dayKey } from './tz.js'

const SIGN_URL = 'https://bbs-api.miyoushe.com/apihub/app/api/signIn'
const BALANCE_URL = 'https://bbs-api.miyoushe.com/apihub/wapi/getUserMissionsState?point_sn=myb'
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const cookieValue = (value) => typeof value === 'string' && /^[^;\s]+$/.test(value) ? value : null
const numericId = (value) => typeof value === 'string' && /^\d+$/.test(value) ? value : null

function identity(auth) {
  const cookies = auth?.cookies
  const accountId = [auth?.aid, auth?.stuid, cookies?.stuid, cookies?.ltuid, cookies?.ltuid_v2, cookies?.account_id, cookies?.account_id_v2, cookies?.login_uid].map(numericId).find(Boolean) ?? null
  const token = cookieValue(sessionStoken(cookies))
  const v2 = Boolean(cookies?.stoken_v2) || token?.startsWith('v2_')
  const mid = [auth?.mid, cookies?.mid, cookies?.ltmid_v2, cookies?.account_mid_v2].map(cookieValue).find(Boolean) ?? null
  return { accountId, token, v2, mid }
}

/** Public capability deliberately carries no token or mid. */
export function communityCapability(auth) {
  const { accountId, token, v2, mid } = identity(auth)
  const reason = !token ? 'no-stoken' : !accountId ? 'missing-account' : v2 && !mid ? 'missing-mid' : null
  return { available: reason === null, accountId, reason }
}

const messages = {
  success: '社区接口已接受签到（未独立验证积分到账）',
  captcha: '需要人工验证，已停止本轮后续签到',
  expired: '社区凭据已失效，请重新使用短信登录',
  'auth-unavailable': '社区凭据不完整，请重新使用短信登录',
  error: '社区接口返回失败',
  unknown: '社区请求结果不明，本轮不会自动重发',
}
const result = (outcome, retcode) => ({ outcome, ...(typeof retcode === 'number' && Number.isFinite(retcode) ? { retcode } : {}), message: messages[outcome] })

/** Never trust upstream error text, even on retcode 0. Risks override success. */
function classify(response) {
  const json = response.json
  const data = object(json) && object(json.data) ? json.data : null
  if (json?.retcode === 1034 || data?.is_risk === true || (typeof data?.risk_code === 'number' && data.risk_code !== 0)) return result('captcha', json?.retcode)
  if (!response.ok || !object(json) || typeof json.retcode !== 'number' || !Number.isFinite(json.retcode)) return result('unknown')
  if ((json.message !== undefined && typeof json.message !== 'string') || (json.data !== undefined && json.data !== null && !object(json.data))) return result('unknown', json.retcode)
  // Unexplained verification payloads cannot count as accepted sign-ins.
  if (data && ['gt', 'challenge', 'captcha', 'geetest', 'verification', 'verify_url'].some((key) => data[key])) return result('unknown', json.retcode)
  if (json.retcode === -100) return result('expired', -100)
  return result(json.retcode === 0 ? 'success' : 'error', json.retcode)
}

function appHeaders({ config, deviceId, auth }) {
  const { accountId, token, mid, v2 } = identity(auth)
  const cookies = { stuid: accountId, stoken: token, ...(v2 ? { mid } : {}) }
  return {
    Cookie: cookieHeader(cookies),
    'x-rpc-client_type': '2',
    'x-rpc-app_version': config.community.client.appVersion,
    'x-rpc-sys_version': config.device.sysVersion,
    'x-rpc-channel': config.device.channel,
    'x-rpc-device_id': deviceId,
    'x-rpc-device_name': config.device.name,
    'x-rpc-device_model': config.device.model,
    'x-rpc-h265_supported': '1',
    'x-rpc-verify_key': 'bll8iq97cem8',
    'x-rpc-csm_source': 'discussion',
    Referer: 'https://app.mihoyo.com',
    'Content-Type': 'application/json; charset=UTF-8',
    'User-Agent': 'okhttp/4.9.3',
  }
}

export async function signCommunity({ config, deviceId, auth }) {
  if (!communityCapability(auth).available) return result('auth-unavailable')
  const body = JSON.stringify({ gids: DABIEYE.id })
  try {
    const headers = appHeaders({ config, deviceId, auth })
    headers.DS = signDs2({ salt: config.community.client.salt, body })
    return classify(await request(SIGN_URL, { method: 'POST', body, headers, retries: 0 }))
  } catch {
    // A write might have arrived. Never retry or expose the transport exception.
    return result('unknown')
  }
}

export async function getCommunityBalance({ config, deviceId, auth, now = Date.now(), strict = false }) {
  const failure = (value) => ({ ok: false, outcome: value.outcome, error: { code: value.outcome, message: value.message, at: now } })
  if (!communityCapability(auth).available) return failure(result('auth-unavailable'))
  const { accountId, mid } = identity(auth)
  const v2 = cookieValue(auth?.cookies?.cookie_token_v2)
  const token = v2 ?? cookieValue(auth?.cookies?.cookie_token)
  if (strict && (!token || (v2 && !mid))) return failure(result('auth-unavailable'))
  const cookies = !strict ? credentialCookies(ensureIdentityCookies({ ...auth.cookies }, { aid: accountId, mid }))
    : v2 ? { account_id_v2: accountId, account_mid_v2: mid, cookie_token_v2: token }
    : { account_id: accountId, cookie_token: token }
  try {
    const response = await request(BALANCE_URL, {
      method: 'GET', retries: 0, ...(strict ? { maxResponseBytes: 131072 } : {}),
      headers: {
        Cookie: cookieHeader(cookies), Accept: 'application/json, text/plain, */*',
        Origin: 'https://webstatic.mihoyo.com', Referer: 'https://webstatic.mihoyo.com',
        'User-Agent': appUserAgent(config.community.client.appVersion),
        'X-Requested-With': 'com.mihoyo.hyperion',
      },
    })
    const value = classify(response)
    if (strict && response.headers.has('x-rpc-aigis')) return failure(result('captcha'))
    if (value.outcome !== 'success') return failure(value)
    if (!object(response.json.data)) return failure(result('unknown'))
    const data = response.json.data
    const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
    if (strict && (!Array.isArray(data.states) || !data.states.every(item => object(item) && Number.isSafeInteger(item.mission_id) && item.mission_id >= 0 && (item.is_get_award === undefined || typeof item.is_get_award === 'boolean')) || [data.total_points, data.already_received_points, data.can_get_points].some(value => number(value) === null))) return failure(result('unknown'))
    return { ok: true, snapshot: {
      totalPoints: number(data.total_points), todayReceived: number(data.already_received_points), todayRemaining: number(data.can_get_points),
      at: now, day: dayKey(new Date(now), 'Asia/Shanghai'),
    } }
  } catch {
    return failure({ outcome: 'unknown', message: '社区账号信息查询失败' })
  }
}
