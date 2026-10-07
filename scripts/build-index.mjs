#!/usr/bin/env node
/**
 * 插件市场索引构建脚本（零依赖，Node 18+）
 *
 * 三源合并：
 *   1. 官方 MCP Registry —— registry.modelcontextprotocol.io（version=latest，cursor 翻页）
 *   2. Smithery —— registry.smithery.ai（全量翻取后去重）
 *   3. GitHub —— stars>100 的热门 MCP 仓库（搜索矩阵 + awesome 列表双通道，
 *      增量缓存，产出前 1000 条；实现见 lib/github-source.mjs）
 *
 * 合并策略：手动精选（scripts/manual.json）优先保留，官方 Registry 同键回填
 * updatedAt/version/registryUrl；官方 > Smithery > GitHub 去重。
 * 输出前复刻客户端 isValidEntry 自校验；描述补 descriptionZh（增量翻译缓存）。
 * GitHub 源增量缓存落 scripts/github-cache.json（随构建提交）。
 *
 * CLI：
 *   --dry-run        只统计不写文件（本地验证）
 *   --source=github  仅运行指定源（github | registry | smithery）
 *   --limit=N        试跑限量（限制 GitHub 候选中转量）
 *
 * 安全防线：合并结果若不足当前 index.json 的一半（>=1 条）→ 拒绝写盘（防事故性覆盖）。
 */
import { readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isValidEntry } from './lib/client-rules.mjs'
import { fetchOfficial, fetchSmithery } from './lib/sources.mjs'
import { readManual, mergeAll } from './lib/merge.mjs'
import { localizeDescriptions } from './lib/translate.mjs'
import {
  fetchGitHub,
  readGitHubCache,
  writeGitHubCache,
  emptyGitHubCache,
  GITHUB_STARS_MIN,
  GITHUB_MAX_ENTRIES
} from './lib/github-source.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX_PATH = join(ROOT, 'index.json')
const MANUAL_PATH = join(ROOT, 'scripts', 'manual.json')
const TRANSLATIONS_PATH = join(ROOT, 'scripts', 'translations.json')
const GITHUB_CACHE_PATH = join(ROOT, 'scripts', 'github-cache.json')

export function parseArgs(argv) {
  const args = { dryRun: false, source: null, limit: null }
  for (const raw of argv) {
    if (raw === '--dry-run') args.dryRun = true
    else if (raw.startsWith('--source=')) args.source = raw.slice('--source='.length)
    else if (raw.startsWith('--limit=')) {
      const n = Number(raw.slice('--limit='.length))
      if (Number.isFinite(n) && n > 0) args.limit = Math.floor(n)
    }
  }
  return args
}

function readCurrentIndexCount() {
  try {
    const raw = JSON.parse(readFileSync(INDEX_PATH, 'utf8'))
    return Array.isArray(raw?.entries) ? raw.entries.length : 0
  } catch {
    return 0
  }
}

const EMPTY_GITHUB = {
  entries: [],
  raw: 0,
  dropped: { searched: 0, awesomeLinked: 0, awesomeMeta: 0, eligible: 0, candidates: 0, cacheHit: 0, parsed: 0, guessed: 0, fetchError: 0, noReadme: 0, noInstall: 0, notMcp: 0, verifyFail: 0 }
}
const EMPTY_OFFICIAL = { entries: [], raw: 0, dropped: { noInstall: 0, smitheryDup: 0, truncated: 0 } }
const EMPTY_SMITHERY = { entries: [], raw: 0, total: 0, dropped: 0 }

export async function main(argv = process.argv.slice(2), log = console.log) {
  const started = Date.now()
  const args = parseArgs(argv)
  const onlyGithub = args.source === 'github'
  const onlyRegistry = args.source === 'registry'
  const onlySmithery = args.source === 'smithery'

  const existing = readManual(MANUAL_PATH)
  const githubCache = args.dryRun ? emptyGitHubCache() : readGitHubCache(GITHUB_CACHE_PATH)
  const token = process.env.GITHUB_TOKEN
  if (!token) log('[build-index] 警告：未设置 GITHUB_TOKEN，GitHub 搜索限流将降至 10 req/min，GraphQL 批量补齐将跳过')

  const [official, smithery, github] = await Promise.all([
    onlyGithub || onlySmithery
      ? EMPTY_OFFICIAL
      : fetchOfficial().catch((err) => {
          log(`[build-index] 官方 Registry 源失败（降级为空）: ${err.message}`)
          return EMPTY_OFFICIAL
        }),
    onlyGithub || onlyRegistry
      ? EMPTY_SMITHERY
      : fetchSmithery().catch((err) => {
          log(`[build-index] Smithery 源失败（降级为空）: ${err.message}`)
          return EMPTY_SMITHERY
        }),
    onlyRegistry || onlySmithery
      ? EMPTY_GITHUB
      : fetchGitHub({ token, cache: githubCache, log, limit: args.limit ?? undefined }).catch((err) => {
          log(`[build-index] GitHub 源失败（降级为空）: ${err.message}`)
          return EMPTY_GITHUB
        })
  ])

  const merged = mergeAll(
    { official: official.entries, smithery: smithery.entries, github: github.entries },
    existing
  )
  const valid = merged.filter(isValidEntry)
  const dropped = merged.length - valid.length

  if (!args.dryRun) {
    await localizeDescriptions(valid, TRANSLATIONS_PATH, log)
  } else {
    log('[build-index] dry-run：跳过描述中文化与写盘')
  }

  log('[build-index] ===== 构建统计 =====')
  log(`[build-index] 手动精选（保留优先）: ${existing.length} 条`)
  log(
    `[build-index] 官方 Registry: ${official.entries.length}/${official.raw} 条（无安装形态 ${official.dropped.noInstall} / Smithery 重复 ${official.dropped.smitheryDup} / 截断 ${official.dropped.truncated}）`
  )
  log(`[build-index] Smithery: ${smithery.entries.length}/${smithery.total} 条唯一（页面翻取 ${smithery.raw} 条，过滤 ${smithery.dropped}）`)
  const g = github.dropped
  log(
    `[build-index] GitHub（stars>${GITHUB_STARS_MIN}，产出上限 ${GITHUB_MAX_ENTRIES}）: ${github.entries.length} 条 / 过滤后 ${g.eligible} / 候选 ${g.candidates}（搜索 ${g.searched} / awesome 链接 ${g.awesomeLinked}，批量补元数据 ${g.awesomeMeta}；缓存命中 ${g.cacheHit} / 新解析 ${g.parsed}（含同名包兜底 ${g.guessed}） / 网络失败 ${g.fetchError} / 无 README ${g.noReadme} / 无安装形态 ${g.noInstall} / 非 MCP 仓库 ${g.notMcp} / 包校验失败 ${g.verifyFail}）`
  )
  log(`[build-index] 合并去重后: ${merged.length} 条，自校验剔除 ${dropped} 条`)

  if (args.dryRun) {
    log(`[build-index] dry-run 完成（未写任何文件，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s）`)
    return { entries: valid.length, wrote: false }
  }

  // 安全防线：防事故性覆盖（新结果不足当前的一半时拒绝写盘）
  const currentCount = readCurrentIndexCount()
  if (currentCount >= 1 && valid.length < currentCount / 2) {
    throw new Error(
      `安全防线触发：本次合并仅 ${valid.length} 条，不足现有索引 ${currentCount} 条的一半，拒绝写盘（检查上游源是否异常）`
    )
  }

  writeFileSync(INDEX_PATH, JSON.stringify({ entries: valid }, null, 2) + '\n')
  writeGitHubCache(GITHUB_CACHE_PATH, githubCache)
  log(`[build-index] 最终: ${valid.length} 条 -> ${INDEX_PATH}（耗时 ${((Date.now() - started) / 1000).toFixed(1)}s）`)
  log(`[build-index] GitHub 增量缓存 -> ${GITHUB_CACHE_PATH}`)
  return { entries: valid.length, wrote: true }
}

function isDirectRun() {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[build-index] 失败: ${err instanceof Error ? err.message : err}`)
    process.exitCode = 1
  })
}
