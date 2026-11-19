import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { normalizeConfig, defaultConfig } from '../lib/config.js'
import { StateStore } from '../lib/store.js'

// All fixtures are synthetic. Never load the actual account store.
function storeFor(raw, entryConfig = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mys-community-state-'))
  if (raw !== undefined) fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify(raw))
  const store = new StateStore({ directory, entryConfig })
  store.load()
  return store
}

test('old config stays opt-in with independent community protocol defaults', () => {
  const config = normalizeConfig({ games: { genshin: false } })
  assert.deepEqual(config.community, { enabled: false, client: { appVersion: '2.117.0', salt: 't0qEgfub6cvueAPgR5m9aQWWVciEer7v' } })
  assert.equal(defaultConfig().community.enabled, false)
  assert.equal(config.client.appVersion, '2.109.0')
  assert.equal(config.games.genshin, false)
})

test('旧社区名单仅保留已有大别野授权', () => {
  for (const [input, enabled] of [
    [{ enabled: true, gids: ['2'] }, false], [{ enabled: true, gids: [] }, false],
    [{ enabled: true, gids: null }, false], [{ enabled: true, gids: '5' }, false],
    [{ enabled: true, gids: [' 5', '05', {}, null] }, false],
    [{ enabled: true, gids: ['2', 5, '5'] }, true], [{ enabled: true, gids: [5] }, true],
    [{ enabled: false, gids: ['5'] }, false], [{ enabled: true }, true],
  ]) {
    const config = normalizeConfig({ community: { ...input, client: { appVersion: 'custom', salt: 'local-salt' } } })
    assert.deepEqual(config.community, { enabled, client: { appVersion: 'custom', salt: 'local-salt' } }, JSON.stringify(input))
    assert.equal(config.client.salt, 'd9200c846b10886e8c874fc33c8f308b')
  }
})

test('v1 migration preserves games and consumes the legacy scheduled day conservatively', () => {
  const oldResult = { at: 100, results: [{ game: 'genshin', ok: true }] }
  const store = storeFor({ version: 1, auth: { aid: '123', cookies: { ltoken: 'synthetic' } }, runtime: { lastRunDate: '2026-11-18', lastResult: oldResult } })
  const state = store.get()
  assert.equal(state.version, 2)
  assert.equal(state.runtime.scheduleLastAttemptDate, '2026-11-18')
  assert.equal(state.runtime.lastRunDate, '2026-11-18')
  assert.deepEqual(state.runtime.lastResult, oldResult)
  assert.equal(state.auth.cookies.ltoken, 'synthetic')
  assert.equal(state.runtime.community.accountId, null)
  assert.deepEqual(state.runtime.community.signedDays, {})
  store.close()
})

test('v2 community results and balance survive close/reload without reviving old attempts', () => {
  const store = storeFor()
  const at = Date.parse('2026-11-18T09:00:00+08:00')
  const community = {
    accountId: '123', lastRunAt: at, lastError: null,
    lastResult: { at, finishedAt: at + 1, reason: 'manual', day: '2026-11-18', gids: ['5'], ok: true,
      results: [{ gid: '5', label: '大别野', day: '2026-11-18', at, outcome: 'success', message: '已签到', retcode: 0 }] },
    balance: { totalPoints: 123, todayReceived: 30, todayRemaining: 60, at, day: '2026-11-18' },
    balanceError: { code: 'query-failed', message: '查询失败' },
    signedDays: { 5: { day: '2026-11-18', at } },
  }
  store.patchRuntime({ lastRunDate: '2026-11-18', scheduleLastAttemptDate: null, community })
  store.setConfig(normalizeConfig({ community: { enabled: true } }))
  store.close()
  const reloaded = new StateStore({ directory: store.directory })
  const state = reloaded.load()
  assert.deepEqual(state.runtime.community, community)
  assert.equal(state.runtime.scheduleLastAttemptDate, null)
  assert.equal(state.config.community.enabled, true)
  assert.equal(Object.hasOwn(state.config.community, 'gids'), false)
  reloaded.close()
})

test('saved modern enabled does not inherit a stale Host gid selector', () => {
  const entryConfig = { community: { enabled: true, gids: ['2'], client: { appVersion: 'host-version', salt: 'host-salt' } } }
  for (const [raw, enabled] of [
    [undefined, false], [{ version: 1, config: { enabled: false } }, false],
    [{ config: { community: { enabled: false, gids: [] } } }, false],
    [{ config: { community: { enabled: true, gids: ['5'] } } }, true],
    [{ config: { community: { enabled: true } } }, true],
  ]) {
    const store = storeFor(raw, entryConfig)
    assert.deepEqual(store.get().config.community, { enabled, client: entryConfig.community.client })
    store.close()
  }
})

test('旧社区记录只恢复大别野', () => {
  const day = '2026-11-18', at = Date.parse(`${day}T09:00:00+08:00`)
  const balance = { at, day, totalPoints: 42, todayReceived: 10, todayRemaining: 0 }
  const lastError = { code: 'captcha', message: 'Old partition error', at }
  const other = { gid: '2', day, at, outcome: 'captcha', message: 'Old partition error' }
  const dabieye = { gid: '5', label: '大别野', day, at, outcome: 'success', message: 'Accepted' }
  for (const result of [dabieye, { ...dabieye, outcome: 'error', message: 'Dabieye failure' }, null]) {
    const lastResult = { at, finishedAt: at, reason: 'manual', day, gids: ['5', '2'], ok: false, results: [other, ...(result ? [result] : [])] }
    const signedDays = { 5: { day, at }, 2: { day, at } }
    const store = storeFor({ version: 2, runtime: { community: { accountId: '123', balance, lastRunAt: at, lastError, lastResult, signedDays } } })
    const clean = store.get().runtime.community
    assert.deepEqual(clean.balance, balance)
    assert.deepEqual(clean.signedDays, { 5: { day, at } })
    assert.equal(clean.lastRunAt, result ? at : null)
    assert.deepEqual(clean.lastError, result?.outcome === 'error' ? { code: 'error', message: result.message, at } : null)
    assert.deepEqual(clean.lastResult, result ? { ...lastResult, gids: ['5'], ok: result.outcome === 'success', results: [result] } : null)
    store.close()
  }
})

test('malformed saved community state cannot supply unsupported targets or raw response objects', () => {
  const store = storeFor({ version: 2, runtime: { community: {
    accountId: 'not-an-account', balance: { totalPoints: -10, todayReceived: '30', todayRemaining: 4, at: 123, day: '2026-11-18', token: 'secret' },
    signedDays: { 9: { day: '2026-11-18', at: 1 }, 5: { day: {}, at: 1 } },
    lastResult: { results: [{ gid: '9', outcome: 'success' }], raw: 'secret' }, raw: 'secret',
  } } })
  const community = store.get().runtime.community
  assert.equal(community.accountId, null)
  assert.deepEqual(community.signedDays, {})
  assert.equal(community.balance.totalPoints, null)
  assert.equal(community.balance.todayReceived, null)
  assert.equal(community.balance.todayRemaining, 4)
  assert.equal(JSON.stringify(community).includes('secret'), false)
  store.close()
})
