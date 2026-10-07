import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractInstall,
  findJsonConfig,
  findNpm,
  findNpmAll,
  findPypi,
  findDocker,
  stripVersion,
  pickPreferredPackage,
  parseCommandLine
} from './install-extract.mjs'

test('stripVersion：去掉尾部 @version', () => {
  assert.equal(stripVersion('@scope/pkg@1.2.3'), '@scope/pkg')
  assert.equal(stripVersion('pkg@0.1.0'), 'pkg')
  assert.equal(stripVersion('@scope/pkg'), '@scope/pkg')
})

test('findNpm 三种形态与优先级', () => {
  assert.equal(findNpm('npx --package=@a/b cmd'), '@a/b')
  assert.equal(findNpm('npx -y @upstash/context7-mcp'), '@upstash/context7-mcp')
  assert.equal(findNpm('npx some-mcp-server'), 'some-mcp-server')
  assert.equal(findNpm('npx -y pkg@1.2.3'), 'pkg')
  assert.equal(findNpm('no install here'), null)
})

test('findNpmAll/pickPreferredPackage：多条命令时优先含 mcp 的包（context7 场景）', () => {
  const text = 'setup: npx ctx7 setup\nserve: npx -y @upstash/context7-mcp'
  assert.deepEqual(findNpmAll(text), ['ctx7', '@upstash/context7-mcp'])
  assert.equal(pickPreferredPackage(findNpmAll(text)), '@upstash/context7-mcp')
  assert.deepEqual(parseCommandLine(text), { packageName: '@upstash/context7-mcp', packageType: 'npm' })
  // 无 mcp 候选时回退首个
  assert.equal(pickPreferredPackage(['plain-cli', 'other-cli']), 'plain-cli')
  assert.equal(pickPreferredPackage([]), null)
})

test('findPypi / findDocker', () => {
  assert.equal(findPypi('uvx mcp-server-fetch'), 'mcp-server-fetch')
  assert.equal(findPypi('uvx --from gitignore-parser pkg'), 'gitignore-parser')
  assert.equal(findDocker('docker run -i --rm ghcr.io/acme/mcp:latest'), 'ghcr.io/acme/mcp:latest')
  assert.equal(findDocker('docker build .'), null)
})

test('findDocker：跳过值型 flag 的参数（端口/卷/名称），不把参数当镜像名', () => {
  assert.equal(
    findDocker('docker run -d -p 3000:8080 --name openweb ghcr.io/open-webui/open-webui:main'),
    'ghcr.io/open-webui/open-webui:main'
  )
  assert.equal(findDocker('docker run -it --rm --name n8n -p 5678:5678 docker.n8n.io/n8nio/n8n'), 'docker.n8n.io/n8nio/n8n')
  assert.equal(findDocker('docker run -v /host/data:/data -e TOKEN=x acme/db-mcp'), 'acme/db-mcp')
  // 值型 flag 的参数（端口/卷）不应被误认为镜像
  assert.notEqual(findDocker('docker run -p 3000:8080'), '3000:8080')
})

test('findJsonConfig：npx/uvx/docker 配置块提取', () => {
  const npx = findJsonConfig(`{
    "mcpServers": {
      "demo": { "command": "npx", "args": ["-y", "@scope/server"] }
    }
  }`)
  assert.equal(npx?.commandLine, 'npx -y @scope/server')
  const npm = extractInstall(JSON.stringify({ mcpServers: { x: { command: 'npx', args: ['-y', '@scope/server'] } } }))
  assert.deepEqual(npm, { packageName: '@scope/server', packageType: 'npm', fromJsonConfig: true })

  const uvx = extractInstall('{"command": "uvx", "args": ["mcp-server-fetch"]}')
  assert.deepEqual(uvx, { packageName: 'mcp-server-fetch', packageType: 'pypi', fromJsonConfig: true })

  const docker = extractInstall('{"command": "docker", "args": ["run", "-i", "--rm", "acme/mcp"]}')
  assert.deepEqual(docker, { packageName: 'acme/mcp', packageType: 'docker', fromJsonConfig: true })
})

test('findJsonConfig：远程 url 需同时出现传输类型（防误抓普通链接）', () => {
  const remote = extractInstall(`{
    "mcpServers": { "s": { "url": "https://api.example.com/mcp", "type": "streamable-http" } }
  }`)
  assert.deepEqual(remote, { url: 'https://api.example.com/mcp', packageType: 'none', fromJsonConfig: true })

  const typeFirst = extractInstall('{"type": "sse", "url": "https://api.example.com/sse"}')
  assert.deepEqual(typeFirst, { url: 'https://api.example.com/sse', packageType: 'none', fromJsonConfig: true })

  // 普通链接（无 MCP 传输类型）不产出 url 条目
  assert.equal(findJsonConfig('{"url": "https://example.com/home"}'), null)
})

test('extractInstall：JSON 优先于命令行；命令行形态 fromJsonConfig=false；无形态 null', () => {
  const mixed = `文档： \`\`\`json
{"mcpServers":{"x":{"command":"npx","args":["-y","@right/pkg"]}}}
\`\`\`
旧命令： npx -y @wrong/other`
  assert.deepEqual(extractInstall(mixed), { packageName: '@right/pkg', packageType: 'npm', fromJsonConfig: true })
  assert.deepEqual(extractInstall('npx -y some-mcp'), { packageName: 'some-mcp', packageType: 'npm', fromJsonConfig: false })
  assert.equal(extractInstall('# 纯文档，无安装形态'), null)
  assert.equal(extractInstall('见 https://example.com 说明'), null)
})
