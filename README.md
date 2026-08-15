# mindos-mcp-index

MindOS 插件市场索引。仅一个 `index.json` 文件，由客户端 `https://xxcr777.github.io/mindos-mcp-index/index.json` 拉取。

## 条目字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 市场条目 id，安装后写入插件记录的 `remoteId` 用于去重与升级检测 |
| `name` | 是 | 显示名称 |
| `description` | 是 | 描述 |
| `category` | 是 | 分类 |
| `source` | 是 | 来源渠道：`registry` / `smithery` / `github` |
| `packageName` / `packageType` | 二选一 | 下载型插件（npm/pypi/docker），客户端用 npx/uvx/docker 安装 |
| `url` | 二选一 | 远程插件（streamable-http 地址），无需下载 |

## 发布方式

把本目录推送到 GitHub 并开启 Pages：

```bash
git init
git add index.json
git commit -m "feat: market index"
git branch -M main
git remote add origin https://github.com/xxcr777/mindos-mcp-index.git
git push -u origin main
```

然后到仓库 Settings → Pages，Source 选 `Deploy from a branch`、分支 `main`，保存即可。几分钟后 `https://xxcr777.github.io/mindos-mcp-index/index.json` 生效。

## 更新

改完 `index.json` 直接 push，客户端缓存 1 小时（本地开发可设环境变量 `MINDO_MARKET_INDEX_URL` 指向任意地址强制刷新）。
