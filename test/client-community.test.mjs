import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

// Unit-only element descriptions: no DOM, effects, timers, visual renderer or real fetch.
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
function harness() {
  let plugin
  const slots = new Map(), requests = []
  let dictionaries
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {}, useRef: (current) => ({ current }),
    useCallback: (fn) => fn, useMemo: (fn) => fn(),
  }
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory((id) => {
      if (id === 'react') return React
      throw new Error(`Unexpected browser dependency: ${id}`)
    }) } } },
    document: { baseURI: 'http://offline.invalid/' }, URL, Date, Intl, structuredClone,
    fetch: async (url, init) => { requests.push({ url, init }); return { status: 200, text: async () => JSON.stringify({ ok: true }) } },
  })
  plugin.apply({
    effect: (fn, name) => { if (name.endsWith('dictionaries')) fn() },
    locale: { register: (ns, values) => { dictionaries = values }, bind: () => (key) => dictionaries.zh[key] ?? key },
    slots: { inject: (name, fn) => fn(), register: (meta, fn) => slots.set(meta.name, fn) },
  })
  return { Section: slots.get('main'), requests, t: (key) => dictionaries.zh[key] ?? key }
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
function fixture() {
  return {
    games: [], running: false, login: { state: 'active' },
    config: { community: { enabled: true, gids: ['5', '2'] } },
    community: { enabled: true, capability: { available: true, reason: null }, communities: [
      { id: '5', label: '大别野' }, { id: '2', label: '原神' },
    ], lastResult: null, lastError: null, balance: null, balanceError: null },
  }
}
function card(harness, status, extra = {}) {
  const tree = harness.Section({ t: harness.t, __status: status })
  const element = nodes(tree).find((node) => node.type?.name === 'CommunityCard')
  assert.ok(element, 'Community card is visible even when all games are off')
  return element.type({ ...element.props, config: status.config, ...extra })
}
function runButton(tree) { return nodes(tree).find((node) => node.props?.['data-action'] === 'community-run') }

test('community-panel-states: default off, accessible choices preserve explicit empty selection and save both switch values', () => {
  const h = harness(), status = fixture(), saved = []
  status.config.community.enabled = false; status.community.enabled = false
  const patchDraft = (mutate) => { status.config = mutate(structuredClone(status.config)); saved.push(structuredClone(status.config.community)) }
  let tree = card(h, status, { patchDraft })
  const toggle = nodes(tree).find((node) => node.type?.name === 'Switch')
  assert.equal(toggle.props.checked, false)
  assert.ok(toggle.props.label)
  toggle.props.onChange(true)
  tree = card(h, status, { patchDraft })
  for (const node of nodes(tree).filter((node) => node.type === 'input' && node.props.type === 'checkbox')) {
    assert.ok(node.props['aria-label'])
    node.props.onChange({ target: { checked: false } })
  }
  nodes(tree).find((node) => node.type?.name === 'Switch').props.onChange(false)
  assert.deepEqual(saved.map((item) => item.enabled), [true, true, true, false])
  assert.deepEqual(status.config.community.gids, [])
})

test('community-panel-states: disabled, no-token, missing-mid, empty, busy and unsaved changes cannot dispatch', () => {
  const h = harness()
  for (const change of [
    (s) => { s.config.community.enabled = false; s.community.enabled = false },
    (s) => { s.community.capability = { available: false, reason: 'no-stoken' } },
    (s) => { s.community.capability = { available: false, reason: 'missing-mid' } },
    (s) => { s.config.community.gids = [] },
    (s) => { s.running = true },
    (s) => { s.config.community.gids = ['2']; s.config = structuredClone(s.config); s.community.enabled = false },
  ]) {
    const status = fixture(); change(status)
    assert.equal(runButton(card(h, status)).props.disabled, true)
  }
  assert.equal(runButton(card(h, fixture())).props.disabled, false)
})

test('community-panel-states: partial, CAPTCHA, unknown and balance failure stay distinct; old balance is historical', () => {
  const h = harness(), status = fixture()
  status.community.lastResult = { at: 123, ok: false, results: [
    { gid: '5', label: '大别野', outcome: 'success', message: '接口已接受' },
    { gid: '2', label: '原神', outcome: 'unknown', message: '无法确认，请勿盲目重试' },
    { gid: '2', label: '原神', outcome: 'captcha', message: '需要人工验证' },
  ] }
  status.community.balanceError = { message: '积分查询失败' }
  status.community.balance = { totalPoints: 1234, todayReceived: 10, todayRemaining: 0, at: 123, day: '2000-01-01' }
  const content = text(card(h, status))
  assert.match(content, /部分|未完成/)
  assert.match(content, /接口已接受/)
  assert.match(content, /未知|无法确认/)
  assert.match(content, /人工验证/)
  assert.match(content, /积分查询失败/)
  assert.match(content, /历史.*快照/)
  assert.match(content, /1234/)
  assert.doesNotMatch(content, /本次赚取|每日上限|今日余额/)
})

test('community-button-routing: community uses its own route while original game action stays unchanged', async () => {
  const h = harness(), status = fixture()
  const tree = h.Section({ t: h.t, __status: status })
  await runButton(card(h, status)).props.onClick()
  const gameButton = nodes(tree).find((node) => node.type?.name === 'Button' && text(node) === h.t('runNow'))
  assert.ok(gameButton)
  await gameButton.props.onClick()
  assert.deepEqual(h.requests.filter((item) => item.init?.method === 'POST').map((item) => new URL(item.url).pathname), ['/api/mys/community/run', '/api/mys/run'])
})
