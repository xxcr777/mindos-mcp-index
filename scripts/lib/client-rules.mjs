/**
 * 客户端规则复刻（与 electron/codex/market-index.ts 的 isValidEntry/去重键保持一致）。
 * 索引构建产物必须通过此校验，否则客户端会静默丢弃条目。
 */

export const PACKAGE_NAME_RE = /^@?[\w.-]+(?:\/[\w.-]+)?$/
export const DOCKER_IMAGE_RE = /^[\w./:@-]+$/
export const URL_RE = /^https?:\/\/.+/i
export const PACKAGE_TYPES = new Set(['npm', 'pypi', 'docker', 'none'])
export const INDEX_SOURCES = new Set(['registry', 'smithery', 'github'])

export function isValidEntry(entry) {
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

/** 去重键：包名优先，其次 url（远程托管），最后 id */
export function dedupeKey(entry) {
  if (typeof entry.packageName === 'string') return `pkg:${entry.packageName}`
  if (typeof entry.url === 'string') return `url:${entry.url}`
  return `id:${entry.id}`
}
