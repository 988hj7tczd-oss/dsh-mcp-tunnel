/**
 * dsh-mcp-tunnel — dsh-mcp-client 追加配置的生成 / 校验 / 待确认管理。
 *
 * 目标：把隧道公开 URL 注册到 `@deepseek-ai/dsh-mcp-client` 的
 * streamable-http 配置里（`{ serverName, transport: 'streamable-http', url,
 * headers: { Authorization } }`），让远程 Agent 通过标准 MCP Client 直连。
 *
 * 安全护栏 1：本模块绝不直接改写任何 profile 配置 —— create 只生成
 * 「待确认片段」写入部署目录 mcp-client.pending.yml，由用户在显式确认后
 * 粘贴进自己的 cordis.patch.yml（或给未来的确认注入路径）。stop 会移除
 * 待确认片段（验收标准 4）。
 *
 * 片段结构镜像 @deepseek-ai/dsh-mcp-client 的 StreamableHttpConfig：
 *   serverName / transport / url / headers / toolCallTimeoutMs / failOnStartupError
 * （serverName 约束与 mcp-client 一致：^[A-Za-z0-9_-]{1,32}$）。
 *
 * @module dsh-mcp-tunnel/mcp-client-config
 */

import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

/** 与 @deepseek-ai/dsh-mcp-client 一致的 serverName 约束。 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** mcp-client 包名（追加片段里的 row name）。 */
export const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/** 待确认片段的固定文件名（部署目录内）。 */
export const PENDING_FILENAME = 'mcp-client.pending.yml'

/** 默认单次工具调超时（与 mcp-client 默认一致）。 */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/** 追加到 mcp-client 的服务器片段（镜像 dsh-mcp-client 的 streamable-http 配置）。 */
export interface McpClientFragment {
  /** 稳定命名空间，远端工具名 = mcp__<serverName>__<rawName>。 */
  serverName: string
  /** 固定选择 streamable-http 传输。 */
  transport: 'streamable-http'
  /** 隧道公开 URL（MCP 端点）。 */
  url: string
  /** 附加请求头（Authorization: Bearer <token>）。 */
  headers: Record<string, string>
  /** 单次工具调用超时（毫秒）。 */
  toolCallTimeoutMs: number
  /** 启动连接失败时是否让插件激活失败（默认 false，走重连）。 */
  failOnStartupError: boolean
}

/** 校验 serverName；返回错误消息或 null（合法）。 */
export function validateServerName(name: string): string | null {
  if (!SERVER_NAME_PATTERN.test(name)) {
    return `invalid serverName "${name}": must match ${SERVER_NAME_PATTERN.source} (1–32 个 A-Za-z0-9_- 字符)`
  }
  return null
}

/**
 * 构造 mcp-client streamable-http 片段。
 * @param serverName - 命名空间（与隧道名一致）。
 * @param url - 隧道公开 MCP 端点 URL。
 * @param token - 访问令牌（Authorization: Bearer <token>）。
 */
export function buildFragment(serverName: string, url: string, token: string): McpClientFragment {
  const nameError = validateServerName(serverName)
  if (nameError !== null) throw new Error(nameError)
  if (!/^https?:\/\//.test(url)) throw new Error(`buildFragment: url must be http(s), got "${url}"`)
  if (token.length === 0) throw new Error('buildFragment: token must not be empty')
  return {
    serverName,
    transport: 'streamable-http',
    url,
    headers: { Authorization: `Bearer ${token}` },
    toolCallTimeoutMs: DEFAULT_TOOL_CALL_TIMEOUT_MS,
    failOnStartupError: false,
  }
}

/** 生成随机的部署访问令牌（32 字节 hex）。 */
export function generateToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * 把片段序列化为可直接粘进 profile cordis.patch.yml 的 YAML 追加块
 * （`- insert:` 那一层由 patch 文件自身提供，这里给到 insert 的子行）。
 */
export function fragmentToPatchYaml(fragment: McpClientFragment, rowId?: string): string {
  const id = rowId ?? `mcp-${fragment.serverName}`
  const yamlQuote = (value: string): string => {
    // 含空格 / 引号等特殊字符时用单引号包裹（' 转义为 ''）。
    if (/[\s"'#:]/.test(value)) return `'${value.replace(/'/g, "''")}'`
    return value
  }
  const header = fragment.headers

  // 保持与 dsh-mcp-client Config 字段名完全一致（既有字段都写出，便于 diff）。
  const lines: string[] = []
  lines.push(`    - id: ${yamlQuote(id)}`)
  lines.push(`      name: ${yamlQuote(MCP_CLIENT_PACKAGE)}`)
  lines.push('      config:')
  lines.push(`        serverName: ${yamlQuote(fragment.serverName)}`)
  lines.push(`        transport: ${fragment.transport}`)
  lines.push(`        url: ${yamlQuote(fragment.url)}`)
  lines.push(`        headers:`)
  for (const [key, value] of Object.entries(header)) {
    lines.push(`          ${yamlQuote(key)}: ${yamlQuote(value)}`)
  }
  lines.push(`        toolCallTimeoutMs: ${fragment.toolCallTimeoutMs}`)
  lines.push(`        failOnStartupError: ${String(fragment.failOnStartupError)}`)
  return lines.join('\n') + '\n'
}

/** 写待确认片段到部署目录，返回文件绝对路径。 */
export async function writePendingFragment(deployDir: string, fragment: McpClientFragment): Promise<string> {
  await fs.mkdir(deployDir, { recursive: true })
  const path = join(deployDir, PENDING_FILENAME)
  const body = [
    '# dsh-mcp-tunnel — 待确认的 mcp-client 追加片段（安全护栏 1：未经用户',
    '# 显式确认不得写入任何 profile 配置）。确认后把下方 `- insert:` 段复制进',
    `# 你的 profile 的 cordis.patch.yml（行引用 ${MCP_CLIENT_PACKAGE}），`,
    '# 或粘贴到「追加配置」一节描述的任意声明位置。mcp_tunnel_stop 会删除本文件。',
    '#',
    '- insert:',
    fragmentToPatchYaml(fragment),
  ].join('\n')
  await fs.writeFile(path, body, 'utf8')
  return path
}

/** 读部署目录的待确认片段；无片段或解析失败返回 null。 */
export async function readPendingFragment(deployDir: string): Promise<McpClientFragment | null> {
  const path = join(deployDir, PENDING_FILENAME)
  try {
    const raw = await fs.readFile(path, 'utf8')
    const match = /-\s*insert:\s*\n([\s\S]*)/.exec(raw)
    const block = match?.[1] ?? raw
    const serverName = extractYaml('serverName', block)
    const transport = extractYaml('transport', block)
    const url = extractYaml('url', block)
    const auth = extractYaml('Authorization', block)
    if (serverName === null || transport === null || url === null) return null
    return {
      serverName,
      transport: 'streamable-http',
      url,
      headers: auth !== null ? { Authorization: auth } : {},
      toolCallTimeoutMs: DEFAULT_TOOL_CALL_TIMEOUT_MS,
      failOnStartupError: false,
    }
  } catch {
    return null
  }
}

/** 极简 YAML 标量提取：`key: value` 行（忽略注释/缩进差异）。 */
function extractYaml(key: string, text: string): string | null {
  for (const line of text.split('\n')) {
    const match = new RegExp(`\\b${key}\\s*:\\s*(.+)`).exec(line)
    if (match === null) continue
    let value = match[1]!.trim()
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/g, "'")
    return value
  }
  return null
}

/** 移除部署目录的待确认片段；返回是否确有文件被删。 */
export async function removePendingFragment(deployDir: string): Promise<boolean> {
  const path = join(deployDir, PENDING_FILENAME)
  try {
    await fs.unlink(path)
    return true
  } catch {
    return false
  }
}