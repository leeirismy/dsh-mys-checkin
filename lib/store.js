/**
 * Durable plugin state: configuration, credentials, run history.
 *
 * The file lives under `$DSH_HOME` (default `~/.dsh`). Writes are coalesced and
 * atomic (write-temp + rename), so a crash mid-write cannot leave a truncated
 * JSON file behind. Credentials never leave this process: the HTTP surface only
 * reports whether they exist.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DABIEYE, defaultConfig, normalizeConfig } from './config.js'

const STATE_VERSION = 2
const LOG_LIMIT = 200
const WRITE_DELAY_MS = 250

/** Resolve the DSH home directory the same way the host does. */
export function resolveHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return path.join(os.homedir(), '.dsh')
}

function emptyState() {
  return {
    version: STATE_VERSION,
    config: defaultConfig(),
    auth: null,
    runtime: {
      planDate: null,
      plannedAt: null,
      nextRunAt: null,
      lastRunDate: null,
      scheduleLastAttemptDate: null,
      community: emptyCommunityState(),
      lastRunAt: null,
      lastResult: null,
      lastError: null,
      roles: null,
      log: [],
    },
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Shared reset shape for logout/account replacement; never reuse nested maps. */
export function emptyCommunityState() {
  return { accountId: null, lastRunAt: null, lastResult: null, lastError: null, balance: null, balanceError: null, signedDays: {} }
}

const OUTCOMES = new Set(['success', 'cached-success', 'captcha', 'auth-unavailable', 'expired', 'error', 'unknown', 'skipped'])
const timestamp = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const businessDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
const shortText = (value) => typeof value === 'string' ? value.slice(0, 160) : ''

function savedError(raw) {
  if (!isObject(raw) || typeof raw.code !== 'string') return null
  const error = { code: shortText(raw.code), message: shortText(raw.message) }
  if (timestamp(raw.at) !== null) error.at = raw.at
  return error
}

/** Explicit allowlist: persisted protocol objects must not become status payloads. */
function savedCommunity(raw) {
  const clean = emptyCommunityState()
  if (!isObject(raw)) return clean
  clean.accountId = typeof raw.accountId === 'string' && /^\d+$/.test(raw.accountId) ? raw.accountId : null
  clean.balanceError = savedError(raw.balanceError)
  if (isObject(raw.balance)) {
    clean.balance = { at: timestamp(raw.balance.at), day: businessDay(raw.balance.day) }
    for (const key of ['totalPoints', 'todayReceived', 'todayRemaining']) clean.balance[key] = timestamp(raw.balance[key])
  }
  const { id: gid, label } = DABIEYE
  const signed = isObject(raw.signedDays) ? raw.signedDays[gid] : null
  if (isObject(signed) && businessDay(signed.day) && timestamp(signed.at) !== null) {
    clean.signedDays[gid] = { day: signed.day, at: signed.at }
  }
  const record = raw.lastResult
  if (!isObject(record) || !Array.isArray(record.results)) return clean
  const item = record.results.find((item) => isObject(item) && item.gid === gid && OUTCOMES.has(item.outcome))
  if (!item) return clean

  const result = { gid, label, day: businessDay(item.day), at: timestamp(item.at), outcome: item.outcome, message: shortText(item.message) }
  if (Number.isInteger(item.retcode)) result.retcode = item.retcode
  // Aggregate failures from other partitions aren't evidence against Dabieye.
  // For a Dabieye-only run, retain scoped errors such as post-write balance CAPTCHA.
  const dabieyeOnly = Array.isArray(record.gids) && record.gids.length === 1 && record.gids[0] === gid
    && record.results.length === 1
  const error = dabieyeOnly ? savedError(raw.lastError) : null
  const ok = ['success', 'cached-success'].includes(item.outcome)
    && !(record.ok !== true && error?.code === 'captcha')
  clean.lastRunAt = timestamp(raw.lastRunAt)
  clean.lastResult = {
    at: timestamp(record.at), finishedAt: timestamp(record.finishedAt),
    reason: record.reason === 'schedule' ? 'schedule' : 'manual', day: businessDay(record.day),
    gids: [gid], ok, results: [result],
  }
  if (!ok) clean.lastError = error ?? { code: result.outcome, message: result.message, ...(result.at !== null ? { at: result.at } : {}) }
  return clean
}

/** Coerce a loaded document into the current state shape. */
function migrate(raw, entryConfig) {
  const state = emptyState()
  if (isObject(raw)) {
    state.config = normalizeConfig({ ...(isObject(raw.config) ? raw.config : {}) })
    if (isObject(raw.auth)) {
      const cookies = isObject(raw.auth.cookies) ? raw.auth.cookies : {}
      const clean = {}
      for (const [name, value] of Object.entries(cookies)) {
        if (typeof value === 'string' && value !== '') clean[name] = value
      }
      state.auth = {
        cookies: clean,
        mid: typeof raw.auth.mid === 'string' ? raw.auth.mid : null,
        aid: typeof raw.auth.aid === 'string' ? raw.auth.aid : null,
        stuid: typeof raw.auth.stuid === 'string' ? raw.auth.stuid : null,
        accountName: typeof raw.auth.accountName === 'string' ? raw.auth.accountName : null,
        avatar: typeof raw.auth.avatar === 'string' ? raw.auth.avatar : null,
        loginAt: typeof raw.auth.loginAt === 'number' ? raw.auth.loginAt : null,
        lastRefreshAt: typeof raw.auth.lastRefreshAt === 'number' ? raw.auth.lastRefreshAt : null,
      }
    }
    if (isObject(raw.runtime)) {
      const runtime = state.runtime
      for (const key of ['planDate', 'plannedAt', 'nextRunAt', 'lastRunDate', 'lastRunAt', 'lastError', 'deviceId']) {
        if (raw.runtime[key] !== undefined) runtime[key] = raw.runtime[key]
      }
      runtime.scheduleLastAttemptDate = Number(raw.version ?? 1) < 2
        ? businessDay(raw.runtime.lastRunDate)
        : businessDay(raw.runtime.scheduleLastAttemptDate)
      runtime.community = savedCommunity(raw.runtime.community)
      if (isObject(raw.runtime.lastResult)) runtime.lastResult = raw.runtime.lastResult
      if (isObject(raw.runtime.roles)) runtime.roles = raw.runtime.roles
      if (Array.isArray(raw.runtime.log)) runtime.log = raw.runtime.log.slice(-LOG_LIMIT)
    }
  }
  // The cordis entry's config is a base layer; saved user values win.
  // Apply this feature's Host layer before normalization supplies defaults.
  // Other legacy config precedence is intentionally unchanged.
  const hostCommunity = isObject(entryConfig?.community) ? entryConfig.community : {}
  const userCommunity = isObject(raw?.config?.community) ? raw.config.community : {}
  const community = {
    ...hostCommunity, ...userCommunity,
    client: { ...hostCommunity.client, ...userCommunity.client },
  }
  if (typeof userCommunity.enabled === 'boolean' && !Object.hasOwn(userCommunity, 'gids')) delete community.gids
  state.config = normalizeConfig({ ...entryConfig, ...state.config, community })
  return state
}

export class StateStore {
  /**
   * @param {object} options
   * @param {string} options.directory - directory holding `state.json`
   * @param {object} [options.entryConfig] - config from the cordis entry
   * @param {(message: string) => void} [options.onWriteError] - persistence error sink
   */
  constructor({ directory, entryConfig = {}, onWriteError }) {
    this.directory = directory
    this.file = path.join(directory, 'state.json')
    this.entryConfig = entryConfig
    this.onWriteError = onWriteError
    this.timer = null
    this.closed = false
    this.state = emptyState()
  }

  /** Read (or create) the state document. Never throws. */
  load() {
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    } catch {
      /* a read-only home still allows in-memory operation */
    }
    try {
      const text = fs.readFileSync(this.file, 'utf8')
      this.state = migrate(JSON.parse(text), this.entryConfig)
    } catch (error) {
      if (error?.code !== 'ENOENT') this.onWriteError?.(`状态文件读取失败，已使用默认配置：${String(error?.message ?? error)}`)
      this.state = migrate(null, this.entryConfig)
    }
    return this.state
  }

  /** Current in-memory document. */
  get() {
    return this.state
  }

  /** Replace the configuration section (already normalized) and persist. */
  setConfig(config) {
    this.state.config = config
    this.save()
  }

  setAuth(auth) {
    this.state.auth = auth
    this.save()
  }

  /** Merge fields into the runtime section and persist. */
  patchRuntime(patch) {
    this.state.runtime = { ...this.state.runtime, ...patch }
    this.save()
  }

  /** Append one log entry, keeping the ring bounded. */
  log(level, message, extra = undefined) {
    const entry = { at: Date.now(), level, message: String(message) }
    if (extra !== undefined && extra !== null) entry.detail = extra
    const log = this.state.runtime.log ?? []
    log.push(entry)
    if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT)
    this.state.runtime.log = log
    this.save()
  }

  /** Persist soon; repeated calls collapse into one write. */
  save() {
    if (this.closed) return
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, WRITE_DELAY_MS)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** Write the document atomically right now. */
  flush() {
    if (this.closed) return
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(tmp, this.file)
    } catch (error) {
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        /* ignore */
      }
      this.onWriteError?.(`状态文件写入失败：${String(error?.message ?? error)}`)
    }
  }

  /** Flush pending writes and stop accepting new ones. */
  close() {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.flush()
    this.closed = true
  }
}
