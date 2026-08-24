/**
 * dsh-mcp-tunnel — DSH 插件：把本机 MCP server 通过出站-only 隧道栈
 * （mcp-proxy + cloudflared Quick Tunnel，或 anthropic 命名隧道）暴露给远程
 * Agent，并把公开 URL 注册到 `@deepseek-ai/dsh-mcp-client` 的
 * streamable-http 配置（待确认片段，安全护栏 1）。
 *
 * 平台：Host。能力：注册 3 个模型工具
 *   - mcp_tunnel_create : 生成栈 + 证书 + 起容器 + 轮询 URL + 待确认片段
 *   - mcp_tunnel_status : 栈/连接状态 + 最近日志尾部（≤50 行）
 *   - mcp_tunnel_stop   : 停栈 + 下线 URL + 撤销待确认片段 + state.json 写失效标注（保留证书目录）
 *
 * 后台长任务（起容器、等隧道就绪）走 ctx.jobs（tool-jobs 配套流程）；无 jobs
 * 服务时降级为前台执行。docker 缺失时给出清晰前置提示而非崩溃（验收标准 5）。
 *
 * @module dsh-mcp-tunnel
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type JsonValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve, basename } from 'node:path'
import type { JobHooks, JobKindMap } from '@deepseek-ai/dsh-jobs'
import {
  COMPOSE_FILENAME, DOTENV_FILENAME, TRYCLOUDFLARE_URL_PATTERN, TUNNEL_NAME_PATTERN,
  DEFAULT_HOST_PROXY_PORT, CERTS_DIRNAME, readStackPresence, listTunnelDirs, expandHome,
  generateStack, writeStack, readState, writeState, type StackOptions,
} from './tunnel-stack.ts'
import { ensureCerts } from './certs.ts'
import {
  buildFragment, generateToken, writePendingFragment, readPendingFragment, removePendingFragment,
  PENDING_FILENAME,
} from './mcp-client-config.ts'

/** 扩展 jobs 的种类命名空间：本插件的后台任务是 mcp-tunnel。 */
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'mcp-tunnel': 'mcp-tunnel'
  }
}

/** Cordis 插件名。 */
export const name = 'dsh-mcp-tunnel'

/** 必需服务：工具注册表。 */
export const inject = ['tools']

/** 插件配置（cordis.yml config 段）。 */
export interface Config {
  /** 隧道栈部署根目录（每个隧道一个子目录）。 */
  deployRoot: string
  /** 默认隧道提供方。 */
  defaultProvider: 'cloudflare-quick' | 'anthropic'
  /** 容器运行时。 */
  dockerBinary: 'docker' | 'podman'
}

/** Schemastery 校验的 Config。 */
export const Config = z.object({
  deployRoot: z.string().default('~/.dsh/mcp-tunnels'),
  defaultProvider: z.union([z.const('cloudflare-quick'), z.const('anthropic')]).default('cloudflare-quick'),
  dockerBinary: z.union([z.const('docker'), z.const('podman')]).default('docker'),
})

/** 隧道状态（state.json，纯 JSON、无秘密）。 */
export interface TunnelState {
  name: string
  provider: string
  upstreamUrl?: string
  url?: string
  createdAt: string
  updatedAt: string
  lastError?: string
}

/* ------------------------------------------------------------------ */
/* 进程 / docker 辅助                                                   */
/* ------------------------------------------------------------------ */

const execFile = promisify(execFileCb)

/** compose 基础参数（项目名 + 配置文件）。 */
function composeArgs(config: Config, name: string, dir: string): string[] {
  return ['compose', '-p', name, '-f', join(dir, COMPOSE_FILENAME)]
}

/** 收集式执行：返回子进程句柄与收集 stdout/stderr 的 Promise（不算超时）。 */
function runCollect(
  binary: string,
  args: string[],
  opts: { cwd: string; onLine?: (text: string) => void },
): { proc: ReturnType<typeof spawn>; promise: Promise<{ code: number | null; out: string; err: string }> } {
  const child = spawn(binary, args, {
    cwd: opts.cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out: string[] = []
  const err: string[] = []
  const push = (chunk: Buffer, target: string[]): void => {
    const text = chunk.toString()
    target.push(text)
    opts.onLine?.(text)
  }
  child.stdout?.on('data', (chunk: Buffer) => push(chunk, out))
  child.stderr?.on('data', (chunk: Buffer) => push(chunk, err))
  const promise = new Promise<{ code: number | null; out: string; err: string }>((resolveOnce) => {
    child.on('close', (code) => resolveOnce({ code, out: out.join(''), err: err.join('') }))
    child.on('error', (error) => resolveOnce({
      code: null,
      out: out.join(''),
      err: String(error instanceof Error ? error.message : error),
    }))
  })
  return { proc: child, promise }
}

/** 前置检查：容器运行时可用（acceptance 5 —— 缺失时给出清晰提示而非崩溃）。 */
async function checkRuntimeAvailable(binary: string): Promise<void> {
  let version = ''
  try {
    const result = await execFile(binary, ['--version'], { timeout: 8_000 })
    version = String(result.stdout ?? '').trim()
  } catch (error) {
    const code = (error as { code?: string }).code
    const hint = code === 'ENOENT'
      ? `未找到容器运行时“${binary}”。请先安装 Docker（https://docs.docker.com/engine/install/）`
        + `或配置 dockerBinary=podman，再运行 mcp_tunnel_create。`
      : `容器运行时“${binary}”不可用：${String(error instanceof Error ? error.message : error)}。`
        + `请确认 daemon 已启动（例如 docker info 能成功返回）。`
    throw new Error(`dsh-mcp-tunnel 前置检查失败：${hint}`)
  }
  if (!/docker|podman/i.test(version) && version.length > 0) {
    // 兼容自定义别名：存在即可，这里仅做白名单之外的提醒，不阻塞。
    void version
  }
}

/** 在部署目录读取 API_KEY（.env 解析；无则返回 null）。 */
async function readDotenvKey(deployDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(join(deployDir, DOTENV_FILENAME), 'utf8')
    for (const line of raw.split('\n')) {
      const match = /^\s*API_KEY\s*=\s*(.*)\s*$/.exec(line)
      if (match !== null && match[1]!.length > 0) return match[1]!.replace(/^["']|["']$/g, '')
    }
    return null
  } catch {
    return null
  }
}

/** 写 .env（0600），只写 API_KEY 一项，绝不把秘密写进 compose 文件（安全护栏 2）。 */
async function writeDotenv(deployDir: string, token: string): Promise<void> {
  await fs.writeFile(join(deployDir, DOTENV_FILENAME), `# dsh-mcp-tunnel 生成 — 请勿提交版本库\nAPI_KEY=${token}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
}

/* ------------------------------------------------------------------ */
/* 上游解析（.mcp.json / 显式 URL / hello-mcp）                          */
/* ------------------------------------------------------------------ */

export interface McpJsonEntry {
  url?: string
  command?: string
  args?: string[]
  [key: string]: unknown
}

/** 解析 .mcp.json：返回 { url? } 或 { stdio: true, command }。 */
async function resolveFromMcpJson(serverDir: string): Promise<{ url?: string; stdio?: boolean; command?: string }> {
  const file = resolve(serverDir, '.mcp.json')
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpJsonEntry> }
    const entries = Object.values(parsed.mcpServers ?? {})
    const first = entries[0]
    if (first === undefined) return {}
    if (typeof first.url === 'string' && first.url.length > 0) return { url: first.url }
    if (typeof first.command === 'string') return { stdio: true, command: first.command }
    return {}
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') return {}
    throw new Error(`解析 ${file} 失败：${String(error instanceof Error ? error.message : error)}`)
  }
}

/* ------------------------------------------------------------------ */
/* 后台任务 hooks（ctx.jobs 配套）                                      */
/* ------------------------------------------------------------------ */

/** 行缓冲：流式 readOutput + 最近 N 行保留。 */
class LineBuffer {
  private lines: string[] = []
  private cursor = 0
  constructor(private readonly max = 400) {}
  push(text: string): void {
    this.lines.push(text)
    if (this.lines.length > this.max) {
      const drop = this.lines.length - this.max
      this.lines.splice(0, drop)
      this.cursor = Math.max(0, this.cursor - drop)
    }
  }
  readDelta(): string {
    if (this.cursor >= this.lines.length) return ''
    const delta = this.lines.slice(this.cursor).join('')
    this.cursor = this.lines.length
    return delta
  }
  tail(n: number): string {
    return this.lines.slice(-n).join('')
  }
}

/** 轮询 cloudflared 日志直到出现 Quick Tunnel URL（provider=cloudflare-quick）。 */
async function pollTunnelUrl(
  config: Config,
  name: string,
  dir: string,
  buffer: LineBuffer,
  signal: { cancelled: boolean },
  timeoutMs: number,
): Promise<{ url?: string; reason?: string }> {
  const deadline = Date.now() + timeoutMs
  let lastLineCount = 0
  while (!signal.cancelled) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { reason: `等待 Quick Tunnel URL 超时（${Math.round(timeoutMs / 1000)}s）` }
    const { promise } = runCollect(config.dockerBinary, [...composeArgs(config, name, dir), 'logs', '--tail', '300', 'cloudflared'], { cwd: dir })
    const result = await promise
    const combined = result.out + result.err
    const lines = combined.split('\n')
    for (let i = lastLineCount; i < lines.length; i += 1) {
      const line = lines[i]
      if (line !== undefined && line.length > 0) {
        buffer.push(`[cloudflared] ${line}\n`)
      }
    }
    lastLineCount = lines.length
    const match = TRYCLOUDFLARE_URL_PATTERN.exec(combined)
    if (match !== null) return { url: match[0] }
    await sleep(1_000)
  }
  return { reason: 'cancelled' }
}

/** 单次等待（毫秒），供无 jobs 的前台降级与轮询共用以避免重复实现。 */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ */
/* create 核心                                                         */
/* ------------------------------------------------------------------ */

export interface CreateParams {
  name: string
  serverDir?: string
  upstreamUrl?: string
  provider?: 'cloudflare-quick' | 'anthropic'
  deployDir?: string
  useHelloMcp?: boolean
  token?: string
  hostProxyPort?: number
}

export interface CreateResult {
  url?: string
  urlNote?: string
  tunnelDir: string
  pendingFragmentPath?: string
  wroteFiles: string[]
  provider: string
  upstreamUrl: string
  stdioDetected?: boolean
  note?: string
}

/**
 * create 的主流程（可后台可前台）：
 * 1) 解析上游 → 2) 证书（复用 CA） → 3) 生成栈文件 → 4) .env(0600)
 * → 5) 前置检查 docker → 6) compose up → 7) 轮询 URL → 8) 待确认片段 + state。
 */
async function createTunnelCore(
  config: Config,
  params: CreateParams,
  buffer: LineBuffer,
  signal: { cancelled: boolean },
): Promise<CreateResult> {
  if (!TUNNEL_NAME_PATTERN.test(params.name)) {
    throw new Error(`参数 name 非法：必须匹配 ${TUNNEL_NAME_PATTERN.source}（1–32 个 A-Za-z0-9_- 字符）`)
  }
  const provider = params.provider ?? config.defaultProvider
  const deployRoot = expandHome(config.deployRoot)
  const tunnelDir = params.deployDir !== undefined ? resolve(params.deployDir) : join(deployRoot, params.name)

  // 1) 上游解析：显式 URL > .mcp.json(url) > .mcp.json(stdio, 提示) > hello-mcp。
  let upstreamUrl = params.upstreamUrl
  let stdioDetected: boolean | undefined
  if (upstreamUrl === undefined && params.serverDir !== undefined) {
    const spec = await resolveFromMcpJson(params.serverDir)
    if (spec.url !== undefined) {
      upstreamUrl = spec.url
    } else if (spec.stdio === true) {
      stdioDetected = true
      throw new Error(
        `serverDir 中的 .mcp.json 声明的是 stdio 命令（${spec.command ?? '?'}），`
        + '隧道只能暴露 HTTP(S) MCP 端点：请先用任意 stdio→HTTP 网关在宿主机/容器内把它'
        + '转成 streamable-http 或 SSE 端点，再传 upstreamUrl；或让 create 使用内置 hello-mcp'
        + ' 示例（useHelloMcp=true，仅测试）。本版本不自动桥接 stdio（见 README 限制）。',
      )
    }
  }
  const useHelloMcp = params.useHelloMcp ?? (upstreamUrl === undefined)
  if (upstreamUrl === undefined) {
    upstreamUrl = 'http://hello-mcp:8000/sse'
  }

  // 2) 证书：CA 存在即复用（验收标准 3）。
  const certsDir = join(tunnelDir, CERTS_DIRNAME)
  await ensureCerts({ dir: certsDir })

  // 3) 栈文件。
  const port = params.hostProxyPort ?? DEFAULT_HOST_PROXY_PORT
  const stackOptions: StackOptions = {
    projectName: params.name,
    provider,
    hostProxyPort: port,
    externalHostname: provider === 'cloudflare-quick' ? `${params.name}.trycloudflare.com` : `${params.name}.tunnel.local`,
    upstreamUrl,
    useHelloMcp,
    tunnelName: params.name,
  }
  const files = generateStack(stackOptions)
  const wroteFiles = await writeStack(tunnelDir, files)

  // 4) 访问令牌：优先传入值，其次复用 .env，否则新生成；写 .env(0600)。
  const token = params.token ?? (await readDotenvKey(tunnelDir)) ?? generateToken()
  await writeDotenv(tunnelDir, token)
  buffer.push(`[create] 凭证已写入 ${tunnelDir}/.env（0600；证书目录 certs/）\n`)

  // 5) 前置检查（验收标准 5）。
  await checkRuntimeAvailable(config.dockerBinary)

  // 6) 起栈。
  buffer.push(`[create] 启动容器栈 ${params.name}（provider=${provider}）\n`)
  const up = runCollect(config.dockerBinary, [...composeArgs(config, params.name, tunnelDir), 'up', '-d', '--build'], { cwd: tunnelDir, onLine: (t) => buffer.push(t) })
  const upResult = await up.promise
  if (upResult.code !== 0) {
    throw new Error(
      `docker compose up 失败（exit ${String(upResult.code ?? '信号')}）：\n${(upResult.err + upResult.out).slice(-2000)}`,
    )
  }
  buffer.push('[create] 容器已启动，等待 cloudflared 隧道就绪…\n')

  // 7) 轮询 URL（仅 quick 模式；anthropic 命名隧道由用户 DNS 决定）。
  let url: string | undefined
  let urlNote: string | undefined
  if (provider === 'cloudflare-quick' && !signal.cancelled) {
    const polled = await pollTunnelUrl(config, params.name, tunnelDir, buffer, signal, 180_000)
    url = polled.url
    urlNote = polled.reason
  } else if (provider === 'anthropic') {
    urlNote = '命名隧道模式：公开 URL 取决于你的 Cloudflare 域名/DNS 配置，不在日志轮询范围内。'
  }

  if (signal.cancelled) {
    throw new Error('mcp_tunnel_create 已取消')
  }

  // 8) 待确认片段 + state。
  let pendingFragmentPath: string | undefined
  if (url !== undefined) {
    const fragment = buildFragment(params.name, url, token)
    pendingFragmentPath = await writePendingFragment(tunnelDir, fragment)
    buffer.push(`[create] URL 就绪：${url}\n`)
    buffer.push(`[create] 待确认 mcp-client 片段：${pendingFragmentPath}（需用户显式确认后粘贴进 profile）\n`)
  }
  await writeState(tunnelDir, {
    name: params.name,
    provider,
    upstreamUrl,
    url,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(urlNote !== undefined ? { lastError: urlNote } : {}),
  } satisfies TunnelState)

  return {
    url,
    urlNote,
    tunnelDir,
    pendingFragmentPath,
    wroteFiles,
    provider,
    upstreamUrl,
    ...(stdioDetected !== undefined ? { stdioDetected } : {}),
  }
}

/* ------------------------------------------------------------------ */
/* 工具装配                                                            */
/* ------------------------------------------------------------------ */

/** 后台执行封装：有 jobs 时注册为 mcp-tunnel 任务，否则前台执行。 */
function runTunnelTask(
  ctx: Context,
  _config: Config,
  label: string,
  owner: unknown,
  run: (buffer: LineBuffer, signal: { cancelled: boolean }) => Promise<{ status: 'completed' | 'failed'; detail?: string; note?: string }>,
): { jobId?: string; task: Promise<{ status: 'completed' | 'failed'; detail?: string; note?: string }> } {
  const jobs = ctx.get('jobs')
  if (jobs === undefined) {
    const buffer = new LineBuffer()
    const signal = { cancelled: false }
    return { task: run(buffer, signal) }
  }
  // 与 tool-bash 相同的后台形态：同步注册任务并返回 jobId。
  const jobId = jobs.start({
    kind: 'mcp-tunnel',
    label,
    ...(owner !== undefined ? { owner: owner as never } : {}),
    run: (): JobHooks => {
      const buffer = new LineBuffer()
      const signal = { cancelled: false }
      let interval: ReturnType<typeof setInterval> | undefined
      const done = (async (): Promise<{ status: 'completed' | 'failed' | 'killed'; detail?: string }> => {
        try {
          const outcome = await run(buffer, signal)
          // 终态结果也写进输出流，后台模式下 agent 用 job_output 即可拿到结构化结果。
          buffer.push(`${outcome.note ?? outcome.detail ?? 'mcp-tunnel 任务完成'}\n`)
          return outcome.status === 'completed'
            ? { status: 'completed', detail: outcome.detail }
            : { status: 'failed', detail: outcome.detail ?? 'mcp-tunnel 任务失败' }
        } catch (error) {
          buffer.push(`[mcp-tunnel] 失败：${String(error instanceof Error ? error.message : error)}\n`)
          return { status: 'failed', detail: String(error instanceof Error ? error.message : error) }
        } finally {
          if (interval !== undefined) clearInterval(interval)
        }
      })()
      return {
        cancel: (reason?: string) => {
          signal.cancelled = true
          void reason
        },
        done,
        readOutput: () => buffer.readDelta(),
      }
    },
  })
  return { jobId, task: Promise.resolve({ status: 'completed' as const }) }
}

/** 构建本插件的 3 个工具定义。 */
function buildTools(ctx: Context, config: Config): ToolDefinition[] {
  const textRender = (_a: unknown, value: unknown) => [
    { type: 'text' as const, text: JSON.stringify(value, null, 2) },
  ]

  const createTool = defineTool({
    name: 'mcp_tunnel_create',
    description: [
      '把本机 MCP server 暴露给远程 Agent：生成 mcp-proxy + cloudflared 的 Docker Compose 栈',
      '（免账号 Cloudflare Quick Tunnel，或 anthropic 命名隧道），生成/复用自签证书，',
      '后台起容器并轮询出公开 HTTPS URL，然后生成 dsh-mcp-client 的 streamable-http',
      '「待确认片段」写入部署目录（需用户显式确认后才粘贴进 profile，绝不自动改写配置）。',
      '本机无任何公网监听端口（仅绑定 127.0.0.1 回环调试端口）。',
    ].join(''),
    parameters: {
      name: { type: 'string', required: true, description: '隧道名（同时作为 dsh-mcp-client 的 serverName 与 compose 项目名；1–32 个 A-Za-z0-9_- 字符）' },
      serverDir: { type: 'string', description: 'MCP server 目录：优先读取其中的 .mcp.json（取首个含 url 的条目作为上游；stdio command 需要先转成 HTTP 端点）' },
      upstreamUrl: { type: 'string', description: '直接指定上游 MCP 端点（http/https），优先级高于 serverDir 的 .mcp.json' },
      provider: { type: 'string', enum: ['cloudflare-quick', 'anthropic'], description: '隧道提供方；默认 cloudflare-quick（免账号）' },
      deployDir: { type: 'string', description: '部署目录（默认 <deployRoot>/<name>）' },
      useHelloMcp: { type: 'boolean', description: '无上游时使用内置 hello-mcp 示例 server（echo/uptime 工具）；默认自动' },
      token: { type: 'string', description: '自定义访问令牌（Authorization: Bearer <token>）；缺省自动生成 32 字节随机令牌写 .env' },
      hostProxyPort: { type: 'integer', description: '宿主回环调试端口（默认 43180，只绑定 127.0.0.1）' },
    },
    output: {
      schema: { type: 'json' },
      render: textRender,
    },
    async execute(args, exec) {
      const params = args as unknown as CreateParams
      const job = runTunnelTask(ctx, config, `mcp_tunnel_create ${params.name}`, exec.agent, async (b, s) => {
        const result = await createTunnelCore(config, params, b, s)
        return { status: 'completed' as const, note: JSON.stringify(result, null, 2) }
      })
      if (job.jobId !== undefined) {
        return { kind: 'background', jobId: job.jobId, note: '后台启动中：用 job_output 读取进度，终态输出含公开 URL 与待确认片段路径。' } as JsonValue
      }
      const outcome = await job.task
      if (outcome.note !== undefined) {
        return { kind: 'foreground', ...(JSON.parse(outcome.note) as Record<string, JsonValue>) } as JsonValue
      }
      return { kind: 'foreground', note: outcome.detail ?? 'mcp_tunnel_create 完成（无输出）' } as JsonValue
    },
  })

  const statusTool = defineTool({
    name: 'mcp_tunnel_status',
    description: '列出全部隧道栈的连接状态：compose 容器状态、公开 URL、最近日志尾部（≤50 行）、待确认的 mcp-client 片段。',
    parameters: {
      name: { type: 'string', description: '隧道名；缺省列出部署根目录下全部隧道' },
    },
    output: {
      schema: { type: 'json' },
      render: textRender,
    },
    async execute(args) {
      const name = (args as { name?: string }).name
      const deployRoot = expandHome(config.deployRoot)
      const names = name !== undefined && name.length > 0
        ? (TUNNEL_NAME_PATTERN.test(name) ? [name] : [sanitizeForStatus(name)])
        : await listTunnelDirs(deployRoot)
      const rows: Record<string, JsonValue>[] = []
      for (const tunnelName of names) {
        const dir = join(deployRoot, tunnelName)
        const state = await readState<TunnelState>(dir)
        const presence = await readStackPresence(dir)
        let compose: JsonValue = null
        let logsTail: string[] = []
        if (presence.composePresent) {
          try {
            await checkRuntimeAvailable(config.dockerBinary)
            const ps = runCollect(config.dockerBinary, [...composeArgs(config, tunnelName, dir), 'ps'], { cwd: dir })
            const psResult = await ps.promise
            compose = {
              exitCode: psResult.code,
              output: (psResult.out + psResult.err).trim().slice(0, 2000),
            } as unknown as JsonValue
            const logs = runCollect(
              config.dockerBinary,
              [...composeArgs(config, tunnelName, dir), 'logs', '--tail', '50', 'cloudflared'],
              { cwd: dir },
            )
            const logsResult = await logs.promise
            logsTail = (logsResult.out + logsResult.err).split('\n').filter(Boolean).slice(-50)
          } catch (error) {
            compose = String(error instanceof Error ? error.message : error) as JsonValue
          }
        }
        const pending = await readPendingFragment(dir)
        rows.push({
          name: tunnelName,
          deployDir: dir,
          state: state as unknown as JsonValue,
          files: presence as unknown as JsonValue,
          compose,
          logsTail: logsTail as unknown as JsonValue,
          pendingFragment: pending !== null
            ? { serverName: pending.serverName, url: pending.url, file: PENDING_FILENAME }
            : null,
        })
      }
      return { tunnels: rows } as JsonValue
    },
  })

  const stopTool = defineTool({
    name: 'mcp_tunnel_stop',
    description: '停止隧道：docker compose down 停栈并下线公开 URL，删除待确认的 mcp-client 片段，保留证书目录供下次 create 复用（keepCerts=true 默认）。',
    parameters: {
      name: { type: 'string', required: true, description: '隧道名（对应 create 时的 name / 部署目录名）' },
      keepCerts: { type: 'boolean', description: '是否保留证书目录（默认 true；false 时删除 certs/）' },
    },
    output: {
      schema: { type: 'json' },
      render: textRender,
    },
    async execute(args) {
      const { name: tunnelName, keepCerts = true } = args as { name: string; keepCerts?: boolean }
      if (!TUNNEL_NAME_PATTERN.test(tunnelName)) {
        throw new Error(`参数 name 非法：必须匹配 ${TUNNEL_NAME_PATTERN.source}`)
      }
      const deployRoot = expandHome(config.deployRoot)
      const dir = join(deployRoot, tunnelName)
      const presence = await readStackPresence(dir)
      if (!presence.composePresent && !presence.statePresent && !presence.dotenvPresent) {
        return { stopped: false, note: `部署目录 ${dir} 不存在或为空 — 没有可停的隧道。` } as JsonValue
      }
      const steps: string[] = []
      if (presence.composePresent) {
        await checkRuntimeAvailable(config.dockerBinary)
        const down = runCollect(config.dockerBinary, [...composeArgs(config, tunnelName, dir), 'down'], { cwd: dir })
        const result = await down.promise
        if (result.code !== 0) {
          throw new Error(`docker compose down 失败（exit ${String(result.code ?? '信号')}）：\n${(result.err + result.out).slice(-1000)}`)
        }
        steps.push(`已执行 docker compose down（URL 下线）`)
      }
      const removedPending = await removePendingFragment(dir)
      if (removedPending) steps.push(`已移除待确认片段 ${PENDING_FILENAME}`)
      // 验收标准 4：stop 不整文件删除 state.json —— 把最后状态保留为「失效标注」
      // （url 下线 + lastError），status 可读 state.lastError 看到已停标注。
      const state = await readState<TunnelState>(dir)
      if (state !== null) {
        const stoppedAt = new Date().toISOString()
        await writeState(dir, {
          ...state,
          url: undefined,
          updatedAt: stoppedAt,
          lastError: `隧道已于 ${stoppedAt} 由 mcp_tunnel_stop 停止：URL 已下线、待确认片段已移除（state.json 保留为失效标注，status 可见）`,
        } satisfies TunnelState)
        steps.push('已写入 state.json 失效标注（lastError，status 可见）')
      }
      if (keepCerts === false) {
        await fs.rm(join(dir, CERTS_DIRNAME), { recursive: true, force: true })
        steps.push('已删除证书目录（keepCerts=false）')
      } else {
        steps.push(`证书目录 certs/ 已保留，下次 create 复用（验收标准 3/4）`)
      }
      return { stopped: true, name: tunnelName, steps } as JsonValue
    },
  })

  return [createTool, statusTool, stopTool]
}

/** status 用：非法 name 时退化为目录名匹配（仅提示），不抛错。 */
function sanitizeForStatus(name: string): string {
  return basename(name).replace(/[^A-Za-z0-9_-]/g, '-')
}

/** Cordis apply：注册 3 个工具（卸载时自动注销）。 */
export function apply(ctx: Context, config: Config): void {
  for (const definition of buildTools(ctx, config)) {
    ctx.effect(() => ctx.tools.register(definition))
  }
}