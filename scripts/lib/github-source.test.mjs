import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractRepoLinks,
  isListLikeRepo,
  isMcpInstallTarget,
  isLocalUrl,
  derivePackageNameCandidates,
  pickCandidates,
  shouldReparse,
  pruneCache,
  buildGitHubEntry,
  emptyGitHubCache,
  REPARSE_FAIL_BACKOFF_MS,
  CACHE_IDLE_MS,
  GITHUB_STARS_MIN
} from './github-source.mjs'

const repo = (over = {}) => ({
  full_name: 'owner/repo',
  name: 'repo',
  stargazers_count: 500,
  description: 'An MCP server',
  topics: ['mcp-server'],
  archived: false,
  pushed_at: '2026-10-01T00:00:00Z',
  html_url: 'https://github.com/owner/repo',
  ...over
})

test('extractRepoLinks：解析 README 链接（含 /tree 后缀、.git 后缀），排除保留段', () => {
  const links = extractRepoLinks(`
- [A](https://github.com/owner-a/repo-a)
- [B](https://github.com/owner-b/repo-b/tree/main/src)
- [C](https://github.com/owner-c/repo-c.git)
- [D](https://github.com/owner-d/repo-d#readme)
- [topics](https://github.com/topics/mcp-server)
- [org](https://github.com/orgs/foo/repositories)
- 普通链接 https://example.com/owner/repo
`)
  assert.deepEqual(links.sort(), ['owner-a/repo-a', 'owner-b/repo-b', 'owner-c/repo-c', 'owner-d/repo-d'])
})

test('isListLikeRepo：awesome/列表类仓库排除（防 README 命令污染）', () => {
  assert.equal(isListLikeRepo(repo({ name: 'awesome-mcp-servers' })), true)
  assert.equal(isListLikeRepo(repo({ topics: ['awesome-list'] })), true)
  assert.equal(isListLikeRepo(repo({ topics: ['mcp-server-list'] })), true)
  assert.equal(isListLikeRepo(repo({ name: 'mcp-server' })), false)
})

test('isMcpInstallTarget（v3）：安装目标本身是 MCP 才收；大工具蹭 topics/mcp 无效', () => {
  // docker：镜像名含 mcp 才收（n8n/open-webui/crawl4ai 镜像无 mcp → 拒）
  assert.equal(isMcpInstallTarget({ packageName: 'ghcr.io/github/github-mcp-server', packageType: 'docker' }), true)
  assert.equal(isMcpInstallTarget({ packageName: 'docker.n8n.io/n8nio/n8n', packageType: 'docker' }), false)
  assert.equal(isMcpInstallTarget({ packageName: 'ghcr.io/open-webui/open-webui:main', packageType: 'docker' }), false)
  // npm：包名含 mcp/@modelcontextprotocol 收；不含时看包 keywords 标记
  assert.equal(isMcpInstallTarget({ packageName: '@upstash/context7-mcp', packageType: 'npm' }), true)
  assert.equal(isMcpInstallTarget({ packageName: '@modelcontextprotocol/server-memory', packageType: 'npm' }), true)
  assert.equal(isMcpInstallTarget({ packageName: '@google/gemini-cli', packageType: 'npm' }), false)
  assert.equal(isMcpInstallTarget({ packageName: 'plain-tool', packageType: 'npm' }, { keywordsMcp: true }), true)
  assert.equal(isMcpInstallTarget({ packageName: 'plain-tool', packageType: 'npm' }, { keywordsMcp: false }), false)
  // pypi 同 npm
  assert.equal(isMcpInstallTarget({ packageName: 'mcp-server-fetch', packageType: 'pypi' }), true)
  assert.equal(isMcpInstallTarget({ packageName: 'plain-py', packageType: 'pypi' }, { keywordsMcp: true }), true)
  // url：远程端点含 mcp 收；localhost/内网拒（用户本机部署不可分发）
  assert.equal(isMcpInstallTarget({ url: 'https://mcp.example.com/sse' }), true)
  assert.equal(isMcpInstallTarget({ url: 'http://localhost:3333/mcp' }), false)
  assert.equal(isMcpInstallTarget({ url: 'http://192.168.1.10:8080/mcp' }), false)
  assert.equal(isMcpInstallTarget({ url: 'https://api.example.com/other' }), false)
})

test('isLocalUrl：localhost/环回/内网地址判定', () => {
  assert.equal(isLocalUrl('http://localhost:3333/mcp'), true)
  assert.equal(isLocalUrl('http://127.0.0.1:8080'), true)
  assert.equal(isLocalUrl('http://0.0.0.0:3000'), true)
  assert.equal(isLocalUrl('http://10.0.0.5/mcp'), true)
  assert.equal(isLocalUrl('http://172.20.3.4/mcp'), true)
  assert.equal(isLocalUrl('https://mcp.example.com/sse'), false)
  assert.equal(isLocalUrl('https://172.15.0.1/mcp'), false)
})

test('derivePackageNameCandidates：仅名字含 mcp 时推导候选（下划线变体）', () => {
  assert.deepEqual(derivePackageNameCandidates('mcp-server-foo'), ['mcp-server-foo'])
  assert.deepEqual(derivePackageNameCandidates('foo_mcp'), ['foo_mcp', 'foo-mcp'])
  assert.deepEqual(derivePackageNameCandidates('MCP-Git'), ['mcp-git'])
  assert.deepEqual(derivePackageNameCandidates('n8n'), [])
  assert.deepEqual(derivePackageNameCandidates(undefined), [])
})

test('pickCandidates：stars 门槛/archived/无描述过滤 + stars 排序 + 截取', () => {
  const map = new Map([
    ['a/star-1000', repo({ full_name: 'a/star-1000', stargazers_count: 1000 })],
    ['b/star-200', repo({ full_name: 'b/star-200', stargazers_count: 200 })],
    ['c/low', repo({ full_name: 'c/low', stargazers_count: GITHUB_STARS_MIN - 1 })],
    ['d/archived', repo({ full_name: 'd/archived', stargazers_count: 900, archived: true })],
    ['e/nodesc', repo({ full_name: 'e/nodesc', stargazers_count: 800, description: '  ' })],
    ['f/awesome', repo({ full_name: 'f/awesome', name: 'awesome-x', stargazers_count: 700 })]
  ])
  const picked = pickCandidates(map, { starsMin: GITHUB_STARS_MIN, limit: 10 })
  assert.deepEqual(picked.map((r) => r.full_name), ['a/star-1000', 'b/star-200'])

  const limited = pickCandidates(map, { starsMin: GITHUB_STARS_MIN, limit: 1 })
  assert.deepEqual(limited.map((r) => r.full_name), ['a/star-1000'])
})

test('shouldReparse：新仓库重解析、pushedAt 变化重解析、成功命中跳过、失败退避', () => {
  const now = 1_000_000_000_000
  assert.equal(shouldReparse(undefined, 'p1', now), true)
  assert.equal(shouldReparse({ pushedAt: 'p0', entry: { id: 'x' } }, 'p1', now), true)

  const ok = { pushedAt: 'p1', entry: { id: 'x' }, lastTryAt: now - 1000 }
  assert.equal(shouldReparse(ok, 'p1', now), false)

  const failedRecent = { pushedAt: 'p1', entry: null, lastTryAt: now - 1000 }
  assert.equal(shouldReparse(failedRecent, 'p1', now), false, '退避期内不重试')

  const failedOld = { pushedAt: 'p1', entry: null, lastTryAt: now - REPARSE_FAIL_BACKOFF_MS - 1 }
  assert.equal(shouldReparse(failedOld, 'p1', now), true, '退避期外重试')
})

test('pruneCache：活跃条目保 seen；长期不在候选池的缓存被淘汰', () => {
  const now = 1_000_000_000_000
  const cache = emptyGitHubCache()
  cache.parsed['a/active'] = { pushedAt: 'p', entry: { id: 'a' }, lastTryAt: now }
  cache.parsed['b/stale'] = { pushedAt: 'p', entry: { id: 'b' }, lastTryAt: now }
  cache.parsed['c/grace'] = { pushedAt: 'p', entry: { id: 'c' }, lastTryAt: now }
  cache.seen['b/stale'] = now - CACHE_IDLE_MS - 1
  cache.seen['c/grace'] = now - 1000

  pruneCache(cache, ['a/active'], now)

  assert.equal(cache.seen['a/active'], now)
  assert.ok(cache.parsed['a/active'])
  assert.equal(cache.parsed['b/stale'], undefined, '超期未出现 → 淘汰')
  assert.ok(cache.parsed['c/grace'], '宽限期内保留')
})

test('buildGitHubEntry：stars→useCount、包时间→updatedAt、url 形态；分类用 topics', () => {
  const npmEntry = buildGitHubEntry(repo({ stargazers_count: 1234 }), { packageName: '@a/b', packageType: 'npm' }, 1700000000)
  assert.equal(npmEntry.id, 'github:owner/repo')
  assert.equal(npmEntry.stars, 1234)
  assert.equal(npmEntry.useCount, 1234)
  assert.equal(npmEntry.packageName, '@a/b')
  assert.equal(npmEntry.updatedAt, 1700000000)

  const urlEntry = buildGitHubEntry(repo({ topics: ['search'] }), { url: 'https://x/mcp', packageType: 'none' }, undefined)
  assert.equal(urlEntry.url, 'https://x/mcp')
  assert.equal(urlEntry.updatedAt, undefined)
  assert.equal(urlEntry.category, '搜索', 'topics 参与分类')

  const noTime = buildGitHubEntry(repo(), { packageName: 'p', packageType: 'npm' }, undefined)
  assert.equal(noTime.updatedAt, undefined)
})
