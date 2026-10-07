import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeAll } from './merge.mjs'

const entry = (over) => ({
  id: 'x',
  name: 'X',
  description: 'd',
  category: 'c',
  source: 'github',
  ...over
})

test('mergeAll：手动精选优先保留，官方同键回填 updatedAt/version/registryUrl', () => {
  const existing = [entry({ id: 'registry:a', packageName: 'pkg-a', source: 'registry', name: '人工名', updatedAt: 100 })]
  const official = [entry({ id: 'registry:a', packageName: 'pkg-a', updatedAt: 200, version: '1.2.0', registryUrl: 'https://r' })]
  const out = mergeAll({ official, smithery: [], github: [] }, existing)
  assert.equal(out.length, 1)
  assert.equal(out[0].name, '人工名', '不覆盖人工名称')
  assert.equal(out[0].updatedAt, 200, '回填更新的时间')
  assert.equal(out[0].version, '1.2.0')
  assert.equal(out[0].registryUrl, 'https://r')
})

test('mergeAll：来源优先级 官方 > Smithery > GitHub；不同键全部保留', () => {
  const official = [entry({ id: 'registry:a', packageName: 'dup', source: 'registry' })]
  const smithery = [
    entry({ id: 'smithery:a', packageName: 'dup', source: 'smithery', useCount: 10 }),
    entry({ id: 'smithery:b', packageName: 'only-s', source: 'smithery' })
  ]
  const github = [
    entry({ id: 'github:c', packageName: 'dup', source: 'github', stars: 999 }),
    entry({ id: 'github:d', packageName: 'only-g', source: 'github' })
  ]
  const out = mergeAll({ official, smithery, github }, [])
  const byPkg = Object.fromEntries(out.map((e) => [e.packageName, e.source]))
  assert.equal(byPkg['dup'], 'registry', '同包名官方优先')
  assert.equal(byPkg['only-s'], 'smithery')
  assert.equal(byPkg['only-g'], 'github')
  assert.equal(out.length, 3)
})
