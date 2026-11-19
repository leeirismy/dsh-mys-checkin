// Pure scope completion policy; the timer's day and community's day differ.
import { DABIEYE, checkinTargets } from './config.js'
import { dayKey } from './tz.js'

export function communityDay(now) {
  return dayKey(new Date(now), 'Asia/Shanghai')
}

export function completedScopes({ config, runtime, accountId, now }) {
  const date = dayKey(new Date(now), config.timezone)
  const { gameIds, dabieye } = checkinTargets(config)
  const record = runtime.lastResult
  const cleanGame = new Set(['signed', 'already', 'no-role', 'first-bind'])
  const gamesComplete = gameIds.length > 0 && record?.ok === true && record.date === date
    && gameIds.every((id) => record.results?.some((item) => item.game === id && cleanGame.has(item.outcome)))
  const community = runtime.community
  const signed = community?.signedDays?.[DABIEYE.id]
  const communityComplete = dabieye && accountId !== null && community?.accountId === accountId
    && signed?.day === communityDay(now) && Number.isFinite(signed.at)
    && dayKey(new Date(signed.at), config.timezone) === date
  return { games: gamesComplete, community: Boolean(communityComplete) }
}

export function effectiveLastRunDate(input) {
  const { config, runtime, now } = input
  const date = dayKey(new Date(now), config.timezone)
  if (runtime.scheduleLastAttemptDate === date) return date
  const enabled = []
  const complete = completedScopes(input)
  const { gameIds, dabieye } = checkinTargets(config)
  if (gameIds.length > 0) enabled.push(complete.games)
  if (dabieye) enabled.push(complete.community)
  return enabled.length > 0 && enabled.every(Boolean) ? date : null
}
