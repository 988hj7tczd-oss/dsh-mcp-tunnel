/**
 * dsh-mcp-tunnel — 隧道栈生成（compose 栈的纯生成与落盘）。
 *
 * 本模块是纯函数风格、可离线单测的核心：`generateStack()` 只做字符串拼接，
 * 不触碰 docker / openssl / 网络；`writeStack()` 负责把生成的文件写进部署目录。
 * `index.ts` 负责编排（证书 → 生成 → docker compose → 轮询 URL → mcp-client 片段）。
 *
 * 模板渲染：本项目自带的迷你 handlebars 子集（避免引入运行时依赖），支持
 *   - `{{var}}`           变量插值（缺失时抛错，防止静默生成不完整配置）
 *   - `{{#if var}}…{{else}}…{{/if}}`   条件块（var 缺失/ falsy 走 else）
 *   不支持 helper / 循环 / 嵌套块表达式（生成的模板足够简单，无需这些）。
 *
 * @module dsh-mcp-tunnel/tunnel-stack
 */

import { promises as fs, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 宿主回环调试端口的默认值（只绑定 127.0.0.1，无公网监听端口）。 */
export const DEFAULT_HOST_PROXY_PORT = 43180

/** Quick Tunnel 公开 URL 的正则（cloudflared 日志形如 https://<sub>.trycloudflare.com）。 */
export const TRYCLOUDFLARE_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

/** 隧道名 / serverName 的合法形态（与 dsh-mcp-client 的 serverName 约束一致）。 */
export const TUNNEL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** 部署目录内的固定文件名。 */
export const COMPOSE_FILENAME = 'docker-compose.yml'
export const PROXY_ENV_FILENAME = 'proxy-config.env'
export const DOTENV_FILENAME = '.env'
export const DOTENV_EXAMPLE_FILENAME = '.env.example'
export const CERTS_DIRNAME = 'certs'
export const HELLO_MCP_DIRNAME = 'hello-mcp'
export const STATE_FILENAME = 'state.json'

/* ------------------------------------------------------------------ */
/* 迷你模板渲染                                                        */
/* ------------------------------------------------------------------ */

export interface TemplateContext {
  [key: string]: string | number | boolean | undefined
}

/**
 * 渲染迷你 handlebars 子集模板。
 * 支持 `{{name}}` 与 `{{#if name}}…{{else}}…{{/if}}`（可嵌套）。
 * vars 缺省视作 false；**插值块引用缺失的变量直接抛错**，避免生成坏配置。
 */
export function renderTemplate(template: string, vars: TemplateContext): string {
  const BLOCK = /{{\s*#if\s+([A-Za-z_][A-Za-z0-9_]*)\s*}}/
  const lookup = (name: string): string | number | boolean | undefined => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      throw new Error(`renderTemplate: template references missing variable "${name}"`)
    }
    return vars[name]
  }

  const renderRange = (input: string, end: number, varsCopy: TemplateContext): string => {
    let out = ''
    let i = 0
    while (i < input.length) {
      const start = input.indexOf('{{', i)
      if (start === -1 || start >= end) {
        out += input.slice(i, end)
        break
      }
      out += input.slice(i, start)
      const close = input.indexOf('}}', start)
      if (close === -1 || close >= end) throw new Error('renderTemplate: unterminated {{ block')
      const token = input.slice(start + 2, close).trim()
      const ifMatch = /^#if\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(token)
      const elseMatch = /^else$/.exec(token)
      const endIfMatch = /^\/if$/.exec(token)
      if (ifMatch !== null) {
        const blockEnd = findBlockEnd(input, close + 2, end)
        if (blockEnd === -1) throw new Error(`renderTemplate: missing {{/if}} for "#if ${ifMatch[1]}"`)
        const branch = splitElse(input.slice(close + 2, blockEnd))
        // #if 对缺失变量按假处理（插值块缺失才抛错）。
        const truthy = Object.prototype.hasOwnProperty.call(vars, ifMatch[1])
          ? Boolean(vars[ifMatch[1]])
          : false
        const chosen = truthy ? branch.then : branch.otherwise
        out += renderRange(chosen, chosen.length, varsCopy)
        i = blockEnd + '{{/if}}'.length
        continue
      }
      if (elseMatch !== null || endIfMatch !== null) {
        throw new Error(`renderTemplate: stray "${token}" block marker`)
      }
      if (token.length === 0) throw new Error('renderTemplate: empty {{}} block')
      out += String(lookup(token))
      i = close + 2
    }
    return out
  }

  const findBlockEnd = (input: string, from: number, limit: number): number => {
    let depth = 0
    let i = from
    while (i < limit) {
      const open = input.indexOf('{{', i)
      if (open === -1 || open >= limit) return -1
      const close = input.indexOf('}}', open)
      if (close === -1 || close >= limit) return -1
      const token = input.slice(open + 2, close).trim()
      if (/^#if\s+/.test(token)) depth += 1
      else if (token === '/if') {
        if (depth === 0) return open
        depth -= 1
      }
      i = close + 2
    }
    return -1
  }

  const splitElse = (body: string): { then: string; otherwise: string } => {
    let depth = 0
    let i = 0
    while (i < body.length) {
      const open = body.indexOf('{{', i)
      if (open === -1) break
      const close = body.indexOf('}}', open)
      if (close === -1) break
      const token = body.slice(open + 2, close).trim()
      if (/^#if\s+/.test(token)) depth += 1
      else if (token === '/if') depth -= 1
      else if (token === 'else' && depth === 0) {
        return { then: body.slice(0, open), otherwise: body.slice(close + 2) }
      }
      i = close + 2
    }
    return { then: body, otherwise: '' }
  }

  return renderRange(template, template.length, vars)
}

/* ------------------------------------------------------------------ */
/* 栈生成                                                              */
/* ------------------------------------------------------------------ */

/** stdio 型 MCP server（.mcp.json 的 command 形态）的解析结果。 */
export interface StdioServerSpec {
  /** 可执行命令（可与 args 拼接成完整启动行）。 */
  command: string
  /** 附加参数。 */
  args: string[]
  /** 可选工作目录提示。 */
  cwdHint?: string
}

/** 栈生成选项（全部可 JSON 序列化，便于测试与日志）。 */
export interface StackOptions {
  /** compose 项目名 / 隧道名（需匹配 TUNNEL_NAME_PATTERN）。 */
  projectName: string
  /** 隧道提供方。 */
  provider: 'cloudflare-quick' | 'anthropic'
  /** 宿主回环端口（只绑定 127.0.0.1）。 */
  hostProxyPort: number
  /** 公开侧展示主机名（quick 模式下为占位，真实 URL 来自 cloudflared 日志）。 */
  externalHostname: string
  /** 隧道面向的 MCP 上游端点（HTTP，容器网络或宿主回环可达）。 */
  upstreamUrl: string
  /** 是否附带 hello-mcp 示例 server 服务。 */
  useHelloMcp: boolean
  /** anthropic 命名隧道名（provider=anthropic 时的模板提示）。 */
  tunnelName?: string
}

/** `generateStack` 产出的文件：相对路径 → 内容。 */
export type StackFiles = Record<string, string>

/** hello-mcp 示例的构建上下文（内嵌，避免额外交付文件）。 */
export interface HelloMcpFiles {
  'Dockerfile': string
  'server.py': string
}

/* ------------------------------------------------------------------ */
/* 内嵌的 hello-mcp 示例 server（FastMCP echo）                          */
/* ------------------------------------------------------------------ */

const HELLO_MCP_DOCKERFILE = `# Generated by dsh-mcp-tunnel — hello-mcp 示例 server。
# 仅当用户没有自有 HTTP MCP 端点时使用；生产请替换为自己的 server。
FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir "mcp[cli]>=1.2.0,<2" && pip install --no-cache-dir uvicorn
COPY server.py /app/server.py
EXPOSE 8000
CMD ["python", "server.py"]
`

const HELLO_MCP_SERVER_PY = `# Generated by dsh-mcp-tunnel — FastMCP 示例（echo/uptime 两个工具）。
# 暴露 SSE 端点 /sse —— 隧道侧调用 mcp__<serverName>__echo 等工具时即到达这里。
import time
from mcp.server.fastmcp import FastMCP

_START = time.time()
mcp = FastMCP("hello-mcp")


@mcp.tool()
def echo(text: str) -> str:
    """Return the input text unchanged (smoke-test tool)."""
    return text


@mcp.tool()
def uptime() -> str:
    """Return how long this sample server has been running."""
    return f"up {int(time.time() - _START)}s"


if __name__ == "__main__":
    mcp.run(transport="sse", host="0.0.0.0", port=8000)
`

/** hello-mcp 构建文件内容（内嵌，随栈一起写入部署目录）。 */
export function helloMcpFiles(): HelloMcpFiles {
  return {
    'Dockerfile': HELLO_MCP_DOCKERFILE,
    'server.py': HELLO_MCP_SERVER_PY,
  }
}

/* ------------------------------------------------------------------ */
/* 纯生成函数（不碰文件系统）                                          */
/* ------------------------------------------------------------------ */

/** 模板目录的绝对路径（本模块同包平行目录 templates/）。 */
const TEMPLATE_DIR = fileURLToPath(new URL('../templates', import.meta.url))

function composeTemplate(): string {
  return join(TEMPLATE_DIR, 'docker-compose.yml.hbs')
}

function proxyEnvTemplate(): string {
  return join(TEMPLATE_DIR, 'proxy-config.env.hbs')
}

/**
 * 生成整套栈文件（纯函数，不落盘）。
 * 结果包含：docker-compose.yml、proxy-config.env、.env.example，
 * 以及 useHelloMcp 时的 hello-mcp/Dockerfile、hello-mcp/server.py。
 */
export function generateStack(options: StackOptions): StackFiles {
  if (!TUNNEL_NAME_PATTERN.test(options.projectName)) {
    throw new Error(`generateStack: invalid project name "${options.projectName}" (must match ${TUNNEL_NAME_PATTERN})`)
  }
  if (!/^https?:\/\//.test(options.upstreamUrl)) {
    throw new Error(`generateStack: upstreamUrl must be an http(s) URL, got "${options.upstreamUrl}"`)
  }
  if (options.hostProxyPort < 1 || options.hostProxyPort > 65535) {
    throw new Error(`generateStack: hostProxyPort out of range: ${options.hostProxyPort}`)
  }

  // 从模板文件源读取模板文本（保证单一事实来源在 templates/ 目录）。
  const composeSrc = readTemplate(composeTemplate())
  const envSrc = readTemplate(proxyEnvTemplate())

  const quickTunnel = options.provider === 'cloudflare-quick'
  const files: StackFiles = {}

  files[COMPOSE_FILENAME] = renderTemplate(composeSrc, {
    projectName: options.projectName,
    hostProxyPort: options.hostProxyPort,
    quickTunnel,
    tunnelName: options.tunnelName ?? options.projectName,
    useHelloMcp: options.useHelloMcp,
    // 用不到但必须解析的变量（hello-mcp 段不含额外变量）
    providerAnthropic: !quickTunnel,
  })

  files[PROXY_ENV_FILENAME] = renderTemplate(envSrc, {
    upstreamUrl: options.upstreamUrl,
    externalHostname: options.externalHostname,
  })

  files[DOTENV_EXAMPLE_FILENAME] = dotenvExample(options)
  files['README.stack.md'] = stackReadme(options)

  if (options.useHelloMcp) {
    const hello = helloMcpFiles()
    files[`${HELLO_MCP_DIRNAME}/Dockerfile`] = hello['Dockerfile']
    files[`${HELLO_MCP_DIRNAME}/server.py`] = hello['server.py']
  }
  return files
}

/** .env.example：只含占位说明，绝不包含真实秘密（安全护栏 2）。 */
function dotenvExample(options: StackOptions): string {
  const provider = options.provider === 'cloudflare-quick' ? 'Cloudflare Quick Tunnel（免账号）' : 'Cloudflare 命名隧道（anthropic 模式）'
  return `# 本文件由 dsh-mcp-tunnel 生成 — 复制为 .env 并填入真实值（.env 勿提交版本库）。
# API_KEY 是 mcp-proxy 校验入站请求的 Bearer 令牌；mcp_tunnel_create 会自动
# 生成一个随机令牌写入 .env（权限 0600）。生产环境请改用你自己的强密钥，并
# 通过轮换机制更换；免费快速隧道仅供测试（详见 README 安全模型）。
#
# 部署信息：provider=${provider}  upstream=${options.upstreamUrl}
API_KEY=change-me-mcp-access-token
`
}

/** 部署目录内的简短说明（`status` 工具也会读取展示）。 */
function stackReadme(options: StackOptions): string {
  return [
    '# dsh-mcp-tunnel 部署目录',
    '',
    `- 隧道名（compose 项目 / serverName）：\`${options.projectName}\``,
    `- 提供方：\`${options.provider}\``,
    `- 上游 MCP 端点：\`${options.upstreamUrl}\``,
    `- 宿主回环调试端口：\`127.0.0.1:${options.hostProxyPort}\``,
    `- 公开 URL：在 \`mcp_tunnel_create\` 输出 / \`state.json\` 中查看（Quick Tunnel 随机域名）。`,
    '',
    '常用命令（在本目录执行）：',
    `  docker compose -p ${options.projectName} up -d`,
    `  docker compose -p ${options.projectName} ps`,
    `  docker compose -p ${options.projectName} logs --tail 50 cloudflared`,
    `  docker compose -p ${options.projectName} down`,
    '',
    '安全：宿主机无公网监听端口（mcp-proxy 仅绑定 127.0.0.1 回环端口）；',
    '任何公网可达性都来自 cloudflared 的出站连接。生产流量必须自行加鉴权层。',
  ].join('\n')
}

/* ------------------------------------------------------------------ */
/* 文件系统                                                            */
/* ------------------------------------------------------------------ */

/** 读模板源文件（同步、小文件，仅生成期调用）。 */
function readTemplate(file: string): string {
  return readFileSync(file, 'utf8')
}

/**
 * 把生成的栈文件写入部署目录（先建目录）。返回写入的相对路径列表。
 */
export async function writeStack(deployDir: string, files: StackFiles): Promise<string[]> {
  const written: string[] = []
  for (const [rel, content] of Object.entries(files)) {
    const target = resolve(deployDir, rel)
    await fs.mkdir(dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
    written.push(rel)
  }
  return written
}

/** 已存在的栈文件状态（status 工具用）。 */
export interface StackPresence {
  composePresent: boolean
  envPresent: boolean
  dotenvPresent: boolean
  certsPresent: boolean
  helloMcpPresent: boolean
  statePresent: boolean
}

/** 探测部署目录里已经有哪些栈文件（不抛错，纯布尔）。 */
export async function readStackPresence(deployDir: string): Promise<StackPresence> {
  const stat = async (p: string): Promise<boolean> => {
    try {
      await fs.stat(p)
      return true
    } catch {
      return false
    }
  }
  return {
    composePresent: await stat(join(deployDir, COMPOSE_FILENAME)),
    envPresent: await stat(join(deployDir, PROXY_ENV_FILENAME)),
    dotenvPresent: await stat(join(deployDir, DOTENV_FILENAME)),
    certsPresent: await stat(join(deployDir, CERTS_DIRNAME)),
    helloMcpPresent: await stat(join(deployDir, HELLO_MCP_DIRNAME)),
    statePresent: await stat(join(deployDir, STATE_FILENAME)),
  }
}

/** 部署根目录下的隧道目录列表（status 工具列出全部隧道）。 */
export async function listTunnelDirs(deployRoot: string): Promise<string[]> {
  let entries: string[] = []
  try {
    entries = await fs.readdir(deployRoot)
  } catch {
    return [] // 根目录尚未创建 → 空列表
  }
  const dirs: string[] = []
  for (const entry of entries) {
    const full = resolve(deployRoot, entry)
    try {
      if ((await fs.stat(full)).isDirectory() && entry !== CERTS_DIRNAME) dirs.push(entry)
    } catch {
      // 忽略无法 stat 的条目
    }
  }
  return dirs.sort()
}

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

/** 展开路径开头的 `~` / `~/`。 */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** 把任意输入规范化为合法隧道名（非法字符替换为 -，超长截断，空则抛错）。 */
export function sanitizeTunnelName(input: string): string {
  let out = input.trim().replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  out = out.slice(0, 32)
  if (out.length === 0) throw new Error(`cannot derive a valid tunnel name from "${input}"`)
  return out
}

/** 读取部署目录 state.json（不存在返回 null；解析失败视为无状态）。 */
export async function readState<T>(deployDir: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(join(deployDir, STATE_FILENAME), 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** 写入部署目录 state.json（原子写：先写临时文件再改名）。 */
export async function writeState(deployDir: string, state: unknown): Promise<void> {
  const target = join(deployDir, STATE_FILENAME)
  const tmp = `${target}.tmp`
  await fs.mkdir(deployDir, { recursive: true })
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  await fs.rename(tmp, target)
}