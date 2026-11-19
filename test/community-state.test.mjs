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
  assert.equal(config.community?.enabled, false)
  assert.deepEqual(config.community.gids, ['5', '2'])
  assert.equal(config.community.client.appVersion, '2.117.0')
  assert.equal(config.community.client.salt, 't0qEgfub6cvueAPgR5m9aQWWVciEer7v')
  assert.equal(config.client.appVersion, '2.109.0')
  assert.equal(config.games.genshin, false)
  defaultConfig().community.gids.push('6')
  assert.deepEqual(defaultConfig().community.gids, ['5', '2'])
})

test('explicit empty selection stays empty and unsupported communities cannot be requested', () => {
  assert.deepEqual(normalizeConfig({ community: { enabled: true, gids: [] } }).community?.gids, [])
  assert.deepEqual(normalizeConfig({ community: { gids: [5, '2', '2', 999, '9', {}, null] } }).community.gids, ['5', '2'])
  assert.deepEqual(normalizeConfig({ community: { gids: '5' } }).community.gids, ['5', '2'])
  const config = normalizeConfig({ community: { enabled: true, client: { appVersion: 'custom', salt: 'local-salt' } } })
  assert.equal(config.community.enabled, true)
  assert.equal(config.community.client.appVersion, 'custom')
  assert.equal(config.community.client.salt, 'local-salt')
  assert.equal(config.client.salt, 'd9200c846b10886e8c874fc33c8f308b')
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
    lastResult: { at, finishedAt: at + 1, reason: 'manual', day: '2026-11-18', gids: ['5', '2'], ok: false,
      results: [{ gid: '5', label: '大别野', day: '2026-11-18', at, outcome: 'success', message: '已签到', retcode: 0 }] },
    balance: { totalPoints: 123, todayReceived: 30, todayRemaining: 60, at, day: '2026-11-18' },
    balanceError: { code: 'query-failed', message: '查询失败' },
    signedDays: { 5: { day: '2026-11-18', at } },
  }
  store.patchRuntime({ lastRunDate: '2026-11-18', scheduleLastAttemptDate: null, community })
  store.setConfig(normalizeConfig({ community: { enabled: true, gids: [] } }))
  store.close()
  const reloaded = new StateStore({ directory: store.directory })
  const state = reloaded.load()
  assert.deepEqual(state.runtime.community, community)
  assert.equal(state.runtime.scheduleLastAttemptDate, null)
  assert.deepEqual(state.config.community.gids, [])
  reloaded.close()
})

test('community Host overrides work on old/new stores while saved user choices win', () => {
  const entryConfig = { community: { enabled: true, gids: ['6'], client: { appVersion: 'host-version', salt: 'host-salt' } } }
  for (const raw of [undefined, { version: 1, config: { enabled: false } }]) {
    const store = storeFor(raw, entryConfig)
    assert.equal(store.get().config.community.enabled, true)
    assert.deepEqual(store.get().config.community.gids, ['6'])
    assert.equal(store.get().config.community.client.salt, 'host-salt')
    store.close()
  }
  const store = storeFor({ version: 2, config: { community: { enabled: false, gids: [] } } }, entryConfig)
  assert.equal(store.get().config.community.enabled, false)
  assert.deepEqual(store.get().config.community.gids, [])
  assert.equal(store.get().config.community.client.salt, 'host-salt')
  store.close()
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
