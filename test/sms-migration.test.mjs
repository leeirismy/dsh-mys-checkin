import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
test('active ESM host/client/config contains no QR login or rendering dependencies', async () => {
  const names = ['index.js', 'client.js', ...(await readdir(new URL('lib/', root))).filter(n => n.endsWith('.js')).map(n => `lib/${n}`)]
  for (const name of names) {
    const source = await readFile(new URL(name, root), 'utf8')
    assert.doesNotMatch(source, /createQRLogin|queryQRLoginStatus|BarcodeDetector|qrSvgDataUrl|encodeQr|maxQrAgeMs|useDetector|QrDialog|login\/poll|扫码/, name)
  }
  assert.equal(names.includes('lib/qr.js'), false)
})
test('manifest advertises SMS and keeps zero-dependency Node22 ESM packaging with notices', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  assert.equal(pkg.type, 'module'); assert.equal(pkg.engines.node, '>=22')
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0)
  assert.match(pkg.description, /短信/); assert.doesNotMatch(pkg.description, /扫码/)
  assert.ok(pkg.files.includes('THIRD_PARTY_NOTICES.md'))
})
