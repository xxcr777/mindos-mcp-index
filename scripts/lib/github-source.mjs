/**
 * 源 3：GitHub 热门 MCP 仓库（扩容版）。
 *
 * 候选池（双通道，突破 Search API 单查询 1000 条上限）：
 *   1) 搜索矩阵：多个 topic / 关键词查询，服务端 stars:>N 过滤 + stars 排序，翻页合并去重；
 *   2) Awesome 列表：解析主流 awesome-mcp-servers README 中的仓库链接，
 *      不在搜索结果的用 GraphQL 批量补元数据（每批 50 仓库）。
 * 过滤：stars > 100（硬门槛）、非 archived、描述非空、排除列表/聚合仓库。
 * 产出：按 stars 排序取前 1000 条；条目写 stars/useCount（客户端排序复用 useCount）。
 *
 * 增量缓存（scripts/github-cache.json，随构建提交）：
 *   - parsed[owner/repo]：pushedAt 未变 → 跳过 README 拉取 + 解析 + 包校验；
 *     解析失败条目 3 天退避重试；
 *   - awesome：列表链接缓存 7 天；
 *   - seen：候选出现时间，14 天未再出现的缓存条目自动淘汰。
 * 更新检测：updatedAt = npm/pypi 包最后发布时间（复用包校验响应，非 pushed_at，避免误报）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { PACKAGE_NAME_RE } from './client-rules.mjs'
import { httpJson, httpJsonRate, httpText, mapLimit, sleep, toEpoch, USER_AGENT } from './http.mjs'
import { classify } from './classify.mjs'
import { extractInstall } from './install-extract.mjs'

export const GITHUB_STARS_MIN = 100
export const GITHUB_MAX_ENTRIES = 1000
export const GITHUB_CANDIDATE_LIMIT = 3500
export const GITHUB_PAGES_PER_QUERY = 8
export const GITHUB_CONCURRENCY = 12
/** GraphQL aliases 每批数量（查询体积/计费点平衡） */
export const GRAPHQL_BATCH_SIZE = 100

/**
 * 搜索矩阵（高精度谓词）：
 * - topic:mcp-server / mcp-servers / model-context-protocol 为 MCP server 项目专用 topic；
 * - mcp in:name / "mcp server" in:name 捕获命名含 MCP 的仓库。
 * 刻意不使用 topic:mcp、description 关键词等宽谓词——n8n/open-webui/gemini-cli 这类大工具会在
 * topics/描述里带 mcp 蹭高星前排，宽查询会淹没有效候选（历史教训）。
 */
export const GITHUB_SEARCH_QUERIES = [
  'topic:mcp-server',
  'topic:mcp-servers',
  'topic:model-context-protocol',
  'topic:anthropic-mcp',
  'topic:claude-mcp',
  'mcp in:name',
  '"mcp server" in:name'
]

export const AWESOME_LISTS = [
  'punkpeye/awesome-mcp-servers',
  'wong2/awesome-mcp-servers',
  'appcypher/awesome-mcp-servers',
  'yzfly/Awesome-MCP-ZH'
]

const GITHUB_SEARCH = 'https://api.github.com/search/repositories'
const GITHUB_GRAPHQL = 'https://api.github.com/graphql'
const GITHUB_RAW = 'https://raw.githubusercontent.com'
const NPM_REGISTRY = 'https://registry.npmjs.org'
const PYPI_REGISTRY = 'https://pypi.org/pypi'

const AWESOME_TTL_MS = 7 * 24 * 3600 * 1000
export const REPARSE_FAIL_BACKOFF_MS = 3 * 24 * 3600 * 1000
export const CACHE_IDLE_MS = 14 * 24 * 3600 * 1000

/** GitHub 保留路径段（README 链接解析时排除） */
const RESERVED_GITHUB_SEGMENTS = new Set([
  'topics', 'search', 'orgs', 'apps', 'marketplace', 'sponsors', 'login',
  'features', 'about', 'settings', 'site', 'explore', 'collections',
  'trending', 'new', 'notifications', 'pricing', 'enterprise', 'security'
])

/* ================= 缓存（可测纯函数 + IO 包装） ================= */

export function emptyGitHubCache() {
  return { version: 1, parsed: {}, awesome: null, seen: {} }
}

export function readGitHubCache(cachePath) {
  try {
    const raw = JSON.parse(readFileSync(cachePath, 'utf8'))
    if (raw && typeof raw === 'object' && raw.parsed && typeof raw.parsed === 'object') {
      return {
        version: 1,
        parsed: raw.parsed,
        awesome: raw.awesome && typeof raw.awesome === 'object' ? raw.awesome : null,
        seen: raw.seen && typeof raw.seen === 'object' ? raw.seen : {}
      }
    }
  } catch {
    /* 首次构建无缓存 */
  }
  return emptyGitHubCache()
}

export function writeGitHubCache(cachePath, cache) {
  writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n')
}

/**
 * 是否需要重新解析：pushedAt 变化（含新仓库）→ 是；
 * 缓存命中且上次解析成功 → 否；上次失败在退避期（3 天）内 → 否。
 */
export function shouldReparse(cached, pushedAt, now = Date.now()) {
  if (!cached) return true
  if (cached.pushedAt !== pushedAt) return true
  if (cached.entry) return false
  if (typeof cached.lastTryAt === 'number' && now - cached.lastTryAt < REPARSE_FAIL_BACKOFF_MS) return false
  return true
}

/** 淘汰：更新 seen；14 天未出现在候选池的缓存条目删除 */
export function pruneCache(cache, activeFullNames, now = Date.now()) {
  const active = new Set(activeFullNames)
  cache.seen = cache.seen ?? {}
  for (const full of active) cache.seen[full] = now
  for (const full of Object.keys(cache.parsed ?? {})) {
    if (active.has(full)) continue
    const lastSeen = cache.seen[full] ?? 0
    if (now - lastSeen > CACHE_IDLE_MS) {
      delete cache.parsed[full]
      delete cache.seen[full]
    }
  }
  return cache
}

/* ================= 纯函数（候选/解析/组装） ================= */

/** README → GitHub 仓库全名列表（owner/repo） */
export function extractRepoLinks(readme) {
  const out = new Set()
  if (typeof readme !== 'string' || !readme) return []
  const re = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?=[\s)"'\]/?#]|$)/g
  for (const m of readme.matchAll(re)) {
    const owner = m[1]
    const name = m[2]
    if (!owner || !name) continue
    if (RESERVED_GITHUB_SEGMENTS.has(owner.toLowerCase())) continue
    if (RESERVED_GITHUB_SEGMENTS.has(name.toLowerCase())) continue
    out.add(`${owner}/${name}`)
  }
  return [...out]
}

/** 列表/聚合类仓库（README 里往往堆满 npx 命令，会污染解析） */
export function isListLikeRepo(repo) {
  const name = String(repo?.name ?? '').toLowerCase()
  if (name.includes('awesome')) return true
  const topics = Array.isArray(repo?.topics) ? repo.topics : []
  return topics.some((t) => {
    const s = String(t).toLowerCase()
    return s === 'awesome' || s === 'awesome-list' || s === 'mcp-server-list' || s === 'mcp-list'
  })
}

/** MCP 词匹配（独立词 mcp 或 @modelcontextprotocol 官方 scope） */
const MCP_WORD_RE = /(?<![\w])mcp(?![\w])|modelcontextprotocol/i

/** 本地/内网 url（用户本机部署的端点，不可作为市场分发的远程 MCP 服务） */
export function isLocalUrl(url) {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|192\.168\.|10\.\d{1,3}\.|172\.(1[6-9]|2\d|3[01])\./i.test(url)
}

/** 仓库/包名中的 MCP 词（分隔符含 - _ .；与文本词边界 MCP_WORD_RE 不同） */
const MCP_NAME_RE = /(?:^|[^a-z0-9])mcp(?:[^a-z0-9]|$)|modelcontextprotocol/i

/**
 * 仓库名含 mcp 时的同名包候选（下划线转连字符变体）。
 * README 无安装段的 MCP server 常见「包名 = 仓库名」（如 mcp-server-fetch），
 * 通过 npm/pypi 同名包存在性探测兜底收录。
 */
export function derivePackageNameCandidates(repoName) {
  if (typeof repoName !== 'string') return []
  const base = repoName.toLowerCase().trim()
  if (!MCP_NAME_RE.test(base)) return []
  const out = [base]
  const dashed = base.replace(/_/g, '-')
  if (dashed !== base) out.push(dashed)
  return [...new Set(out)]
}

/**
 * MCP 安装目标判定（v3 精准版，唯一依据是「安装目标本身是 MCP」）：
 * - docker：镜像名含 mcp 词（如 ghcr.io/github/github-mcp-server）；
 * - npm/pypi：包名含 mcp 词/@modelcontextprotocol，或包 keywords 标记 mcp（meta.keywordsMcp）；
 * - url：远程端点含 mcp 词且非本地/内网地址。
 * 刻意不使用仓库 topics/描述——n8n/open-webui/gemini-cli 等大工具会在这些字段蹭 mcp 蹭高星前排；
 * topics 只用于候选排序，不用于收录裁决。
 */
export function isMcpInstallTarget(install, meta) {
  if (!install) return false
  if (install.packageType === 'docker') {
    return typeof install.packageName === 'string' && MCP_WORD_RE.test(install.packageName)
  }
  if (install.packageType === 'npm' || install.packageType === 'pypi') {
    if (typeof install.packageName === 'string' && MCP_WORD_RE.test(install.packageName)) return true
    return meta?.keywordsMcp === true
  }
  if (typeof install.url === 'string') {
    if (isLocalUrl(install.url)) return false
    return MCP_WORD_RE.test(install.url)
  }
  return false
}

/** 候选过滤 + stars 排序 + 截取 */
export function pickCandidates(repoMap, { starsMin = GITHUB_STARS_MIN, limit = GITHUB_CANDIDATE_LIMIT } = {}) {
  const list = [...repoMap.values()].filter((r) => {
    if (!r || typeof r.full_name !== 'string' || !r.full_name.includes('/')) return false
    if (r.archived === true) return false
    if (typeof r.description !== 'string' || !r.description.trim()) return false
    if ((r.stargazers_count ?? 0) < starsMin) return false
    if (isListLikeRepo(r)) return false
    return true
  })
  list.sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0))
  return list.slice(0, limit)
}

/** 组装 GitHub 条目（stars → useCount 供客户端排序；updatedAt = 包发布时间） */
export function buildGitHubEntry(repo, install, publishedAt) {
  const entry = {
    id: `github:${repo.full_name}`,
    name: repo.name ?? repo.full_name,
    description: repo.description ?? '',
    category: classify(repo.name, repo.description, (repo.topics ?? []).join(' ')),
    source: 'github',
    registryUrl: repo.html_url
  }
  if (typeof repo.stargazers_count === 'number') {
    entry.stars = repo.stargazers_count
    entry.useCount = repo.stargazers_count
  }
  if (install && typeof install.url === 'string') {
    entry.url = install.url
  } else if (install && typeof install.packageName === 'string') {
    entry.packageName = install.packageName
    entry.packageType = install.packageType
    if (publishedAt) entry.updatedAt = publishedAt
  }
  return entry
}

/* ================= 网络 ================= */

async function searchRepos(query, { token, maxPages }) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {}
  const repos = []
  for (let page = 1; page <= maxPages; page++) {
    const q = new URLSearchParams({ q: query, sort: 'stars', order: 'desc', per_page: '100', page: String(page) })
    const data = await httpJsonRate(`${GITHUB_SEARCH}?${q}`, { headers })
    const items = data.items ?? []
    for (const r of items) repos.push(r)
    if (items.length < 100) break
    if (page < maxPages) await sleep(token ? 2500 : 7000) // 限流：30/min 与 10/min
  }
  return repos
}

function mapGhNode(node) {
  return {
    full_name: node.nameWithOwner,
    name: node.nameWithOwner.split('/')[1] ?? node.nameWithOwner,
    stargazers_count: typeof node.stargazerCount === 'number' ? node.stargazerCount : 0,
    description: typeof node.description === 'string' ? node.description : '',
    topics: (node.repositoryTopics?.nodes ?? []).map((n) => n?.topic?.name).filter(Boolean),
    archived: node.isArchived === true,
    pushed_at: typeof node.pushedAt === 'string' ? node.pushedAt : undefined,
    html_url: node.url
  }
}

/** GraphQL aliases 批量仓库元数据（每批 GRAPHQL_BATCH_SIZE；无 token 直接跳过） */
export async function fetchRepoMetaBatch(fullNames, { token, log = console.log } = {}) {
  const out = new Map()
  if (!token || fullNames.length === 0) return out
  const chunks = []
  for (let i = 0; i < fullNames.length; i += GRAPHQL_BATCH_SIZE) chunks.push(fullNames.slice(i, i + GRAPHQL_BATCH_SIZE))
  for (const [ci, chunk] of chunks.entries()) {
    const aliases = chunk
      .map((full, j) => {
        const slash = full.indexOf('/')
        const owner = full.slice(0, slash)
        const name = full.slice(slash + 1)
        return `r${j}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){nameWithOwner stargazerCount description repositoryTopics(first:20){nodes{topic{name}}} isArchived pushedAt url}`
      })
      .join(' ')
    try {
      const data = await httpJson(GITHUB_GRAPHQL, {
        method: 'POST',
        bodyText: JSON.stringify({ query: `query{${aliases}}` }),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        retries: 1
      })
      for (const node of Object.values(data?.data ?? {})) {
        if (node && typeof node.nameWithOwner === 'string') out.set(node.nameWithOwner, mapGhNode(node))
      }
    } catch (err) {
      log(`[build-index] GitHub GraphQL 批量失败（${chunk.length} 仓库跳过）: ${err.message}`)
    }
    if (ci < chunks.length - 1) await sleep(1200) // GraphQL ≤1 req/s 建议
  }
  return out
}

export async function fetchReadme(fullName) {
  for (const name of ['README.md', 'readme.md', 'README.markdown', 'Readme.md']) {
    const text = await httpText(`${GITHUB_RAW}/${fullName}/HEAD/${name}`)
    if (text !== null) return text
  }
  return null
}

/** raw 通道连通性探测：不可达（代理/网络问题）时跳过解析阶段，避免上千次重试与缓存污染 */
async function probeRaw(log) {
  try {
    const text = await httpText(`${GITHUB_RAW}/punkpeye/awesome-mcp-servers/HEAD/README.md`, { retries: 0 })
    return text !== null
  } catch (err) {
    log(`[build-index] raw.githubusercontent.com 探测失败: ${err.message}`)
    return false
  }
}

/** 包存在性校验 + 最后发布时间（npm time.modified / PyPI latest 文件时间） */
export async function verifyPackage(pkg) {
  if (pkg.packageType === 'npm') {
    if (!PACKAGE_NAME_RE.test(pkg.packageName)) return { ok: false }
    try {
      const res = await fetch(`${NPM_REGISTRY}/${encodeURI(pkg.packageName)}`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(10_000)
      })
      if (!res.ok) return { ok: false }
      let publishedAt
      let keywordsMcp = false
      try {
        const data = await res.json()
        publishedAt = toEpoch(data?.time?.modified)
        const keywords = Array.isArray(data?.keywords) ? data.keywords : []
        keywordsMcp = keywords.some((k) => MCP_WORD_RE.test(String(k)))
      } catch {
        /* 元数据拿不到不影响存在性 */
      }
      return { ok: true, publishedAt, keywordsMcp }
    } catch {
      return { ok: false }
    }
  }
  if (pkg.packageType === 'pypi') {
    try {
      const res = await fetch(`${PYPI_REGISTRY}/${encodeURI(pkg.packageName)}/json`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(10_000)
      })
      if (!res.ok) return { ok: false }
      let publishedAt
      let keywordsMcp = false
      try {
        const data = await res.json()
        const files = Array.isArray(data?.urls) ? data.urls : []
        publishedAt = toEpoch(files[0]?.upload_time_iso_8601)
        const kw = typeof data?.info?.keywords === 'string' ? data.info.keywords : ''
        keywordsMcp = kw.split(/[,;\s]+/).some((k) => MCP_WORD_RE.test(k))
      } catch {
        /* 同上 */
      }
      return { ok: true, publishedAt, keywordsMcp }
    } catch {
      return { ok: false }
    }
  }
  return { ok: true } // docker 不校验（无限流源可用）
}

/** 仓库名同名包探测：npm 优先，pypi 兜底（仅仓库名含 mcp 时尝试，避免抓到无关同名包） */
async function guessInstallFromRepoName(repo) {
  for (const name of derivePackageNameCandidates(repo?.name)) {
    const npm = await verifyPackage({ packageName: name, packageType: 'npm' })
    if (npm.ok) return { install: { packageName: name, packageType: 'npm' }, verify: npm }
    const pypi = await verifyPackage({ packageName: name, packageType: 'pypi' })
    if (pypi.ok) return { install: { packageName: name, packageType: 'pypi' }, verify: pypi }
  }
  return null
}

/* ================= 编排 ================= */

async function fetchAwesomeLinks({ cache, log, now, token }) {
  if (cache.awesome && now - (cache.awesome.fetchedAt ?? 0) < AWESOME_TTL_MS && Array.isArray(cache.awesome.links)) {
    return cache.awesome.links
  }
  // 列表集合 = 白名单 + 自动发现（名字含 awesome-mcp 的仓库；失败不阻断）
  const lists = new Set(AWESOME_LISTS)
  try {
    const discovered = await searchRepos('awesome-mcp in:name stars:>50', { token, maxPages: 2 })
    for (const r of discovered) {
      if (typeof r?.full_name === 'string') lists.add(r.full_name)
    }
  } catch (err) {
    log(`[build-index] awesome 列表自动发现失败（跳过）: ${err.message}`)
  }
  const links = new Set()
  for (const repo of lists) {
    const text = await fetchReadme(repo)
    if (text === null) continue // 不存在/不可读：静默跳过（列表可能是话题仓库而非真列表）
    for (const link of extractRepoLinks(text)) links.add(link)
    await sleep(300)
  }
  if (links.size > 0) {
    cache.awesome = { fetchedAt: now, links: [...links] }
  }
  return cache.awesome?.links ?? []
}

/**
 * 构建 GitHub 源。cache 会被原地更新（含 seen/parsed/awesome）；
 * 调用方在非 dry-run 时负责 writeGitHubCache。
 */
export async function fetchGitHub({ token, cache, log = console.log, limit, now = Date.now() } = {}) {
  const stat = {
    searched: 0,
    awesomeLinked: 0,
    awesomeMeta: 0,
    eligible: 0,
    candidates: 0,
    cacheHit: 0,
    parsed: 0,
    guessed: 0,
    fetchError: 0,
    noReadme: 0,
    noInstall: 0,
    notMcp: 0,
    verifyFail: 0
  }

  // 1) 搜索矩阵（任一查询失败不拖垮整体）
  const repoMap = new Map()
  for (const query of GITHUB_SEARCH_QUERIES) {
    try {
      const found = await searchRepos(`${query} stars:>${GITHUB_STARS_MIN}`, { token, maxPages: GITHUB_PAGES_PER_QUERY })
      for (const r of found) {
        if (r && typeof r.full_name === 'string' && !repoMap.has(r.full_name)) repoMap.set(r.full_name, r)
      }
    } catch (err) {
      log(`[build-index] GitHub 查询失败（跳过）: ${query} — ${err.message}`)
    }
  }
  stat.searched = repoMap.size

  // 2) awesome 列表补充（缓存 7 天；不在搜索结果的用 GraphQL 批量补元数据）
  try {
    const links = await fetchAwesomeLinks({ cache, log, now, token })
    stat.awesomeLinked = links.length
    const missing = links.filter((f) => !repoMap.has(f))
    if (missing.length > 0) {
      const metas = await fetchRepoMetaBatch(missing, { token, log })
      for (const [full, meta] of metas) repoMap.set(full, meta)
      stat.awesomeMeta = metas.size
    }
  } catch (err) {
    log(`[build-index] awesome 列表补充失败（跳过）: ${err.message}`)
  }

  // 3) 过滤 + stars 排序 + 候选截取
  const candidateLimit = limit ?? GITHUB_CANDIDATE_LIMIT
  const allEligible = pickCandidates(repoMap, { starsMin: GITHUB_STARS_MIN, limit: Number.MAX_SAFE_INTEGER })
  stat.eligible = allEligible.length
  const candidates = allEligible.slice(0, candidateLimit)
  stat.candidates = candidates.length

  // 3.5) raw 通道探测：不可达则跳过解析（不写缓存，避免把网络故障固化为失败退避；CI 环境默认可达）
  if (candidates.length > 0 && !(await probeRaw(log))) {
    log(
      '[build-index] raw.githubusercontent.com 不可达：本次跳过 GitHub README 解析（候选元数据已获取；本地解析请配置代理 HTTPS_PROXY + NODE_USE_ENV_PROXY=1）'
    )
    stat.fetchError = candidates.length
    return { entries: [], raw: candidates.length, dropped: stat }
  }

  // 4) 解析（增量缓存：pushedAt 未变直接复用）
  const entries = []
  let doneCount = 0
  await mapLimit(candidates, GITHUB_CONCURRENCY, async (repo) => {
    try {
      const cached = cache.parsed[repo.full_name]
      if (!shouldReparse(cached, repo.pushed_at, now)) {
        stat.cacheHit++
        if (cached.entry) entries.push(cached.entry)
        return
      }
      let text = null
      try {
        text = await fetchReadme(repo.full_name)
      } catch {
        stat.fetchError++
        return // 网络异常：不写缓存（失败退避只针对“确认解析失败”，网络问题下次构建重试）
      }
      let install = text === null ? null : extractInstall(text)
      let verify = null
      if (install) {
        verify = await verifyPackage(install)
        if (!verify.ok) {
          stat.verifyFail++
          cache.parsed[repo.full_name] = { pushedAt: repo.pushed_at, entry: null, lastTryAt: now }
          return
        }
        // MCP 安装目标判定（v3）：包名/镜像/远程 url 或包 keywords 必须证明“目标本身是 MCP”
        if (!isMcpInstallTarget(install, verify)) {
          stat.notMcp++
          cache.parsed[repo.full_name] = { pushedAt: repo.pushed_at, entry: null, lastTryAt: now }
          return
        }
      } else {
        // README 缺失/无安装段：按仓库名同名包探测兜底（包名含 mcp，天然通过判定）
        const found = await guessInstallFromRepoName(repo)
        if (!found) {
          if (text === null) stat.noReadme++
          else stat.noInstall++
          cache.parsed[repo.full_name] = { pushedAt: repo.pushed_at, entry: null, lastTryAt: now }
          return
        }
        install = found.install
        verify = found.verify
        stat.guessed++
      }
      const entry = buildGitHubEntry(repo, install, verify.publishedAt)
      stat.parsed++
      cache.parsed[repo.full_name] = { pushedAt: repo.pushed_at, entry, lastTryAt: now }
      entries.push(entry)
    } finally {
      doneCount++
      if (doneCount % 100 === 0) {
        log(
          `[build-index] GitHub 解析进度: ${doneCount}/${candidates.length}（产出 ${entries.length}，缓存命中 ${stat.cacheHit}，网络失败 ${stat.fetchError}）`
        )
      }
    }
  })

  // 5) 淘汰 + 产出按 stars 排序截取（前 1000）
  pruneCache(cache, candidates.map((r) => r.full_name), now)
  entries.sort((a, b) => (b.useCount ?? 0) - (a.useCount ?? 0))
  const entryLimit = limit ?? GITHUB_MAX_ENTRIES

  return { entries: entries.slice(0, entryLimit), raw: candidates.length, dropped: stat }
}
