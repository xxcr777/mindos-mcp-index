/**
 * 描述中文化：免费 Google 翻译接口 + translations.json 增量缓存（可人工修订）。
 * 已中文描述原样；未命中缓存调用接口翻译并写回缓存；失败保持原文（客户端回退英文展示）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { USER_AGENT, TIMEOUT_MS, sleep, mapLimit } from './http.mjs'

const GOOGLE_TL = 'https://translate.googleapis.com/translate_a/single'
const HAN_RE = /[\u3400-\u9fff]/
const TRANSLATE_CONCURRENCY = 3
const TRANSLATE_INTERVAL_MS = 150
/** 熔断阈值：连续失败 N 次后本轮放弃翻译（避免对不可用接口无效重试数十分钟） */
export const TRANSLATE_FAIL_BREAKER = 8

export function hasChinese(text) {
  return typeof text === 'string' && HAN_RE.test(text)
}

export function readTranslations(path) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  } catch {
    /* 首次运行无缓存 */
  }
  return {}
}

export function writeTranslations(path, cache) {
  writeFileSync(path, JSON.stringify(cache, null, 2) + '\n')
}

/** 免费 Google 翻译（client=gtx 无需 key），失败或结果为空返回 null；429/5xx 退避重试 */
export async function googleTranslate(text, retries = 2) {
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

/** 逐条补上 descriptionZh（已中文原样 / 缓存命中 / 翻译新条目并写回缓存）。
 *  连续失败达 TRANSLATE_FAIL_BREAKER 时熔断：剩余条目本轮保持英文（下轮构建重试）。 */
export async function localizeDescriptions(
  entries,
  translationsPath,
  log = console.log,
  translateFn = googleTranslate
) {
  const cache = readTranslations(translationsPath)
  const stat = { alreadyChinese: 0, cached: 0, translated: 0, failed: 0, skippedByBreaker: 0, done: 0 }
  let consecutiveFailures = 0
  let breakerOpen = false

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
      } else if (breakerOpen) {
        stat.skippedByBreaker++
      } else {
        await sleep(TRANSLATE_INTERVAL_MS)
        const zh = await translateFn(entry.description)
        if (zh) {
          consecutiveFailures = 0
          cache[entry.id] = zh
          entry.descriptionZh = zh
          stat.translated++
          if (stat.translated % 50 === 0) writeTranslations(translationsPath, cache) // 增量落盘防中断丢进度
        } else {
          stat.failed++
          consecutiveFailures++
          if (consecutiveFailures >= TRANSLATE_FAIL_BREAKER && !breakerOpen) {
            breakerOpen = true
            log(
              `[build-index] 描述翻译连续失败 ${consecutiveFailures} 次：本轮熔断，剩余新条目保持英文原文（不写缓存，下轮构建重试）`
            )
          }
        }
      }
    }
    if (++stat.done % 100 === 0) {
      log(`[build-index] 描述中文化进度: ${stat.done}/${entries.length}（新翻译 ${stat.translated}，失败 ${stat.failed}）`)
    }
  })
  writeTranslations(translationsPath, cache)
  log(
    `[build-index] 描述中文化: 已中文 ${stat.alreadyChinese} / 缓存命中 ${stat.cached} / 新翻译 ${stat.translated} / 失败保持原文 ${stat.failed} / 熔断跳过 ${stat.skippedByBreaker} -> ${translationsPath}`
  )
  return entries
}
