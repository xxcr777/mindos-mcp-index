/**
 * 合并：手动精选（存量）优先保留 > 官方 Registry（同键回填）> Smithery > GitHub。
 * 与旧实现行为一致（保序、回填 updatedAt/version/registryUrl）。
 */
import { readFileSync } from 'node:fs'
import { dedupeKey } from './client-rules.mjs'

/** 读取手动精选条目（scripts/manual.json；缺失/损坏返回空数组） */
export function readManual(manualPath) {
  try {
    const raw = JSON.parse(readFileSync(manualPath, 'utf8'))
    if (Array.isArray(raw)) return raw
  } catch {
    /* manual.json 缺失 */
  }
  return []
}

export function mergeAll(sources, existing) {
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
