/**
 * 安装形态提取（README → packageName/packageType 或远程 url）。
 * 优先级：JSON 配置块（MCP 配置最权威）→ 命令行文本（npx > uvx > docker）。
 * 仅产出客户端可安装的形态：npm / pypi / docker / 远程 url。
 */
import { DOCKER_IMAGE_RE, URL_RE } from './client-rules.mjs'

export function stripVersion(name) {
  const at = name.lastIndexOf('@')
  return at > 0 ? name.slice(0, at) : name
}

export function findNpm(text) {
  return findNpmAll(text)[0] ?? null
}

/** 收集文本中全部 npx 包名（按出现位置排序；README 常同时出现 CLI 命令与 server 包，交由挑选逻辑择优） */
export function findNpmAll(text) {
  const found = []
  const patterns = [
    /--package=([@\w.-]+(?:\/[\w.-]+)?)/g,
    /\bnpx(?:\.cmd)?\b[ \t]+(?:-y|--yes)[ \t]+(@?[\w][\w.-]*(?:\/[\w.-]+)?)/g,
    /\bnpx(?:\.cmd)?\b[ \t]+(@?[A-Za-z0-9_][\w.-]*(?:\/[\w.-]+)?)/g
  ]
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      found.push({ index: m.index ?? 0, name: stripVersion(m[1]) })
    }
  }
  found.sort((a, b) => a.index - b.index)
  return [...new Set(found.map((f) => f.name))]
}

/** 多候选包名择优：优先含 mcp 词（或 @modelcontextprotocol）的包，否则首个 */
export function pickPreferredPackage(names) {
  if (!Array.isArray(names) || names.length === 0) return null
  return names.find((n) => MCP_TARGET_RE.test(n)) ?? names[0]
}

export function findPypi(text) {
  const m = text.match(/\buvx(?:\.exe)?\b[ \t]+(?:--from[ \t]+)?([\w.-]+)/)
  return m ? stripVersion(m[1]) : null
}

/** docker run 中“值型 flag”：其后的 token 是参数值（端口/卷/名称/策略等），不是镜像名 */
const DOCKER_VALUE_FLAGS = new Set([
  '-p', '--publish', '-v', '--volume', '-e', '--env', '--name', '-w', '--workdir',
  '--network', '--user', '-u', '--entrypoint', '--add-host', '--label', '-l',
  '--mount', '--platform', '--hostname', '-h', '--restart', '--gpus', '--cap-add',
  '--cap-drop', '--device', '--memory', '-m', '--cpus', '--log-driver', '--log-opt',
  '--pid', '--ipc', '--dns', '--security-opt', '--ulimit', '--stop-signal'
])

export function findDocker(text) {
  const i = text.search(/\bdocker\s+run\b/i)
  if (i < 0) return null
  const seg = text.slice(i + 10, i + 300)
  let skipNext = false
  for (const tok of seg.split(/\s+/)) {
    if (!tok) continue
    if (skipNext) {
      skipNext = false
      continue
    }
    if (tok.startsWith('-')) {
      const flag = tok.includes('=') ? tok.slice(0, tok.indexOf('=')) : tok
      if (!tok.includes('=') && DOCKER_VALUE_FLAGS.has(flag)) skipNext = true
      continue
    }
    if (tok.includes('=')) continue
    if (DOCKER_IMAGE_RE.test(tok)) return tok
  }
  return null
}

/** 安装目标中的 MCP 词（mcp 独立词或 @modelcontextprotocol 官方 scope） */
const MCP_TARGET_RE = /(?<![\w])mcp(?![\w])|modelcontextprotocol/i

/** 命令行文本 → 安装形态（npx > uvx > docker；npx 多候选时优先含 mcp 的包） */
export function parseCommandLine(text) {
  if (typeof text !== 'string' || !text) return null
  const npm = pickPreferredPackage(findNpmAll(text))
  if (npm) return { packageName: npm, packageType: 'npm' }
  const pypi = findPypi(text)
  if (pypi) return { packageName: pypi, packageType: 'pypi' }
  const docker = findDocker(text)
  if (docker) return { packageName: docker, packageType: 'docker' }
  return null
}

/**
 * JSON 配置块提取（README 常见的 MCP 配置形态）：
 * - {"command":"npx","args":["-y","pkg"]} / uvx / docker run
 * - {"url":"https://...","type":"streamable-http"|"sse"}（远程托管）
 * 返回 { commandLine } 或 { url, packageType:'none' }；非 MCP 配置形态返回 null。
 */
export function findJsonConfig(text) {
  if (typeof text !== 'string' || !text) return null

  const cmd = text.match(/"command"\s*:\s*"(npx|uvx|docker)"[\s\S]{0,400}?"args"\s*:\s*\[([\s\S]{0,600}?)\]/)
  if (cmd) {
    const tool = cmd[1]
    const args = [...cmd[2].matchAll(/"([^"]*)"/g)].map((m) => m[1])
    if (args.length > 0) {
      return { commandLine: `${tool} ${args.join(' ')}` }
    }
  }

  // 远程 url：要求同片段出现 MCP 传输类型（streamable-http / sse / http），避免误抓普通链接
  const urlFirst = text.match(/"url"\s*:\s*"(https?:\/\/[^"]+)"[\s\S]{0,240}?"type"\s*:\s*"(streamable-http|sse|http)"/)
  if (urlFirst) {
    const url = urlFirst[1]
    if (URL_RE.test(url)) return { url, packageType: 'none' }
  }
  const typeFirst = text.match(/"type"\s*:\s*"(streamable-http|sse|http)"[\s\S]{0,240}?"url"\s*:\s*"(https?:\/\/[^"]+)"/)
  if (typeFirst) {
    const url = typeFirst[2]
    if (URL_RE.test(url)) return { url, packageType: 'none' }
  }

  return null
}

/** README → 安装形态；无可用形态返回 null。
 *  fromJsonConfig=true 表示来自 MCP 配置块（强 MCP 信号，用于相关性过滤）。 */
export function extractInstall(readme) {
  const jsonCfg = findJsonConfig(readme)
  if (jsonCfg) {
    if (typeof jsonCfg.url === 'string') {
      return { url: jsonCfg.url, packageType: 'none', fromJsonConfig: true }
    }
    const fromJson = parseCommandLine(jsonCfg.commandLine)
    if (fromJson) return { ...fromJson, fromJsonConfig: true }
  }
  const plain = parseCommandLine(readme)
  return plain ? { ...plain, fromJsonConfig: false } : null
}
