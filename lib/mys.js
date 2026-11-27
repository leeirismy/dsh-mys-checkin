/**
 * The miHoYo BBS protocol, as far as daily game check-in needs it.
 *
 * Every function takes an explicit `config`/`deviceId` so the same code can be
 * unit-tested against a fake transport, and returns the raw `retcode` alongside
 * a normalized outcome instead of throwing for business failures.
 */
import { SmsLoginProtocol, SmsChallenge } from './sms-login.js'
import { request } from './http.js'
import {
  apiHeaders,
  cookieHeader,
  credentialCookies,
  ensureIdentityCookies,
  sessionStoken,
  signDs1,
  signDs2,
} from './ds.js'

const API_TAKUMI = 'https://api-takumi.mihoyo.com'

/** Return codes that mean the session is gone and only a new login can fix it. */
export const LOGIN_EXPIRED = new Set([-100, -111, 10001, 10010])
/** Return codes that mean risk control wants a human, so the run must stop. */
export const CAPTCHA_REQUIRED = new Set([1034, -999])
/** Return codes that mean the account has no role in that game. */
export const NOT_BOUND = new Set([-1002, 1016])

function asRetcode(json) {
  const value = json?.retcode
  return typeof value === 'number' ? value : -1
}

function asMessage(json) {
  const value = json?.message
  return typeof value === 'string' && value !== '' ? value : `未知返回（retcode=${String(json?.retcode)}）`
}

/** `true` when this retcode means "log in again". */
export function isLoginExpired(retcode) {
  return LOGIN_EXPIRED.has(retcode)
}

/** `true` when this retcode means "today is already signed". */
export function isAlreadySigned(retcode) {
  return retcode === -5003
}

/** `true` when risk control interrupted the request. */
export function isCaptcha(retcode) {
  return CAPTCHA_REQUIRED.has(retcode)
}

/**
 * List the account's roles for one game.
 *
 * An empty list is a normal answer meaning "this account has no character in
 * that game", not an error.
 */
export async function getRoles({ config, deviceId, cookies, biz, timeoutMs = 20000, strict = false }) {
  const url = `${API_TAKUMI}/binding/api/getUserGameRolesByCookie?game_biz=${encodeURIComponent(biz)}`
  const headers = apiHeaders({
    config,
    deviceId,
    signature: signDs1({ salt: config.client.salt }),
    cookie: cookieHeader(cookies),
  })
  const response = await request(url, { headers, timeoutMs, ...(strict ? { retries: 0, maxResponseBytes: 131072 } : {}) })
  const json = response.json
  const retcode = asRetcode(json)
  const risk = response.headers.has('x-rpc-aigis') || json?.data?.is_risk === true || (typeof json?.data?.risk_code === 'number' && json.data.risk_code !== 0) || ['gt', 'challenge', 'captcha', 'geetest', 'verification', 'verify_url'].some(key => json?.data?.[key])
  if (strict && (!response.ok || json?.retcode !== 0 || !Array.isArray(json?.data?.list) || !json.data.list.every(item => item && typeof item === 'object' && !Array.isArray(item) && typeof item.game_uid === 'string' && /^\d{1,32}$/.test(item.game_uid) && typeof item.region === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(item.region) && (item.game_biz === undefined || item.game_biz === biz)) || risk)) {
    return { ok: false, retcode, message: '游戏凭据校验失败', roles: [] }
  }
  if (retcode !== 0) {
    return { ok: false, retcode, message: asMessage(json), roles: [] }
  }
  const list = Array.isArray(json?.data?.list) ? json.data.list : []
  const roles = list.map((item) => ({
    uid: String(item?.game_uid ?? ''),
    region: String(item?.region ?? ''),
    regionName: typeof item?.region_name === 'string' ? item.region_name : '',
    nickname: typeof item?.nickname === 'string' ? item.nickname : '',
    level: typeof item?.level === 'number' ? item.level : null,
    biz: typeof item?.game_biz === 'string' ? item.game_biz : biz,
  }))
  return { ok: true, retcode, message: 'ok', roles }
}

/** DS2 salt used by the BBS app endpoints; stable across client releases. */
const BBS_SALT = 't0qEgfub6cvueAPgR5m9aQWWVciEer7v'

function bbsHeaders({ config, deviceId, cookie, signature }) {
  return {
    'User-Agent': 'okhttp/4.9.3',
    Accept: 'application/json',
    DS: signature,
    'x-rpc-app_version': config.client.appVersion,
    'x-rpc-client_type': '2',
    'x-rpc-device_id': deviceId,
    'x-rpc-device_name': config.device.name,
    'x-rpc-device_model': config.device.model,
    'x-rpc-sys_version': config.device.sysVersion,
    'x-rpc-channel': config.device.channel,
    'x-rpc-verify_key': 'bll8iq97cem8',
    Referer: 'https://app.mihoyo.com',
    ...(cookie === '' ? {} : { Cookie: cookie }),
  }
}

/**
 * Best-effort community profile lookup.
 *
 * The QR confirmation yields the numeric UID but no nickname, so this reads the
 * community profile once after login. Failure is harmless: the account card
 * falls back to the in-game role nickname.
 */
export async function getAccountProfile({ config, deviceId, cookies, uid, timeoutMs = 10000 }) {
  if (typeof uid !== 'string' || uid === '') return { ok: false, nickname: null, avatar: null }
  const query = new URLSearchParams({ uid })
  const headers = bbsHeaders({
    config,
    deviceId,
    cookie: cookieHeader(cookies),
    signature: signDs2({ salt: BBS_SALT, query }),
  })
  const response = await request(`https://bbs-api.miyoushe.com/user/api/getUserFullInfo?${query}`, {
    headers,
    timeoutMs,
  })
  const json = response.json
  if (asRetcode(json) !== 0) return { ok: false, retcode: asRetcode(json), message: asMessage(json), nickname: null, avatar: null }
  const info = json?.data?.user?.user_info ?? json?.data?.user_info ?? null
  const nickname = typeof info?.nickname === 'string' && info.nickname.trim() !== '' ? info.nickname.trim() : null
  const avatar = typeof info?.avatar_url === 'string' && info.avatar_url !== '' ? info.avatar_url : null
  return { ok: nickname !== null, nickname, avatar }
}

/**
 * Read today's check-in state before signing.
 *
 * One cheap call per game provides the cumulative sign-in day shown in the
 * result cards, and avoids re-signing when the account is already done.
 */
export async function getSignInfo({ config, deviceId, cookies, game, role, timeoutMs = 15000 }) {
  const query = new URLSearchParams({
    act_id: game.actId,
    region: role.region,
    uid: role.uid,
    lang: 'zh-cn',
  })
  const headers = apiHeaders({
    config,
    deviceId,
    signature: signDs1({ salt: config.client.salt }),
    cookie: cookieHeader(cookies),
    signgame: game.sendSigngame === true ? game.signgame : undefined,
  })
  const response = await request(`${game.host}/event/luna/${game.signgame}/info?${query}`, { headers, timeoutMs })
  const json = response.json
  const retcode = asRetcode(json)
  if (retcode !== 0) return { ok: false, retcode, message: asMessage(json) }
  const data = json?.data ?? {}
  return {
    ok: true,
    isSign: data.is_sign === true,
    firstBind: data.first_bind === true,
    totalDays: typeof data.total_sign_day === 'number' ? data.total_sign_day : null,
  }
}

/**
 * Sign one game for one role.
 *
 * `outcome` classifies the business result so the caller never has to know the
 * retcode table: `signed | already | captcha | expired | not-bound | error`.
 */
export async function signGame({ config, deviceId, cookies, game, role, timeoutMs = 25000 }) {
  const path = `/event/luna/${game.signgame}/sign`
  const body = JSON.stringify({
    act_id: game.actId,
    region: role.region,
    uid: role.uid,
    lang: 'zh-cn',
  })
  const headers = {
    ...apiHeaders({
      config,
      deviceId,
      signature: signDs1({ salt: config.client.salt }),
      cookie: cookieHeader(cookies),
      signgame: game.sendSigngame === true ? game.signgame : undefined,
    }),
    'Content-Type': 'application/json',
  }
  const response = await request(`${game.host}${path}`, { method: 'POST', headers, body, timeoutMs })
  const json = response.json
  const retcode = asRetcode(json)
  const message = asMessage(json)

  if (retcode === 0) {
    const success = json?.data?.success
    if (success === 1) {
      return {
        outcome: 'captcha',
        retcode,
        message: '触发验证码，需在米游社手动完成',
        captcha: { gt: json?.data?.gt, challenge: json?.data?.challenge },
      }
    }
    return { outcome: 'signed', retcode, message, awards: Array.isArray(json?.data?.awards) ? json.data.awards : [] }
  }
  if (isAlreadySigned(retcode)) return { outcome: 'already', retcode, message }
  if (isLoginExpired(retcode)) return { outcome: 'expired', retcode, message }
  if (isCaptcha(retcode)) return { outcome: 'captcha', retcode, message }
  if (NOT_BOUND.has(retcode)) return { outcome: 'not-bound', retcode, message }
  return { outcome: 'error', retcode, message }
}

/** Only publish a complete, identity-checked pair. V2 ticket values can be opaque. */
export function v2SessionCookies({ aid, mid, stoken, ltoken, cookieToken }) {
  return { stuid: aid, mid, stoken_v2: stoken, ltuid_v2: aid, ltmid_v2: mid, account_id_v2: aid,
    account_mid_v2: mid, ltoken_v2: ltoken, cookie_token_v2: cookieToken }
}

export async function refreshCredentials({ config, deviceId, cookies, aid, mid, timeoutMs = 20000 }) {
  const stoken = sessionStoken(cookies)
  if (!stoken) return { ok: false, reason: 'no-stoken', cookies, message: '没有可续期的 stoken' }
  const ids = [aid, cookies.stuid, cookies.ltuid_v2, cookies.account_id_v2, cookies.ltuid, cookies.account_id].filter(Boolean)
  const mids = [mid, cookies.mid, cookies.ltmid_v2, cookies.account_mid_v2, cookies.ltmid].filter(Boolean)
  if (!stoken.startsWith('v2_') || new Set(ids).size !== 1 || new Set(mids).size !== 1) {
    return { ok: false, reason: 'needs-login', cookies, message: '缺少可用的 V2 SToken 或账号信息不完整，请重新短信登录' }
  }
  const root = { aid: ids[0], mid: mids[0], stoken }
  try {
    const protocol = new SmsLoginProtocol({ deviceId, device: config.device })
    const { ltoken } = await protocol.getLToken({ root, timeoutMs })
    const { cookieToken } = await protocol.getCookieToken({ root, timeoutMs })
    return { ok: true, cookies: v2SessionCookies({ ...root, ltoken, cookieToken }), message: '凭据已续期' }
  } catch (error) {
    const retcode = error.diagnostic?.retcode
    if (error instanceof SmsChallenge || isCaptcha(retcode) || ['challenge-failed', 'invalid-challenge'].includes(error.code)) {
      return { ok: false, reason: 'captcha', retcode, cookies, message: '需要人工验证，已停止本轮后续签到' }
    }
    if (isLoginExpired(retcode)) return { ok: false, reason: 'stoken-invalid', cookies, message: 'SToken 已失效，请重新短信登录' }
    return { ok: false, reason: 'exchange-failed', cookies, message: 'V2 凭据未能完成换取，原登录未改变' }
  }
}

/** Verify a session with the cheapest authenticated call. */
export async function verifySession({ config, deviceId, cookies, timeoutMs = 20000 }) {
  const result = await getRoles({ config, deviceId, cookies, biz: 'hk4e_cn', timeoutMs })
  if (result.ok) return { ok: true }
  if (isLoginExpired(result.retcode)) return { ok: false, reason: 'expired', ...result }
  return { ok: false, reason: 'error', ...result }
}
