import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localizeDescriptions, hasChinese, TRANSLATE_FAIL_BREAKER } from './translate.mjs'

function makeTmpPath() {
  const dir = mkdtempSync(join(tmpdir(), 'mindos-translate-'))
  return { dir, path: join(dir, 'translations.json') }
}

test('localizeDescriptions：连续翻译失败触发熔断，剩余条目跳过且不写缓存', async () => {
  const { dir, path } = makeTmpPath()
  try {
    writeFileSync(path, '{}')
    const entries = Array.from({ length: 30 }, (_, i) => ({ id: `e${i}`, description: `english description ${i}` }))
    let calls = 0
    const failingTranslate = async () => {
      calls++
      return null
    }
    await localizeDescriptions(entries, path, () => {}, failingTranslate)
    // 熔断：调用次数在阈值附近（并发在途允许少量超出），远小于条目总数
    assert.ok(calls >= TRANSLATE_FAIL_BREAKER, `expected at least breaker-threshold calls, got ${calls}`)
    assert.ok(calls <= TRANSLATE_FAIL_BREAKER + 4, `expected calls near breaker threshold, got ${calls}`)
    // 失败不写缓存；所有条目均无 descriptionZh
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')), {})
    assert.equal(entries.filter((e) => e.descriptionZh).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('localizeDescriptions：成功翻译写缓存并回填 descriptionZh；已中文原样透传', async () => {
  const { dir, path } = makeTmpPath()
  try {
    writeFileSync(path, '{}')
    const entries = [
      { id: 'e0', description: 'english one' },
      { id: 'e1', description: '已经有中文描述' }
    ]
    const okTranslate = async (text) => `译:${text}`
    await localizeDescriptions(entries, path, () => {}, okTranslate)
    assert.equal(entries[0].descriptionZh, '译:english one')
    assert.equal(entries[1].descriptionZh, '已经有中文描述')
    const cache = JSON.parse(readFileSync(path, 'utf-8'))
    assert.equal(cache.e0, '译:english one')
    assert.equal(cache.e1, undefined, '已中文条目不进缓存')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hasChinese：中文检测', () => {
  assert.equal(hasChinese('中文描述'), true)
  assert.equal(hasChinese('english only'), false)
  assert.equal(hasChinese(undefined), false)
})
