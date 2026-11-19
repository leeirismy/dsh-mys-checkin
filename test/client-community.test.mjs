import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MysService } from '../lib/service.js'
import vm from 'node:vm'
import test from 'node:test'

// Actual callbacks and element descriptions, not a DOM, React renderer, or live Host.
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8').replace(
  "      inject: ['slots', 'locale'],",
  "      units: { createCheckinPanel: typeof createCheckinPanel === 'function' && createCheckinPanel, createConfigSaveQueue: typeof createConfigSaveQueue === 'function' && createConfigSaveQueue }, inject: ['slots', 'locale'],",
)
function harness({ respond = () => { throw new Error('Unexpected offline request') }, locale = 'zh', keepPanel = false } = {}) {
  let plugin, dictionaries, panel, verified
  const slots = new Map(), requests = [], timers = new Map(), imports = []
  let timerId = 0, hookIndex = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(init) {
      const index = hookIndex++
      if (index === 2) return [verified ?? null, (value) => { verified = value }]
      const value = typeof init === 'function' ? init() : init
      // Share only the controller across two explicit element descriptions.
      return [keepPanel && value?.runNow && value?.refresh ? (panel ??= value) : value, () => {}]
    },
    useEffect: () => {}, useRef: (current) => ({ current }),
    useCallback: (fn) => fn, useMemo: (fn) => fn(),
  }
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory((id) => {
      imports.push(id)
      if (id === 'react') return React
      throw new Error(`Unexpected browser dependency: ${id}`)
    }) } } },
    document: { baseURI: 'http://offline.invalid/' }, URL, Date, Intl, structuredClone,
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (url, init) => {
      const request = { path: new URL(url).pathname, method: init.method ?? 'GET', ...(init.body !== undefined && { body: JSON.parse(init.body) }) }
      requests.push(request)
      const response = await respond(request)
      return { status: 200, text: async () => JSON.stringify(response) }
    },
  })
  plugin.apply({
    effect: (fn, name) => { if (name.endsWith('dictionaries')) fn() },
    locale: { register: (ns, values) => { dictionaries = values }, bind: () => (key) => dictionaries[locale][key] ?? key },
    slots: { inject: (name, fn) => fn(), register: (meta, fn) => slots.set(meta.name, fn) },
  })
  const t = (key) => dictionaries[locale][key] ?? key
  return {
    tree: (status) => { hookIndex = 0; return slots.get('main')({ t, __status: status }) }, t, requests, imports, ...plugin.units,
    refreshPanel: () => panel.refresh(),
    tickSave() {
      assert.equal(timers.size, 1)
      const [id, { fn, delay }] = timers.entries().next().value
      timers.delete(id)
      assert.equal(delay, 650)
      return fn()
    },
  }
}
function nodes(value) {
  if (Array.isArray(value)) return value.flatMap(nodes)
  if (!value || typeof value !== 'object') return []
  return [value, ...nodes(value.props?.children)]
}
function text(value) {
  if (Array.isArray(value)) return value.map(text).join(' ')
  if (!value || typeof value !== 'object') return String(value ?? '')
  return [value.props?.title, value.props?.desc, text(value.props?.children)].filter(Boolean).join(' ')
}
function config(gameIds = ['genshin'], dabieye = true) {
  return { enabled: false, windows: [], games: { genshin: gameIds.includes('genshin'), starrail: gameIds.includes('starrail') }, community: { enabled: dabieye, client: {} } }
}
const rev1 = '10000000-0000-4000-8000-000000000001'
const rev2 = '10000000-0000-4000-8000-000000000002'
const rev3 = '10000000-0000-4000-8000-000000000003'
const savePath = '/api/mys/config/checkin'
function fixture(saved = config(), configRevision = rev1, accountRevision = rev1) {
  return {
    ok: true, checkinProtocol: 1, configRevision, accountRevision, running: false, login: { state: 'active' }, config: saved,
    games: [{ id: 'genshin', label: '原神', enabled: saved.games.genshin }, { id: 'starrail', label: '星穹铁道', enabled: saved.games.starrail }],
    community: { enabled: saved.community.enabled, capability: { available: true, reason: null }, lastResult: null, lastError: null, balance: null, balanceError: null },
  }
}
const runPath = '/api/mys/run/checkin'
function launch(tree, h) {
  const button = nodes(tree).find((node) => node.type?.name === 'Button' && [h.t('runNow'), h.t('running')].includes(text(node)))
  assert.ok(button, 'the panel describes the manual check-in button')
  return button
}
const writes = (h) => h.requests.filter((item) => item.method === 'POST')
function deferred() { return Promise.withResolvers() }

test('projects share one card and disable the sole manual action at the moment of edit', async () => {
  const h = harness(), status = fixture()
  status.lastError = { code: 'RUN_FAILED', message: 'synthetic failure' }
  const tree = h.tree(status)
  const card = nodes(tree).find((node) => node.props?.title === '签到项目')
  assert.ok(card, '签到项目 card is visible')
  assert.equal(nodes(card).filter((node) => node.type === 'input' && node.props.type === 'checkbox').length, 2)
  const dabieye = nodes(card).find((node) => node.type?.name === 'Switch')
  assert.equal(dabieye?.props.label, '大别野（米游币）')
  assert.equal(dabieye.props.checked, true)
  const button = launch(tree, h)
  assert.equal(button.props.disabled, false)
  dabieye.props.onChange(false)
  await button.props.onClick()
  assert.deepEqual(writes(h), [], 'the pre-render click closure cannot bypass the debounce guard')
  const buttons = nodes(tree).filter((node) => node.type?.name === 'Button')
  assert.deepEqual(buttons.map(text).filter((label) => /立即.*签到|重试签到/.test(label)), ['立即签到'])
  assert.doesNotMatch(text(tree), /签到分区|立即社区签到/)
  assert.match(text(tree), /检测接口与登录/)
  const en = harness({ locale: 'en' })
  assert.match(text(en.tree(status)), /Check-in targets.*Dabieye \(coins\)/)
  assert.equal(text(launch(en.tree(status), en)), 'Check in now')
})

for (const [gameIds, dabieye] of [[['genshin'], true], [['genshin'], false], [[], true]]) {
  test(`manual button sends exactly one confirmed snapshot (${gameIds.length} games, community=${dabieye})`, async () => {
    const status = fixture(config(gameIds, dabieye))
    const h = harness({ respond: ({ method }) => method === 'GET' ? status : { ok: true, started: true } })
    const button = launch(h.tree(status), h)
    assert.equal(button.props.disabled, false)
    await button.props.onClick()
    assert.deepEqual(writes(h), [{ path: runPath, method: 'POST', body: { gameIds, dabieye, accountRevision: rev1 } }])
  })
}

test('an enabled button captured before a status refresh cannot post targets it did not show', async () => {
  const original = fixture(config(['genshin'], false)), fresh = fixture(config(['starrail'], true))
  const h = harness({ keepPanel: true, respond: ({ method }) => method === 'GET' ? fresh : { ok: true, started: true } })
  const stale = launch(h.tree(original), h)
  assert.equal(stale.props.disabled, false)
  await h.refreshPanel()
  await stale.props.onClick()
  assert.deepEqual(writes(h), [], 'stale button must not post the new, unseen target set')

  const updated = h.tree()
  assert.match(text(updated), /查看更新后的签到项目.*再次点击/)
  const current = launch(updated, h)
  assert.equal(current.props.disabled, false)
  await current.props.onClick()
  assert.deepEqual(writes(h), [{ path: runPath, method: 'POST', body: { gameIds: ['starrail'], dabieye: true, accountRevision: rev1 } }])
})

test('empty, loading, and Host-busy panels never send a check-in even if callback is invoked', async () => {
  for (const [status, hint] of [[fixture(config([], false)), /至少.*签到项目/], [null, /加载/], [{ ...fixture(), running: true }, /签到.*进行/]]) {
    const h = harness()
    const tree = h.tree(status)
    const button = launch(tree, h)
    assert.equal(button.props.disabled, true)
    assert.match(text(tree), hint)
    await button.props.onClick()
    assert.deepEqual(writes(h), [])
  }
})

test('old account can repair community credentials by SMS, and unified run still dispatches games', async () => {
  const status = fixture()
  status.community.capability = { available: false, reason: 'missing-mid' }
  const h = harness({ respond: ({ method }) => method === 'GET' ? status : { ok: true, started: true } })
  const tree = h.tree(status)
  assert.match(text(tree), /V2 社区凭据.*不影响游戏登录/)
  const repair = nodes(tree).find((node) => node.type?.name === 'Button' && text(node) === '重新登录')
  assert.equal(typeof repair?.props.onClick, 'function')
  repair.props.onClick()
  assert.equal(h.requests.length, 0, 'opening SMS repair sends nothing')
  await launch(tree, h).props.onClick()
  assert.deepEqual(writes(h), [{ path: runPath, method: 'POST', body: { gameIds: ['genshin'], dabieye: true, accountRevision: rev1 } }])
})

test('results show community acceptance separately from historical coin balance and query failure', () => {
  const h = harness(), status = fixture()
  status.community.lastResult = { at: 123, ok: true, results: [{ gid: '5', label: '大别野', outcome: 'success', message: '合成结果' }] }
  status.community.balanceError = { message: '合成查询错误' }
  status.community.balance = { totalPoints: 1234, todayReceived: 10, todayRemaining: 0, at: 123, day: '2000-01-01' }
  const view = h.tree(status)
  const element = nodes(view).find((node) => ['CommunityResults', 'CommunityCard'].includes(node.type?.name))
  assert.ok(element, 'community result description is present')
  const content = text(element.type({ ...element.props, config: status.config }))
  assert.match(content, /接口已接受.*积分到账未独立验证/)
  const coins = nodes(view).find((node) => node.type?.name === 'CoinSnapshot')
  const snapshot = text(coins.type(coins.props))
  assert.doesNotMatch(content, /1234|积分快照/)
  assert.match(snapshot, /积分查询失败/)
  assert.match(snapshot, /历史.*快照/)
  assert.match(snapshot, /1234/)
  assert.doesNotMatch(snapshot, /本次赚取|每日上限|今日余额|签到分区/)
})

test('save queue serializes requests and coalesces queued submissions to the latest snapshot', async () => {
  const h = harness(), a = deferred(), c = deferred(), startedA = deferred(), startedC = deferred(), sent = []
  assert.equal(typeof h.createConfigSaveQueue, 'function', 'config queue is independently testable')
  const queue = h.createConfigSaveQueue({ initial: fixture(), changed() {}, save(next, revision) {
    sent.push({ next, revision })
    const first = sent.length === 1
    if (first) startedA.resolve()
    else startedC.resolve()
    return first ? a.promise : c.promise
  } })
  const first = queue.submit(config(['genshin'], false))
  await startedA.promise
  void queue.submit(config([], false))
  void queue.submit(config(['starrail'], true))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].revision, rev1)
  a.resolve(fixture(config(['genshin'], false), rev2))
  await startedC.promise
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[1], { next: config(['starrail'], true), revision: rev2 })
  assert.equal(queue.view().pending, true)
  c.resolve(fixture(config(['starrail'], false), rev3))
  await first
  assert.equal(queue.view().pending, false)
  assert.deepEqual(queue.view().confirmed.config, config(['starrail'], false))
})

test('new debounce immediately blocks run through superseded success, failed save and polling; recovery uses normalized confirmation', async () => {
  const a = deferred(), b = deferred(), c = deferred(), startedA = deferred(), status = fixture()
  let saves = 0
  const h = harness({ respond(request) {
    if (request.path === savePath) {
      if (saves === 0) startedA.resolve()
      return [a.promise, b.promise, c.promise][saves++]
    }
    if (request.path === runPath) return { ok: true, started: true }
    return saves < 2 ? status : fixture(config(['genshin', 'starrail'], true), rev2)
  } })
  assert.equal(typeof h.createCheckinPanel, 'function', 'panel request controller is present')
  const panel = h.createCheckinPanel({ initialStatus: status, changed() {} })
  const edit = (key, value) => panel.patchDraft((next) => { next.games[key] = value; return next })
  edit('starrail', true)
  const saveA = h.tickSave()
  await startedA.promise
  edit('genshin', false)
  assert.equal(panel.view().runBlocked, 'saving')
  a.resolve({ ok: true, status: fixture(config(['genshin', 'starrail'], true), rev2) }); await saveA
  assert.equal(panel.view().runBlocked, 'saving', 'A does not unlock while B is still in debounce')
  assert.equal(panel.view().draft.games.genshin, false)
  await panel.runNow(panel.view().targets)
  const saveB = h.tickSave()
  b.resolve({ ok: false, error: { code: 'save-refused', message: 'synthetic save rejection' } }); await saveB
  await panel.refresh()
  assert.equal(panel.view().runBlocked, 'saveFail')
  assert.equal(panel.view().draft.games.genshin, true, 'failed full draft is discarded')
  await panel.runNow(panel.view().targets)
  assert.equal(writes(h).filter((r) => r.path === runPath).length, 0)
  edit('starrail', true)
  const saveC = h.tickSave()
  c.resolve({ ok: true, status: fixture(config(['starrail'], false), rev3) }); await saveC
  assert.deepEqual(writes(h).filter((r) => r.path === savePath).map((r) => r.body.configRevision), [rev1, rev2, rev2])
  assert.equal(panel.view().draft.community.enabled, false)
  await panel.runNow(panel.view().targets)
  assert.deepEqual(writes(h).filter((r) => r.path === runPath), [{ path: runPath, method: 'POST', body: { gameIds: ['starrail'], dabieye: false, accountRevision: rev1 } }])
})

test('status GET started before save cannot resurrect the old confirmed selection after save', async () => {
  const old = deferred(), original = fixture(), updated = fixture(config(['starrail'], false), rev2)
  let reads = 0
  const h = harness({ respond(request) {
    if (request.path.endsWith('/status')) return ++reads === 1 ? old.promise : updated
    if (request.path === savePath) return { ok: true, config: updated.config, status: updated }
    return { ok: true, started: true }
  } })
  assert.equal(typeof h.createCheckinPanel, 'function', 'panel request controller is present')
  const panel = h.createCheckinPanel({ initialStatus: original, changed() {} })
  const stale = panel.refresh()
  panel.patchDraft(() => updated.config)
  await h.tickSave()
  old.resolve(original); await stale
  assert.equal(panel.view().draft.games.genshin, false)
  await panel.runNow(panel.view().targets)
  assert.deepEqual(writes(h).filter((r) => r.path === runPath), [{ path: runPath, method: 'POST', body: { gameIds: ['starrail'], dabieye: false, accountRevision: rev1 } }])
})

test('targets-changed enters refresh, prevents duplicates, and never retries the rejected write', async () => {
  const status = fixture(), start = deferred(), refresh = deferred(), refreshStarted = deferred()
  const h = harness({ respond: ({ method }) => {
    if (method !== 'GET') return start.promise
    refreshStarted.resolve()
    return refresh.promise
  } })
  assert.equal(typeof h.createCheckinPanel, 'function', 'panel request controller is present')
  const panel = h.createCheckinPanel({ initialStatus: status, changed() {} })
  const first = panel.runNow(panel.view().targets)
  assert.equal(panel.view().runBlocked, 'runBusy')
  await panel.runNow(panel.view().targets)
  start.resolve({ ok: false, started: false, error: { code: 'targets-changed', message: '已保存的签到项目已变更，请刷新后再试' } })
  await refreshStarted.promise
  assert.equal(panel.view().runIssue, 'targetsChanged')
  await panel.runNow(panel.view().targets)
  assert.deepEqual(h.requests.map((r) => r.path), [runPath, '/api/mys/status'])
  refresh.resolve(fixture(config([], false))); await first
  assert.equal(panel.view().runBlocked, 'noTargets')
  assert.equal(writes(h).length, 1)
})

test('failed status read blocks stale targets until a successful read', async () => {
  const status = fixture()
  let online = false
  const h = harness({ respond() {
    if (!online) throw new Error('Synthetic Host outage')
    return status
  } })
  assert.equal(typeof h.createCheckinPanel, 'function', 'panel request controller is present')
  const panel = h.createCheckinPanel({ initialStatus: status, changed() {} })
  await panel.refresh()
  assert.equal(panel.view().runBlocked, 'runOffline')
  await panel.runNow(panel.view().targets)
  assert.deepEqual(writes(h), [])
  online = true
  await panel.refresh()
  assert.equal(panel.view().runBlocked, null)
})

const legacyStatus = { ...fixture(), checkinProtocol: undefined, configRevision: undefined, accountRevision: undefined,
  config: { ...config(), community: { enabled: true, gids: ['2'] } } }

test('legacy Host status with gid 2 disables settings and action, including direct invocation of old callbacks', async () => {
  const status = fixture()
  const h = harness({ keepPanel: true, respond: () => legacyStatus })
  const old = h.tree(status), staleButton = launch(old, h)
  const staleSwitch = nodes(old).find((node) => node.props?.label === h.t('dabieye'))
  await h.refreshPanel()
  const legacy = h.tree()
  assert.match(text(legacy), /宿主端.*不兼容/)
  assert.equal(launch(legacy, h).props.disabled, true)
  for (const control of nodes(legacy).filter((node) => node.type === 'input' || node.type?.name === 'Switch')) assert.equal(control.props.disabled, true)
  staleSwitch.props.onChange(false)
  await staleButton.props.onClick()
  assert.deepEqual(writes(h), [])
})

test('a Host rollback after a compatible read never receives a legacy config write or replay', async () => {
  const h = harness({ keepPanel: true, respond: ({ method, path }) => method === 'GET' ? legacyStatus
    : path === savePath ? { error: 'not found' } : { ok: true, config: legacyStatus.config } })
  const tree = h.tree(fixture())
  nodes(tree).find((node) => node.props?.label === h.t('dabieye')).props.onChange(false)
  await h.tickSave()
  assert.deepEqual(writes(h).map((r) => r.path), [savePath])
  assert.equal(launch(h.tree(), h).props.disabled, true)
  assert.match(text(h.tree()), /宿主端.*不兼容/)
})

test('a competing save seen mid-edit cannot rebase or replay a stale draft; review latest before running', async () => {
  const status = fixture(), current = fixture(config(['genshin'], false), rev2)
  const h = harness({ keepPanel: true, respond: ({ method, body }) => method === 'GET' ? current
    : body.configRevision === rev1 ? { ok: false, error: { code: 'config-conflict' } } : { ok: true, status, config: status.config } })
  const first = h.tree(status), old = launch(first, h)
  nodes(first).find((node) => node.type === 'label' && node.props?.children?.[0] === h.t('timezone')).props.children[1].props.onChange({ target: { value: 'UTC' } })
  await h.refreshPanel()
  await h.tickSave()
  assert.deepEqual(writes(h).map(({ path, body }) => [path, body.configRevision, body.config.community.enabled]), [[savePath, rev1, true]])
  assert.match(text(h.tree()), /已放弃.*重新应用/)
  assert.equal(nodes(h.tree()).find((node) => node.props?.label === h.t('dabieye')).props.checked, false)
  await old.props.onClick()
  assert.equal(writes(h).length, 1)
  assert.equal(launch(h.tree(), h).props.disabled, true)
})

test('unchanged targets do not let a stale account render dispatch; fresh click binds new account', async () => {
  const old = fixture(), newer = fixture(old.config, rev1, rev2)
  const h = harness({ keepPanel: true, respond: ({ method }) => method === 'GET' ? newer : { ok: true, started: true } })
  const stale = launch(h.tree(old), h)
  await h.refreshPanel()
  await stale.props.onClick()
  assert.deepEqual(writes(h), [])
  assert.match(text(h.tree()), /登录账号.*变更.*再次点击/)
  await launch(h.tree(), h).props.onClick()
  assert.deepEqual(writes(h).map(({ body }) => body), [{ gameIds: ['genshin'], dabieye: true, accountRevision: rev2 }])
})

test('independent records show business date and time, and account coins have their own heading', () => {
  const h = harness(), status = fixture(), at = Date.parse('2020-11-18T20:00:00Z')
  status.timezone = 'UTC'
  status.lastResult = { at, date: '2020-11-18', ok: true, results: [] }
  status.community.lastResult = { at, day: '2020-11-19', ok: true, results: [] }
  const view = h.tree(status)
  const game = nodes(view).find((node) => node.type === 'h2' && text(node) === '上次游戏签到')
  assert.ok(game)
  assert.match(text(view), /2020.11.18.*20:00:00.*UTC.*历史记录/)
  const item = nodes(view).find((node) => node.type?.name === 'CommunityResults')
  const community = item.type(item.props)
  assert.match(text(community), /上次大别野签到.*2020.11.19.*04:00:00.*Asia\/Shanghai.*历史记录/)
  assert.match(text(view), /分别记录.*不一定.*同一轮/)
  const snapshot = nodes(view).find((node) => node.type?.name === 'CoinSnapshot')
  assert.ok(nodes(snapshot.type(snapshot.props)).find((node) => node.type === 'h2' && text(node) === '账号米游币快照'))
})

test('both game CAPTCHA codes and skipped-only community verification offer manual App guidance', () => {
  const h = harness()
  for (const code of ['CAPTCHA', 'CAPTCHA_REQUIRED']) {
    const status = fixture()
    status.lastError = { code, message: 'stop' }
    status.community.lastError = { code: 'captcha', message: 'also stop' }
    status.community.lastResult = { ok: false, results: [{ gid: '5', outcome: 'skipped' }] }
    const view = h.tree(status)
    assert.match(text(view), /米游社 App.*手动.*验证/)
    const item = nodes(view).find((node) => node.type?.name === 'CommunityResults')
    const community = item.type(item.props)
    assert.match(text(community), /米游社 App.*手动处理/)
    assert.equal(nodes(community).find((node) => text(node) === '未执行')?.props['data-tone'], '')
    status.community.lastError = null
    status.community.lastResult.results[0].outcome = 'captcha'
    assert.match(text(item.type(item.props)), /米游社 App.*手动处理/)
    status.community.lastResult.results[0].outcome = 'unknown'
    assert.match(text(item.type(item.props)), /结果不明.*先在米游社 App 核对/)
  }
})

for (const [reachable, sessionValid, expected] of [[null, undefined, /尚未登录，无法检测/], [false, null, /网络不可达/], [true, true, /接口可用，登录有效/], [true, false, /接口可用，但登录无效/]]) {
  test(`read-only verification is categorized by reachable=${reachable}, sessionValid=${sessionValid}`, async () => {
    const h = harness({ respond: () => ({ ok: true, reachable, sessionValid, message: 'synthetic check' }) })
    const status = fixture()
    await nodes(h.tree(status)).find((node) => node.type?.name === 'Button' && text(node) === '检测接口与登录').props.onClick()
    assert.match(text(h.tree(status)), expected)
  })
}

test('check-in controls stay local and use installed theme tokens, with target heading and description association', () => {
  const h = harness()
  assert.deepEqual(h.imports, ['react'])
  const view = h.tree(fixture()), card = nodes(view).find((node) => node.props?.title === '签到项目')
  const wrapper = card.type(card.props)
  for (const key of ['aria-labelledby', 'aria-describedby']) assert.ok(nodes(wrapper).find((node) => node.props?.id && node.props.id === wrapper.props[key]))
  assert.match(source, /var\(--dsw-alias-switch-thumb\)/)
  assert.match(source, /var\(--ds-font-family-code\)/)
  assert.match(source, /var\(--dsw-alias-state-warn-label\)/)
  assert.doesNotMatch(source, /--dsw-alias-state-warning-primary|--dsw-font-mono/)
})

test('real Host stops a competing client observed during debounce, refreshes authoritative scope, and never retries', async (t) => {
  const oldHome = process.env.DSH_HOME
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mys-client-conflict-'))
  process.env.DSH_HOME = home
  const originalFetch = globalThis.fetch
  let externalCalls = 0
  globalThis.fetch = async () => { externalCalls++; throw new Error('External requests are forbidden') }
  const routes = new Map()
  const service = new MysService({ timeout: () => () => {}, connection: { fetch: { register(route) {
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  } } } })
  t.after(() => {
    service.dispose()
    globalThis.fetch = originalFetch
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    assert.equal(externalCalls, 0)
  })
  const respond = async ({ method, path, body }) => {
    assert.ok(routes.has(path), `Unregistered Host route: ${path}`)
    return (await routes.get(path).fetch(new Request(`http://offline.invalid${path}`, {
      method, ...(method === 'POST' && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    }))).json()
  }
  const original = await respond({ method: 'GET', path: '/api/mys/status' })
  const enabled = await respond({ method: 'POST', path: savePath, body: { config: { community: { enabled: true } }, configRevision: original.configRevision } })
  assert.equal(enabled.ok, true)
  const a = harness({ respond, keepPanel: true }), b = harness({ respond, keepPanel: true })
  const aRendered = a.tree(enabled.status), bRendered = b.tree(enabled.status)
  nodes(aRendered).find((node) => node.type === 'label' && node.props?.children?.[0] === a.t('timezone')).props.children[1].props.onChange({ target: { value: 'UTC' } })
  nodes(bRendered).find((node) => node.props?.label === b.t('dabieye')).props.onChange(false)
  await b.tickSave()
  await a.refreshPanel()
  await a.tickSave()
  assert.match(text(a.tree()), /已放弃.*重新应用/)
  assert.equal(nodes(a.tree()).find((node) => node.props?.label === a.t('dabieye')).props.checked, false)
  assert.equal(service.statusPayload().config.community.enabled, false)
  assert.deepEqual(writes(a).map((r) => r.path), [savePath])
  assert.equal(writes(a)[0].body.configRevision, enabled.status.configRevision)
  assert.equal(launch(a.tree(), a).props.disabled, true)
})
