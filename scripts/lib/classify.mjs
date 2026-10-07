/** 中文分类（对齐客户端 CATEGORY_LABELS，兜底"自定义"）。 */

export const CATEGORY_RULES = [
  { label: '搜索', keys: ['search', 'brave', 'exa', 'tavily', 'bing', 'duckduckgo', 'google search', 'web search', 'internet search', 'youtube search'] },
  { label: '数据库', keys: ['database', 'sql', 'postgres', 'mysql', 'sqlite', 'mongodb', 'redis', 'neo4j', 'dynamodb', 'supabase', 'prisma', 'database', 'postgresql', 'db2', 'bigquery', 'clickhouse'] },
  { label: '浏览器自动化', keys: ['browser', 'playwright', 'puppeteer', 'chrome', 'firefox', 'webdriver', 'selenium'] },
  { label: '代码托管平台', keys: ['github', 'gitlab', 'bitbucket', 'gitee', 'git repository', 'pull request', 'code review', 'gitlab', 'git'] },
  { label: '项目管理', keys: ['jira', 'linear', 'trello', 'asana', 'project management', 'issue tracker', 'sprint', 'task management', 'todoist', 'shortcut', 'pivotal'] },
  { label: '通讯协作', keys: ['slack', 'teams', 'telegram', 'discord', 'gmail', 'outlook', 'email', 'mail', 'calendar', 'meeting', 'whatsapp', 'notification', 'communication', 'chat', 'messaging', 'signal', 'matrix', 'mattermost'] },
  { label: '文件系统', keys: ['file', 'filesystem', 'drive', 'dropbox', 'storage', 'folder', 'ftp', 's3', 'box'] },
  { label: '文档协作', keys: ['docs', 'confluence', 'notion', 'google docs', 'documentation', 'wiki', 'knowledge base', 'word', 'powerpoint', 'google drive', 'xlsx', 'docx'] },
  { label: '设计工具', keys: ['design', 'figma', 'image generation', 'image gen', 'icon', 'logo', 'ui', 'illustration', 'canva', 'svg'] },
  { label: '错误追踪', keys: ['sentry', 'bug', 'error tracking', 'crash', 'exception', 'monitoring', 'observability', 'logs', 'trace', 'apm', 'uptime'] },
  { label: '云平台部署', keys: ['aws', 'azure', 'gcp', 'cloud', 'kubernetes', 'k8s', 'docker', 'deploy', 'terraform', 'serverless', 'lambda', 'vercel', 'netlify', 'kubernetes'] },
  { label: '知识检索', keys: ['knowledge', 'rag', 'vector', 'memory', 'article', 'research', 'papers', 'semantic', 'embedding', 'knowledge graph', 'wiki', 'document search', 'arxiv', 'scholar'] },
  { label: '可视化', keys: ['chart', 'visualize', 'visualization', 'graph', 'dashboard', 'diagram', 'plot', 'canvas'] },
  { label: '智能增强', keys: ['ai', 'llm', 'model', 'agent', 'intelligence', 'ml', 'machine learning', 'deep learning', 'gpt', 'claude', 'openai', 'inference', 'genai', 'multimodal', 'assistant'] },
  { label: '开发工具', keys: ['dev', 'developer', 'sdk', 'api', 'code', 'programming', 'test', 'testing', 'ci', 'automation', 'workflow', 'integration', 'tool', 'terminal', 'shell', 'scraping', 'web scraping', 'rest', 'graphql', 'oauth', 'framework'] }
]

/** 正则转义（key 中的特殊字符） */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 预编译词边界正则：避免 'word' 命中 'words'、'dev' 命中 'device' 之类的子串误报 */
const COMPILED_RULES = CATEGORY_RULES.map((rule) => ({
  label: rule.label,
  patterns: rule.keys.map((k) => new RegExp(`(?<![\\w])${escapeRe(k)}(?![\\w])`))
}))

export function classify(...texts) {
  const text = texts.filter((t) => typeof t === 'string').join(' ').toLowerCase()
  for (const rule of COMPILED_RULES) {
    if (rule.patterns.some((re) => re.test(text))) return rule.label
  }
  return '自定义'
}
