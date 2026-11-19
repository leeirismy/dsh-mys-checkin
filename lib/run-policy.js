// Pure scope completion policy; the timer's day and community's day differ.
import { enabledGames } from './config.js'
import { dayKey } from './tz.js'

export function communityDay(now) {
  return dayKey(new Date(now), 'Asia/Shanghai')
}

export function completedScopes({ config, runtime, accountId, now }) {
  const date = dayKey(new Date(now), config.timezone)
  const games = enabledGames(config)
  const record = runtime.lastResult
  const cleanGame = new Set(['signed', 'already', 'no-role', 'first-bind'])
  const gamesComplete = games.length > 0 && record?.ok === true && record.date === date
    && games.every((game) => record.results?.some((item) => item.game === game.id && cleanGame.has(item.outcome)))
  const community = runtime.community
  const gids = config.community.gids
  const day = communityDay(now)
  const communityComplete = config.community.enabled && gids.length > 0
    && accountId !== null && community?.accountId === accountId
    && gids.every((gid) => {
      const signed = community.signedDays?.[gid]
      return signed?.day === day && Number.isFinite(signed.at)
        && dayKey(new Date(signed.at), config.timezone) === date
    })
  return { games: gamesComplete, community: Boolean(communityComplete) }
}

export function effectiveLastRunDate(input) {
  const { config, runtime, now } = input
  const date = dayKey(new Date(now), config.timezone)
  if (runtime.scheduleLastAttemptDate === date) return date
  const enabled = []
  const complete = completedScopes(input)
  if (enabledGames(config).length > 0) enabled.push(complete.games)
  if (config.community.enabled && config.community.gids.length > 0) enabled.push(complete.community)
  return enabled.length > 0 && enabled.every(Boolean) ? date : null
}
