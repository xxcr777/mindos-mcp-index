import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs } from './build-index.mjs'
import { classify } from './lib/classify.mjs'

test('parseArgs：--dry-run / --source / --limit 解析与非法值忽略', () => {
  assert.deepEqual(parseArgs([]), { dryRun: false, source: null, limit: null })
  assert.deepEqual(parseArgs(['--dry-run', '--source=github', '--limit=50']), {
    dryRun: true,
    source: 'github',
    limit: 50
  })
  assert.deepEqual(parseArgs(['--limit=0', '--limit=abc']), { dryRun: false, source: null, limit: null })
})

test('classify：典型仓库命中分类，兜底"自定义"', () => {
  assert.equal(classify('playwright-mcp', 'Browser automation via MCP'), '浏览器自动化')
  assert.equal(classify('postgres-mcp', 'PostgreSQL database access'), '数据库')
  assert.equal(classify('github-mcp', 'GitHub API integration'), '代码托管平台')
  // 子串不误报：'words' 不命中 'word'（文档协作）、'device' 不命中 'dev'
  assert.equal(classify('acme-widget', 'unrelated words about a device'), '自定义')
  assert.equal(classify('zzz', 'qwerty'), '自定义')
})
