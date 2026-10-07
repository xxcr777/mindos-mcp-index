import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isValidEntry, dedupeKey } from './client-rules.mjs'

test('isValidEntry：合法条目（npm/pypi/docker/url/command 五形态）通过', () => {
  const base = { id: 'github:a/b', name: 'X', description: 'd', category: '开发工具', source: 'github' }
  assert.equal(isValidEntry({ ...base, packageName: '@scope/pkg', packageType: 'npm' }), true)
  assert.equal(isValidEntry({ ...base, packageName: 'pkg', packageType: 'pypi' }), true)
  assert.equal(isValidEntry({ ...base, packageName: 'ghcr.io/a/b:latest', packageType: 'docker' }), true)
  assert.equal(isValidEntry({ ...base, url: 'https://example.com/mcp' }), true)
  assert.equal(isValidEntry({ ...base, command: 'npx', args: ['-y', 'pkg'] }), true)
})

test('isValidEntry：非法条目被拒（缺字段/坏来源/坏包名/无安装形态）', () => {
  assert.equal(isValidEntry(null), false)
  assert.equal(isValidEntry({ id: 'x', name: 'x', description: 'd' }), false) // 缺 category/source
  assert.equal(
    isValidEntry({ id: 'x', name: 'x', description: 'd', category: 'c', source: 'evil' }),
    false
  )
  assert.equal(
    isValidEntry({ id: 'x', name: 'x', description: 'd', category: 'c', source: 'github', packageName: '@bad name!' }),
    false
  )
  assert.equal(
    isValidEntry({ id: 'x', name: 'x', description: 'd', category: 'c', source: 'github', packageName: 'ok' , packageType: 'zip' }),
    false
  )
  assert.equal(isValidEntry({ id: 'x', name: 'x', description: 'd', category: 'c', source: 'github' }), false)
})

test('dedupeKey：包名优先、其次 url、最后 id', () => {
  assert.equal(dedupeKey({ packageName: 'pkg', url: 'https://x', id: 'i' }), 'pkg:pkg')
  assert.equal(dedupeKey({ url: 'https://x', id: 'i' }), 'url:https://x')
  assert.equal(dedupeKey({ id: 'i' }), 'id:i')
})
