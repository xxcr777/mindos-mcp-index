/** 构建脚本共用的 HTTP 工具（零依赖）。 */

export const USER_AGENT = 'mindos-index-builder/1.0'
export const TIMEOUT_MS = 20_000

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** JSON 请求（GET/POST；2xx 解析 JSON；失败退避重试） */
export async function httpJson(url, { headers = {}, retries = 2, method = 'GET', bodyText } = {}) {
  let lastErr
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
        ...(bodyText !== undefined ? { body: bodyText } : {}),
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
export async function httpJsonRate(url, { headers = {}, retries = 2 } = {}) {
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

/** 文本请求：404 返回 null（README 探测），其余失败退避重试 */
export async function httpText(url, { retries = 2 } = {}) {
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
export async function mapLimit(items, limit, fn) {
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

/** ISO 时间字符串 → epoch 秒（无效返回 undefined） */
export const toEpoch = (iso) => {
  if (typeof iso !== 'string') return undefined
  const t = Date.parse(iso)
  return Number.isFinite(t) ? Math.floor(t / 1000) : undefined
}
