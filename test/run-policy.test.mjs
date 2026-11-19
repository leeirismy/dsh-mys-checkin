import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeConfig } from '../lib/config.js'
import { communityDay, completedScopes, effectiveLastRunDate } from '../lib/run-policy.js'
import { dayKey } from '../lib/tz.js'

const now = new Date('2026-11-18T16:30:00Z')
const today = '2026-11-18' // Los Angeles; Shanghai is already November 19.
const config = normalizeConfig({ timezone: 'America/Los_Angeles', community: { enabled: true } })
config.games = Object.fromEntries(Object.keys(config.games).map((id) => [id, id === 'genshin']))
const make = () => ({ config: structuredClone(config), runtime: { scheduleLastAttemptDate: null, lastResult: null, community: { accountId: '123', signedDays: {} } }, accountId: '123', now })
function gamesDone(input) { input.runtime.lastResult = { date: today, at: now.getTime(), ok: true, results: [{ game: 'genshin', outcome: 'signed' }] }; return input }
function communityDone(input) { input.runtime.community.signedDays = { '5': { day: '2026-11-19', at: now.getTime() }, '2': { day: '2026-11-19', at: now.getTime() } }; return input }

test('Shanghai business day and configured scheduling day remain separate across calendar boundaries', () => {
  assert.equal(communityDay(now), '2026-11-19')
  assert.equal(dayKey(now, config.timezone), today)
  const input = communityDone(make())
  assert.deepEqual(completedScopes(input), { games: false, community: true })
  input.now = new Date('2026-11-19T16:30:00Z')
  assert.equal(completedScopes(input).community, false)
})

test('only a complete set of enabled scopes can suppress automatic opportunity', () => {
  assert.equal(effectiveLastRunDate(gamesDone(make())), null)
  assert.equal(effectiveLastRunDate(communityDone(make())), null)
  assert.equal(effectiveLastRunDate(communityDone(gamesDone(make()))), today)
  const input = communityDone(make())
  input.config.games.genshin = false
  assert.equal(effectiveLastRunDate(input), today)
  input.config.community.gids.push('6')
  assert.equal(effectiveLastRunDate(input), null)
})

test('community success requires the same account, current business day and current schedule day', () => {
  for (const change of [
    (input) => { input.accountId = '456' },
    (input) => { input.runtime.community.signedDays['5'].day = '2026-11-18' },
    (input) => { input.runtime.community.signedDays['5'].at = new Date('2026-11-18T07:59:00Z').getTime() },
  ]) {
    const input = communityDone(make()); change(input)
    assert.equal(completedScopes(input).community, false)
  }
})

test('game completion must cover all enabled games rather than a successful single-game subset', () => {
  const input = gamesDone(make())
  input.config.games.starrail = true
  assert.equal(completedScopes(input).games, false)
})

test('automatic attempts suppress the same schedule day even on failure, not an older day', () => {
  const input = make()
  input.runtime.scheduleLastAttemptDate = today
  assert.equal(effectiveLastRunDate(input), today)
  input.runtime.scheduleLastAttemptDate = '2026-11-17'
  assert.equal(effectiveLastRunDate(input), null)
})

test('no enabled scope and an empty community selection never manufacture completion', () => {
  const input = communityDone(gamesDone(make()))
  input.config.games.genshin = false
  input.config.community.gids = []
  assert.equal(effectiveLastRunDate(input), null)
  input.config.community.enabled = false
  assert.equal(effectiveLastRunDate(input), null)
})
