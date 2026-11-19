import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

// Actual callbacks and element descriptions, not a DOM, React renderer, or live Host.
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8').replace(
  "      inject: ['slots', 'locale'],",
  "      units: { createCheckinPanel: typeof createCheckinPanel === 'function' && createCheckinPanel, createConfigSaveQueue: typeof createConfigSaveQueue === 'function' && createConfigSaveQueue }, inject: ['slots', 'locale'],",
)
function harness({ respond = () => { throw new Error('Unexpected offline request') }, locale = 'zh', keepPanel = false } = {}) {
  let plugin, dictionaries, panel
  const slots = new Map(), requests = [], timers = new Map()
  let timerId = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(init) {
      const value = typeof init === 'function' ? init() : init
      // Share only the controller across two explicit element descriptions.
      return [keepPanel && value?.runNow && value?.refresh ? (panel ??= value) : value, () => {}]
    },
    useEffect: () => {}, useRef: (current) => ({ current }),
    useCallback: (fn) => fn, useMemo: (fn) => fn(),
  }
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory((id) => {
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
    tree: (status) => slots.get('main')({ t, __status: status }), t, requests, ...plugin.units,
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
function fixture(saved = config()) {
  return {
    ok: true, running: false, login: { state: 'active' }, config: saved,
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
    assert.deepEqual(writes(h), [{ path: runPath, method: 'POST', body: { gameIds, dabieye } }])
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
  assert.deepEqual(writes(h), [{ path: runPath, method: 'POST', body: { gameIds: ['starrail'], dabieye: true } }])
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
  assert.deepEqual(writes(h), [{ path: runPath, method: 'POST', body: { gameIds: ['genshin'], dabieye: true } }])
})

test('results show community acceptance separately from historical coin balance and query failure', () => {
  const h = harness(), status = fixture()
  status.community.lastResult = { at: 123, ok: true, results: [{ gid: '5', label: '大别野', outcome: 'success', message: '合成结果' }] }
  status.community.balanceError = { message: '合成查询错误' }
  status.community.balance = { totalPoints: 1234, todayReceived: 10, todayRemaining: 0, at: 123, day: '2000-01-01' }
  const element = nodes(h.tree(status)).find((node) => ['CommunityResults', 'CommunityCard'].includes(node.type?.name))
  assert.ok(element, 'community result description is present')
  const content = text(element.type({ ...element.props, config: status.config }))
  assert.match(content, /接口已接受.*积分到账未独立验证/)
  assert.match(content, /积分查询失败/)
  assert.match(content, /历史.*快照/)
  assert.match(content, /1234/)
  assert.doesNotMatch(content, /本次赚取|每日上限|今日余额|签到分区/)
})

test('save queue serializes requests and coalesces queued submissions to the latest snapshot', async () => {
  const h = harness(), a = deferred(), c = deferred(), startedA = deferred(), startedC = deferred(), sent = []
  assert.equal(typeof h.createConfigSaveQueue, 'function', 'config queue is independently testable')
  const queue = h.createConfigSaveQueue({ changed() {}, save(next) {
    sent.push(next)
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
  a.resolve(config(['genshin'], false))
  await startedC.promise
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[1], config(['starrail'], true))
  assert.equal(queue.view().pending, true)
  c.resolve(config(['starrail'], false))
  await first
  assert.equal(queue.view().pending, false)
  assert.deepEqual(queue.view().confirmed, config(['starrail'], false))
})

test('new debounce immediately blocks run through superseded success, failed save and polling; recovery uses normalized confirmation', async () => {
  const a = deferred(), b = deferred(), c = deferred(), startedA = deferred(), status = fixture()
  let saves = 0
  const h = harness({ respond(request) {
    if (request.path.endsWith('/config')) {
      if (saves === 0) startedA.resolve()
      return [a.promise, b.promise, c.promise][saves++]
    }
    if (request.path === runPath) return { ok: true, started: true }
    return saves < 3 ? status : fixture(config(['starrail'], false))
  } })
  assert.equal(typeof h.createCheckinPanel, 'function', 'panel request controller is present')
  const panel = h.createCheckinPanel({ initialStatus: status, changed() {} })
  const edit = (key, value) => panel.patchDraft((next) => { next.games[key] = value; return next })
  edit('starrail', true)
  const saveA = h.tickSave()
  await startedA.promise
  edit('genshin', false)
  assert.equal(panel.view().runBlocked, 'saving')
  a.resolve({ ok: true, config: config(['genshin', 'starrail'], true) }); await saveA
  assert.equal(panel.view().runBlocked, 'saving', 'A does not unlock while B is still in debounce')
  assert.equal(panel.view().draft.games.genshin, false)
  await panel.runNow(panel.view().targets)
  const saveB = h.tickSave()
  b.resolve({ ok: false, error: { code: 'save-refused', message: 'synthetic save rejection' } }); await saveB
  await panel.refresh()
  assert.equal(panel.view().runBlocked, 'saveFail')
  assert.equal(panel.view().draft.games.genshin, false)
  await panel.runNow(panel.view().targets)
  assert.equal(writes(h).filter((r) => r.path === runPath).length, 0)
  edit('starrail', true)
  const saveC = h.tickSave()
  c.resolve({ ok: true, config: config(['starrail'], false) }); await saveC
  assert.equal(panel.view().draft.community.enabled, false)
  await panel.runNow(panel.view().targets)
  assert.deepEqual(writes(h).filter((r) => r.path === runPath), [{ path: runPath, method: 'POST', body: { gameIds: ['starrail'], dabieye: false } }])
})

test('status GET started before save cannot resurrect the old confirmed selection after save', async () => {
  const old = deferred(), original = fixture(), updated = fixture(config(['starrail'], false))
  let reads = 0
  const h = harness({ respond(request) {
    if (request.path.endsWith('/status')) return ++reads === 1 ? old.promise : updated
    if (request.path.endsWith('/config')) return { ok: true, config: updated.config, status: updated }
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
  assert.deepEqual(writes(h).filter((r) => r.path === runPath), [{ path: runPath, method: 'POST', body: { gameIds: ['starrail'], dabieye: false } }])
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
