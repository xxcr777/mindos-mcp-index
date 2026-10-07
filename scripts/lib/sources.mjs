/** 源 1+2：官方 MCP Registry 与 Smithery（行为与旧实现一致，仅迁移）。 */
import { httpJson, sleep, toEpoch } from './http.mjs'
import { classify } from './classify.mjs'

const OFFICIAL_API = 'https://registry.modelcontextprotocol.io/v0.1/servers'
const SMITHERY_API = 'https://registry.smithery.ai/servers'

const SMITHERY_PAGES = 50 // 服务端固定 10/页、封顶 500 条
const OFFICIAL_TOP_N = 1500 // 开放注册表无流行度指标，按 updatedAt 最新优先截取

/* ================= 源 1：官方 MCP Registry ================= */
export async function fetchOfficial() {
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

export function mapOfficial(item) {
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

/* ================= 源 2：Smithery =================
 * 分页漂移 bug：page>10 后大量重复，offset/limit/sort 参数均无效，
 * 实际唯一条目约 123 条，全量抓取后按 qualifiedName 去重 */
export async function fetchSmithery() {
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
