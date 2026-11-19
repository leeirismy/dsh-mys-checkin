/**
 * Minimal JSON-over-HTTP client.
 *
 * Node's global `fetch` already handles TLS, proxies from the environment, and
 * decompression; this wrapper adds the three things every miHoYo call needs:
 * a hard timeout, capture of `Set-Cookie`, and one jittered retry for transport
 * failures (never for an HTTP error status — a refusal must not be retried).
 */

import { AsyncLocalStorage } from 'node:async_hooks'

// A service operation may chain requests or retry internally. Keep its session
// check attached to every actual dispatch, not just the outer service await.
const requestSession = new AsyncLocalStorage()
export function withRequestGuard(check, operation) {
  const parent = requestSession.getStore()
  // A flow guard narrows the service generation guard; it must not replace it.
  return requestSession.run(() => parent?.() !== false && check() !== false, operation)
}
function checkRequestSession() {
  if (requestSession.getStore()?.() === false) throw new Error('登录会话已变更')
}

export class HttpError extends Error {
  constructor(message, { url, status, body, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'HttpError'
    this.url = url
    this.status = status
    this.body = body
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/**
 * Perform one request and decode the JSON body when there is one.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.method] - HTTP verb, default GET.
 * @param {Record<string, string>} [options.headers]
 * @param {string} [options.body] - already-serialized request body.
 * @param {number} [options.timeoutMs] - per-attempt timeout.
 * @param {number} [options.retries] - transport-failure retries.
 * @param {number} [options.maxResponseBytes] - optional streaming response limit.
 * @param {() => number} [options.random] - jitter source.
 * @returns {Promise<{status: number, ok: boolean, headers: Headers, setCookies: string[], text: string, json: any}>}
 */
export async function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 20000,
    retries = 1,
    random = Math.random,
  } = options

  let attempt = 0
  let lastError
  while (attempt <= retries) {
    checkRequestSession()
    attempt += 1
    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
      checkRequestSession()
      const text = options.maxResponseBytes === undefined
        ? await response.text()
        : await boundedText(response, options.maxResponseBytes)
      checkRequestSession()
      let json
      try {
        json = text === '' ? undefined : JSON.parse(text)
      } catch {
        json = undefined
      }
      const setCookies = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : []
      return { status: response.status, ok: response.ok, headers: response.headers, setCookies, text, json }
    } catch (error) {
      checkRequestSession()
      lastError = error
      if (attempt > retries) break
      // Transport jitter keeps repeated attempts from arriving in lockstep.
      await sleep(600 + Math.floor(random() * 900))
    }
  }
  const reason = lastError?.name === 'TimeoutError' ? '请求超时' : String(lastError?.message ?? lastError)
  throw new HttpError(`${reason}（${method} ${url}）`, { url, cause: lastError })
}

// Optional streaming limit for sensitive protocol envelopes. Existing callers
// retain their historical behavior unless they explicitly opt in.
async function boundedText(response, limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('响应体上限无效')
  if (response.body == null) return ''
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new Error('响应体过大')
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks, size).toString('utf8')
}

/** Sleep helper shared by the pacing code. */
export { sleep }
