#!/usr/bin/env node
/**
 * 插件市场索引构建脚本（零依赖，Node 18+）
 *
 * 三源合并：
 *   1. 官方 MCP Registry —— https://registry.modelcontextprotocol.io/v0.1/servers
 *      （version=latest 取最新版，cursor 翻页，全量收录）
 *   2. Smithery —— https://registry.smithery.ai/servers （top 500，page 翻页）
 *   3. GitHub —— topic:mcp-server 按 stars 截取 top 300，
 *      raw README 解析 npx/uvx/docker 安装形态，npm/pypi 存在性校验
 *
 * 合并策略：存量条目（手动精选）优先保留，官方 Registry 同键条目回填
 * updatedAt/version；官方 > Smithery > GitHub 去重。
 * 输出前复刻客户端 isValidEntry（electron/codex/market-index.ts）自校验，
 * 并为每条描述补 descriptionZh（免费 Google 翻译 + translations.json 增量缓存，失败保持原文）。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX_PATH = join(ROOT, 'index.json')
const MANUAL_PATH = join(ROOT, 'scripts', 'manual.json')

/* ================= 客户端规则复刻（market-index.ts） ================= */
const PACKAGE_NAME_RE = /^@?[\w.-]+(?:\/[\w.-]+)?$/
const DOCKER_IMAGE_RE = /^[\w./:@-]+$/
const URL_RE = /^https?:\/\/.+/i
const PACKAGE_TYPES = new Set(['npm', 'pypi', 'docker', 'none'])
const INDEX_SOURCES = new Set(['registry', 'smithery', 'github'])

function isValidEntry(entry) {
  if (typeof entry !== 'object' || entry === null) return false
  if (typeof entry.id !== 'string' || typeof entry.name !== 'string' || typeof entry.description !== 'string' || typeof entry.category !== 'string') {
    return false
  }
  if (typeof entry.source !== 'string' || !INDEX_SOURCES.has(entry.source)) return false
  if (typeof entry.packageName === 'string') {
    if (typeof entry.packageType === 'string' && !PACKAGE_TYPES.has(entry.packageType)) return false
    if (entry.packageType === 'docker') {
      if (!DOCKER_IMAGE_RE.test(entry.packageName)) return false
    } else if (!PACKAGE_NAME_RE.test(entry.packageName)) {
      return false
    }
  } else if (typeof entry.url === 'string') {
    if (!URL_RE.test(entry.url)) return false
  } else if (typeof entry.command === 'string') {
    if (typeof entry.args !== 'undefined' && !Array.isArray(entry.args)) return false
    if (Array.isArray(entry.args) && !entry.args.every((a) => typeof a === 'string')) return false
  } else {
    return false
  }
  return true
}

/* 去重键：包名优先，其次 url（远程托管），最后 id */
function dedupeKey(entry) {
  if (typeof entry.packageName === 'string') return `pkg:${entry.packageName}`
  if (typeof entry.url === 'string') return `url:${entry.url}`
  return `id:${entry.id}`
}

/* ================= 配置 ================= */
const OFFICIAL_API = 'https://registry.modelcontextprotocol.io/v0.1/servers'
const SMITHERY_API = 'https://registry.smithery.ai/servers'
const GITHUB_SEARCH = 'https://api.github.com/search/repositories'
const GITHUB_RAW = 'https://raw.githubusercontent.com'
const NPM_REGISTRY = 'https://registry.npmjs.org'
const PYPI_REGISTRY = 'https://pypi.org/pypi'

const SMITHERY_PAGES = 50 // 服务端固定 10/页、封顶 500 条
const GITHUB_TOP_N = 300 // 按 stars 截取
const OFFICIAL_TOP_N = 1500 // 开放注册表无流行度指标，按 updatedAt 最新优先截取
const USER_AGENT = 'mindos-index-builder/1.0'
const TIMEOUT_MS = 20_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function httpJson(url, { headers = {}, retries = 2 } = {}) {
  let lastErr
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
      return await res.json()
    } catch (err) {
      lastErr = err
      if (i < retries) await sleep(1200 * (i + 1))
    }
  }
  throw lastErr
}

/** 带限流感知的 JSON 请求：403 按 Retry-After（缺省 60s）退避重试，仍失败抛错由调用方降级 */
async function httpJsonRate(url, { headers = {}, retries = 2 } = {}) {
  let lastErr
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      if (res.status === 403) {
        lastErr = new Error(`HTTP 403: ${url}`)
        const retryAfter = Number(res.headers.get('retry-after'))
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000)
        continue
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
      return await res.json()
    } catch (err) {
      lastErr = err
      if (i < retries) await sleep(1200 * (i + 1))
    }
  }
  throw lastErr
}

async function httpText(url, { retries = 2 } = {}) {
  let lastErr
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
      return await res.text()
    } catch (err) {
      lastErr = err
      if (i < retries) await sleep(1200 * (i + 1))
    }
  }
  throw lastErr
}

/** 简单并发池：items 以 limit 并发执行 fn，保持顺序 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      const idx = cursor++
      results[idx] = await fn(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

const toEpoch = (iso) => {
  if (typeof iso !== 'string') return undefined
  const t = Date.parse(iso)
  return Number.isFinite(t) ? Math.floor(t / 1000) : undefined
}

/* ================= 描述中文化（免费 Google 翻译接口 + scripts/translations.json 增量缓存） =================
 * 已中文描述原样；未命中缓存调用 client=gtx 免费接口翻译并写回缓存，
 * 之后每次构建只翻译新增条目（幂等），失败降级保持英文原文（客户端回退展示）。
 */
const TRANSLATIONS_PATH = join(ROOT, 'scripts', 'translations.json')
const GOOGLE_TL = 'https://translate.googleapis.com/translate_a/single'
const HAN_RE = /[\u3400-\u9fff]/
const TRANSLATE_CONCURRENCY = 3
const TRANSLATE_INTERVAL_MS = 150

function hasChinese(text) {
  return typeof text === 'string' && HAN_RE.test(text)
}

function readTranslations() {
  try {
    const raw = JSON.parse(readFileSync(TRANSLATIONS_PATH, 'utf8'))
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  } catch {
    /* 首次运行无缓存 */
  }
  return {}
}

function writeTranslations(cache) {
  writeFileSync(TRANSLATIONS_PATH, JSON.stringify(cache, null, 2) + '\n')
}

/** 免费 Google 翻译（client=gtx 无需 key），失败或结果为空返回 null；429/5xx 退避重试 */
async function googleTranslate(text, retries = 2) {
  const url = `${GOOGLE_TL}?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      if (res.status === 429) {
        await sleep(1500 * (i + 1))
        continue
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const zh = (Array.isArray(data?.[0]) ? data[0] : [])
        .map((seg) => (Array.isArray(seg) ? String(seg[0]) : ''))
        .join('')
        .trim()
      return zh || null
    } catch {
      if (i < retries) await sleep(1200 * (i + 1))
    }
  }
  return null
}

/** 逐条补上 descriptionZh（已中文原样 / 缓存命中 / 翻译新条目并写回缓存） */
async function localizeDescriptions(entries) {
  const cache = readTranslations()
  const stat = { alreadyChinese: 0, cached: 0, translated: 0, failed: 0, done: 0 }

  await mapLimit(entries, TRANSLATE_CONCURRENCY, async (entry) => {
    if (hasChinese(entry.description)) {
      entry.descriptionZh = entry.description
      stat.alreadyChinese++
    } else if (!entry.description) {
      stat.failed++ // 空描述无翻译价值，保持无 descriptionZh（客户端回退英文）
    } else {
      const cached = cache[entry.id]
      if (typeof cached === 'string' && cached) {
        entry.descriptionZh = cached
        stat.cached++
      } else {
        await sleep(TRANSLATE_INTERVAL_MS)
        const zh = await googleTranslate(entry.description)
        if (zh) {
          cache[entry.id] = zh
          entry.descriptionZh = zh
          stat.translated++
          if (stat.translated % 50 === 0) writeTranslations(cache) // 增量落盘防中断丢进度
        } else {
          stat.failed++
        }
      }
    }
    if (++stat.done % 100 === 0) {
      console.log(`[build-index] 描述中文化进度: ${stat.done}/${entries.length}（新翻译 ${stat.translated}，失败 ${stat.failed}）`)
    }
  })
  writeTranslations(cache)
  console.log(`[build-index] 描述中文化: 已中文 ${stat.alreadyChinese} / 缓存命中 ${stat.cached} / 新翻译 ${stat.translated} / 失败保持原文 ${stat.failed} -> ${TRANSLATIONS_PATH}`)
  return entries
}

/* ================= 中文分类（对齐客户端 CATEGORY_LABELS，兜底"自定义"） ================= */
const CATEGORY_RULES = [
  { label: '搜索', keys: ['search', 'brave', 'exa', 'tavily', 'bing', 'duckduckgo', 'google search', 'web search', 'internet search', 'youtube search'] },
  { label: '数据库', keys: ['database', 'sql', 'postgres', 'mysql', 'sqlite', 'mongodb', 'redis', 'neo4j', 'dynamodb', 'supabase', 'prisma', 'database', 'postgresql', 'db2', 'bigquery', 'clickhouse'] },
  { label: '浏览器自动化', keys: ['browser', 'playwright', 'puppeteer', 'chrome', 'firefox', 'webdriver', 'selenium'] },
  { label: '代码托管平台', keys: ['github', 'gitlab', 'bitbucket', 'gitee', 'git repository', 'pull request', 'code review', 'gitlab', 'git'] },
  { label: '项目管理', keys: ['jira', 'linear', 'trello', 'asana', 'project management', 'issue tracker', 'sprint', 'task management', 'todoist', 'shortcut', 'pivotal'] },
  { label: '通讯协作', keys: ['slack', 'teams', 'telegram', 'discord', 'gmail', 'outlook', 'email', 'mail', 'calendar', 'meeting', 'whatsapp', 'notification', 'communication', 'chat', 'messaging', 'signal', 'matrix', 'mattermost'] },
  { label: '文件系统', keys: ['file', 'filesystem', 'drive', 'dropbox', 'storage', 'folder', 'ftp', 's3', 'box'] },
  { label: '文档协作', keys: ['docs', 'confluence', 'notion', 'google docs', 'documentation', 'wiki', 'knowledge base', 'word', 'powerpoint', 'google drive', 'xlsx', 'docx'] },
  { label: '设计工具', keys: ['design', 'figma', 'image generation', 'image gen', 'icon', 'logo', 'ui', 'illustration', 'canva', 'svg'] },
  { label: '错误追踪', keys: ['sentry', 'bug', 'error tracking', 'crash', 'exception', 'monitoring', 'observability', 'logs', 'trace', 'apm', 'uptime'] },
  { label: '云平台部署', keys: ['aws', 'azure', 'gcp', 'cloud', 'kubernetes', 'k8s', 'docker', 'deploy', 'terraform', 'serverless', 'lambda', 'vercel', 'netlify', 'kubernetes'] },
  { label: '知识检索', keys: ['knowledge', 'rag', 'vector', 'memory', 'article', 'research', 'papers', 'semantic', 'embedding', 'knowledge graph', 'wiki', 'document search', 'arxiv', 'scholar'] },
  { label: '可视化', keys: ['chart', 'visualize', 'visualization', 'graph', 'dashboard', 'diagram', 'plot', 'canvas'] },
  { label: '智能增强', keys: ['ai', 'llm', 'model', 'agent', 'intelligence', 'ml', 'machine learning', 'deep learning', 'gpt', 'claude', 'openai', 'inference', 'genai', 'multimodal', 'assistant'] },
  { label: '开发工具', keys: ['dev', 'developer', 'sdk', 'api', 'code', 'programming', 'test', 'testing', 'ci', 'automation', 'workflow', 'integration', 'tool', 'terminal', 'shell', 'scraping', 'web scraping', 'rest', 'graphql', 'oauth', 'framework'] }
]

function classify(...texts) {
  const text = texts.filter((t) => typeof t === 'string').join(' ').toLowerCase()
  for (const rule of CATEGORY_RULES) {
    if (rule.keys.some((k) => text.includes(k))) return rule.label
  }
  return '自定义'
}

/* ================= 源 1：官方 MCP Registry ================= */
async function fetchOfficial() {
  const raw = []
  let cursor = null
  for (;;) {
    const q = new URLSearchParams({ limit: '100', version: 'latest' })
    if (cursor) q.set('cursor', cursor)
    const data = await httpJson(`${OFFICIAL_API}?${q}`)
    const items = data.servers ?? []
    for (const item of items) raw.push(item)
    cursor = data.metadata?.nextCursor
    if (!cursor || items.length === 0) break
    await sleep(150)
  }
  const dropped = { noInstall: 0, smitheryDup: 0, truncated: 0 }
  const entries = []
  for (const item of raw) {
    const entry = mapOfficial(item)
    if (entry === null) {
      dropped.noInstall++
      continue
    }
    entries.push(entry)
  }
  // Smithery 托管条目在官方注册表被重复收录（同 URL 键会把带 useCount 的 Smithery 条目顶掉），
  // 官方源剔除这些条目，流行度数据保留在 Smithery 源
  const nonSmithery = entries.filter((e) => !(typeof e.url === 'string' && e.url.includes('mcp.smithery.ai')))
  dropped.smitheryDup = entries.length - nonSmithery.length
  // 开放注册表无流行度指标，按 updatedAt 最新优先截取
  nonSmithery.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  const sliced = nonSmithery.slice(0, OFFICIAL_TOP_N)
  dropped.truncated = nonSmithery.length - sliced.length
  return { entries: sliced, raw: raw.length, dropped }
}

function mapOfficial(item) {
  const s = item.server ?? {}
  const meta = item._meta?.['io.modelcontextprotocol.registry/official']
  if (typeof s.name !== 'string' || !s.name) return null
  if (meta && typeof meta.status === 'string' && meta.status !== 'active') return null

  let pkg = null
  for (const p of s.packages ?? []) {
    if (typeof p.identifier !== 'string' || !p.identifier) continue
    if (p.registryType === 'npm') { pkg = { name: p.identifier, type: 'npm' }; break }
    if (p.registryType === 'pypi') { pkg = { name: p.identifier, type: 'pypi' }; break }
    if (p.registryType === 'oci') { pkg = { name: p.identifier, type: 'docker' }; break }
  }
  const remote = (s.remotes ?? []).find((r) => r.type === 'streamable-http' || r.type === 'sse')
  if (!pkg && !remote) return null

  const entry = {
    id: `registry:${s.name}`,
    name: typeof s.title === 'string' && s.title ? s.title : s.name,
    description: typeof s.description === 'string' ? s.description : '',
    category: classify(s.title, s.name, s.description),
    source: 'registry',
    verified: true
  }
  const ts = toEpoch(meta?.updatedAt)
  if (ts) entry.updatedAt = ts
  if (typeof s.version === 'string') entry.version = s.version
  if (typeof s.repository?.url === 'string') entry.registryUrl = s.repository.url
  if (pkg) {
    entry.packageName = pkg.name
    entry.packageType = pkg.type
  } else if (remote && typeof remote.url === 'string') {
    entry.url = remote.url
  } else {
    return null
  }
  return entry
}

/* ================= 源 2：Smithery（分页漂移 bug：page>10 后大量重复，
 * offset/limit/sort 参数均无效，实际唯一条目约 123 条，全量抓取后去重） ================= */
async function fetchSmithery() {
  const seen = new Set()
  const raw = []
  for (let page = 1; page <= SMITHERY_PAGES; page++) {
    const data = await httpJson(`${SMITHERY_API}?page=${page}`)
    const items = data.servers ?? []
    for (const s of items) {
      if (typeof s.qualifiedName !== 'string' || !s.qualifiedName) continue
      if (seen.has(s.qualifiedName)) continue
      seen.add(s.qualifiedName)
      raw.push(s)
    }
    const total = typeof data.pagination?.totalPages === 'number' ? data.pagination.totalPages : Infinity
    if (items.length === 0 || page >= total) break
    await sleep(120)
  }
  let dropped = 0
  const entries = []
  for (const s of raw) {
    if (s.unlisted || s.inactive) {
      dropped++
      continue
    }
    const ts = toEpoch(s.updatedAt ?? s.createdAt)
    const entry = {
      id: `smithery:${s.qualifiedName}`,
      name: typeof s.displayName === 'string' && s.displayName ? s.displayName : s.qualifiedName,
      description: typeof s.description === 'string' ? s.description : '',
      category: classify(s.displayName, s.qualifiedName, s.description),
      source: 'smithery',
      url: `https://mcp.smithery.ai/${s.qualifiedName}`,
      verified: s.verified === true
    }
    if (typeof s.useCount === 'number' && Number.isFinite(s.useCount)) entry.useCount = s.useCount
    if (ts) entry.updatedAt = ts
    entries.push(entry)
  }
  return { entries, raw: raw.length, total: seen.size, dropped }
}

/* ================= 源 3：GitHub（top 300 + README 解析） ================= */
async function fetchGitHub() {
  const token = process.env.GITHUB_TOKEN
  const headers = token ? { Authorization: `Bearer ${token}` } : {}
  const repos = []
  const pages = Math.ceil(GITHUB_TOP_N / 100)
  try {
    for (let page = 1; page <= pages; page++) {
      const q = new URLSearchParams({ q: 'topic:mcp-server', sort: 'stars', order: 'desc', per_page: '100', page: String(page) })
      const data = await httpJsonRate(`${GITHUB_SEARCH}?${q}`, { headers })
      const items = data.items ?? []
      for (const r of items) repos.push(r)
      if (items.length < 100) break
      if (page < pages) await sleep(token ? 2500 : 7000) // 限流：30/min 与 10/min
    }
  } catch (err) {
    console.warn(`[build-index] GitHub 源降级（跳过，其余源继续）: ${err.message}`)
    return { entries: [], raw: repos.length, dropped: { noDesc: 0, noReadme: 0, noInstall: 0, verifyFail: 0 } }
  }
  const top = repos.slice(0, GITHUB_TOP_N)

  const stat = { noDesc: 0, noReadme: 0, noInstall: 0, verifyFail: 0 }
  const results = await mapLimit(top, 6, async (repo) => {
    if (repo.archived === true || typeof repo.description !== 'string' || !repo.description) {
      stat.noDesc++
      return null
    }
    const text = await fetchReadme(repo.full_name)
    if (!text) {
      stat.noReadme++
      return null
    }
    const pkg = extractInstall(text)
    if (!pkg) {
      stat.noInstall++
      return null
    }
    if (!(await verifyPackage(pkg))) {
      stat.verifyFail++
      return null
    }
    return {
      id: `github:${repo.full_name}`,
      name: repo.name,
      description: repo.description,
      category: classify(repo.name, repo.description),
      source: 'github',
      packageName: pkg.packageName,
      packageType: pkg.packageType,
      registryUrl: repo.html_url
    }
  })
  const entries = results.filter(Boolean)
  return { entries, raw: top.length, dropped: stat }
}

async function fetchReadme(fullName) {
  for (const name of ['README.md', 'readme.md', 'README.markdown', 'Readme.md']) {
    const text = await httpText(`${GITHUB_RAW}/${fullName}/HEAD/${name}`)
    if (text !== null) return text
  }
  return null
}

function stripVersion(name) {
  const at = name.lastIndexOf('@')
  return at > 0 ? name.slice(0, at) : name
}

/** 提取安装形态：npx(--package=/pkg) > uvx > docker run；均失败返回 null */
function extractInstall(readme) {
  const npm = findNpm(readme)
  if (npm) return { packageName: npm, packageType: 'npm' }
  const pypi = findPypi(readme)
  if (pypi) return { packageName: pypi, packageType: 'pypi' }
  const docker = findDocker(readme)
  if (docker) return { packageName: docker, packageType: 'docker' }
  return null
}

function findNpm(text) {
  const direct = text.match(/--package=([@\w.-]+(?:\/[\w.-]+)?)/)
  if (direct) return stripVersion(direct[1])
  const withFlag = text.match(/\bnpx(?:\.cmd)?\b[ \t]+(?:-y|--yes)[ \t]+(@?[\w.-]+(?:\/[\w.-]+)?)/)
  if (withFlag) return stripVersion(withFlag[1])
  const plain = text.match(/\bnpx(?:\.cmd)?\b[ \t]+(@?[\w.-]+(?:\/[\w.-]+)?)/)
  if (plain) return stripVersion(plain[1])
  return null
}

function findPypi(text) {
  const m = text.match(/\buvx(?:\.exe)?\b[ \t]+(?:--from[ \t]+)?([\w.-]+)/)
  return m ? stripVersion(m[1]) : null
}

function findDocker(text) {
  const i = text.search(/\bdocker\s+run\b/i)
  if (i < 0) return null
  const seg = text.slice(i + 10, i + 300)
  for (const tok of seg.split(/\s+/)) {
    if (!tok || tok.startsWith('-')) continue
    if (tok.includes('=')) continue
    if (DOCKER_IMAGE_RE.test(tok)) return tok
  }
  return null
}

async function verifyPackage(pkg) {
  if (pkg.packageType === 'npm') {
    if (!PACKAGE_NAME_RE.test(pkg.packageName)) return false
    try {
      const res = await fetch(`${NPM_REGISTRY}/${encodeURI(pkg.packageName)}`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(10_000)
      })
      return res.ok
    } catch {
      return false
    }
  }
  if (pkg.packageType === 'pypi') {
    try {
      const res = await fetch(`${PYPI_REGISTRY}/${encodeURI(pkg.packageName)}/json`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(10_000)
      })
      return res.ok
    } catch {
      return false
    }
  }
  return true
}

/* ================= 合并：存量优先 + 官方回填 + 三源去重 ================= */
/**
 * 索引生成（每次全量覆盖 index.json）：
 *   手动精选（scripts/manual.json，中文描述/icon 优先） > 官方 > Smithery > GitHub。
 * 官方与手动精选同键冲突时回填 updatedAt/version/registryUrl（保留 icon 与中文描述）。
 */

function readExisting() {
  try {
    const raw = JSON.parse(readFileSync(MANUAL_PATH, 'utf8'))
    if (Array.isArray(raw)) return raw
  } catch {
    /* manual.json 缺失 */
  }
  return []
}

function mergeAll(sources, existing) {
  const keep = new Map()
  for (const e of existing) keep.set(dedupeKey(e), e)

  for (const e of sources.official) {
    const key = dedupeKey(e)
    const prev = keep.get(key)
    if (prev) {
      if (e.updatedAt && (prev.updatedAt == null || e.updatedAt > prev.updatedAt)) prev.updatedAt = e.updatedAt
      if (e.version && !prev.version) prev.version = e.version
      if (e.registryUrl && !prev.registryUrl) prev.registryUrl = e.registryUrl
      continue
    }
    keep.set(key, e)
  }
  for (const e of sources.smithery) {
    const key = dedupeKey(e)
    if (!keep.has(key)) keep.set(key, e)
  }
  for (const e of sources.github) {
    const key = dedupeKey(e)
    if (!keep.has(key)) keep.set(key, e)
  }
  return [...keep.values()]
}

/* ================= 主流程 ================= */
async function main() {
  const started = Date.now()
  const existing = readExisting()

  const [official, smithery, github] = await Promise.all([
    fetchOfficial(),
    fetchSmithery(),
    fetchGitHub()
  ])

  const merged = mergeAll({ official: official.entries, smithery: smithery.entries, github: github.entries }, existing)
  const valid = merged.filter(isValidEntry)
  const dropped = merged.length - valid.length

  await localizeDescriptions(valid)
  writeFileSync(INDEX_PATH, JSON.stringify({ entries: valid }, null, 2) + '\n')

  console.log('[build-index] ===== 构建统计 =====')
  console.log(`[build-index] 手动精选（保留优先）: ${existing.length} 条`)
  console.log(`[build-index] 官方 Registry: ${official.entries.length}/${official.raw} 条（无安装形态 ${official.dropped.noInstall} / Smithery 重复 ${official.dropped.smitheryDup} / 截断 ${official.dropped.truncated}）`)
  console.log(`[build-index] Smithery: ${smithery.entries.length}/${smithery.total} 条唯一（页面翻取 ${smithery.raw} 条，过滤 ${smithery.dropped}）`)
  console.log(`[build-index] GitHub top300: ${github.entries.length}/${github.raw} 条（无描述 ${github.dropped.noDesc} / 无 README ${github.dropped.noReadme} / 无安装形态 ${github.dropped.noInstall} / 包校验失败 ${github.dropped.verifyFail}）`)
  console.log(`[build-index] 合并去重后: ${merged.length} 条，自校验剔除 ${dropped} 条`)
  console.log(`[build-index] 最终: ${valid.length} 条 -> ${INDEX_PATH}（耗时 ${((Date.now() - started) / 1000).toFixed(1)}s）`)
}

main().catch((err) => {
  console.error(`[build-index] 失败: ${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
})
