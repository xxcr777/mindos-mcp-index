# mindos-mcp-index

MindOS 插件市场索引。由客户端 `https://xxcr777.github.io/mindos-mcp-index/index.json` 拉取。

索引由 `scripts/build-index.mjs` 全自动生成（零依赖，Node 18+），每日由 GitHub Actions 重建并回传。

## 数据来源（三源合并）

| 来源 | 数量 | 说明 |
| --- | --- | --- |
| 手动精选 `scripts/manual.json` | 4 | 人工维护的精选条目（中文描述/icon 优先，官方同键条目仅回填 `updatedAt`/`version`） |
| 官方 MCP Registry | 1500 | `registry.modelcontextprotocol.io`，开放注册表（实测 2 万+ 条目、无流行度指标），按 `updatedAt` 最新优先截取；剔除无安装形态的条目 |
| Smithery | ~123 | `registry.smithery.ai`，分页有服务端漂移 bug（page>10 后大量重复，offset/limit/sort 参数无效），全量翻取后按 `qualifiedName` 去重，实际唯一条目约 123 |
| GitHub | ~110 | `topic:mcp-server` 按 stars 截取 top 300，raw README 解析 npx/uvx/docker 安装形态，npm/pypi 包做存在性校验，失败条目剔除 |

合并去重键：`packageName` 优先，其次 `url`，最后 `id`；先入为主，冲突时官方条目回填 `updatedAt`/`version`/`registryUrl`（不覆盖 icon 与中文描述）。

## 条目字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 市场条目 id（`registry:` / `smithery:` / `github:` 前缀），安装后写入插件记录的 `remoteId` 用于去重与升级检测 |
| `name` | 是 | 显示名称 |
| `description` | 是 | 描述 |
| `descriptionZh` | 否 | 索引侧预翻译的中文描述；客户端中文模式优先展示，缺失时回退英文。已含中文的条目原样透传；其余由构建脚本经免费 Google 接口自动翻译 |
| `category` | 是 | 分类（知识检索/开发工具/智能增强/可视化/浏览器自动化/代码托管平台/搜索/数据库/文件系统/项目管理/通讯协作/文档协作/设计工具/错误追踪/云平台部署/自定义） |
| `source` | 是 | 来源渠道：`registry` / `smithery` / `github` |
| `packageName` / `packageType` | 二选一 | 下载型插件（npm/pypi/docker），客户端用 npx/uvx/docker 安装 |
| `url` | 二选一 | 远程插件（streamable-http 地址），无需下载 |
| `useCount` | 否 | Smithery 安装次数，客户端用于排序 |
| `verified` | 否 | 是否官方/已验证 |
| `version` | 否 | 版本号（官方 Registry） |
| `updatedAt` | 否 | 更新时间（epoch 秒），客户端用于更新检测 |
| `registryUrl` | 否 | 来源主页/仓库地址（详情页用） |

## 本地构建

```bash
# 可选：GitHub API token（匿名 10 req/min 限流，约 2 分钟）
# 推荐设为环境变量 GITHUB_TOKEN（30 req/min，构建更快更稳）
node scripts/build-index.mjs
```

产物 `index.json` 由脚本全量覆盖；手动精选条目请编辑 `scripts/manual.json`（不要直接改 `index.json`，避免被下次构建覆盖）。

## 描述中文化（自动翻译）

构建时对全量条目做描述中文化，产出 `descriptionZh`：

- 已含中文的描述原样作为 `descriptionZh`；
- 其余按 `scripts/translations.json` 缓存查询（键为条目 id，如 `registry:xxx` / `github:owner/repo`），命中直接复用；
- 未命中则调用免费 Google 公共翻译接口（并发 3、限速重试），新翻译写回缓存并随构建提交回仓库，下次构建增量命中；
- 翻译失败或描述为空时该条目不带 `descriptionZh`，客户端回退英文原文。

`translations.json` 同时是人工修订的入口：直接改其中某个条目的译文即可覆盖自动翻译结果，构建会优先采用缓存。

## 自动构建

`.github/workflows/build-index.yml`：每日 08:00 UTC 定时 + 手动触发（workflow_dispatch），构建后提交 `index.json` 与 `scripts/translations.json` 回 `main`，触发 GitHub Pages 自动发布。

## 发布方式

首次使用：

```bash
git init
git add .
git commit -m "feat: market index"
git branch -M main
git remote add origin https://github.com/xxcr777/mindos-mcp-index.git
git push -u origin main
```

仓库 Settings → Pages，Source 选 `Deploy from a branch`、分支 `main`，保存即可。几分钟后 `https://xxcr777.github.io/mindos-mcp-index/index.json` 生效。

## 更新

改完直接 push（或等每日自动构建），客户端缓存 1 小时（本地开发可设环境变量 `MINDO_MARKET_INDEX_URL` 指向任意地址强制刷新）。
