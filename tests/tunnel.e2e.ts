/**
 * dsh-mcp-tunnel — 真栈 e2e 测试（有 docker + 公网环境时运行）。
 *
 * 流程（对齐验收标准 1/2/4/5）：
 *   1. 用真实模板生成 hello-mcp 示例栈 + 真实自签证书 + .env；
 *   2. docker compose up -d（无 docker 时给清晰提示并跳过）；
 *   3. 轮询 cloudflared 日志拿到 Quick Tunnel 公开 URL（本机无公网监听端口）；
 *   4. 远程侧形态验证：带 Authorization 头的请求打到公开 URL 可达；
 *   5. down 停栈 → URL 不可达、待确认片段被移除（验收标准 4）。
 *
 * 完整 MCP echo 工具调用（验收标准 2）需 @modelcontextprotocol/sdk 客户端，
 * 这里用原始 SSE 端点往返验证接入面；启用方式：
 *   DSH_MCP_TUNNEL_E2E=1 node --test tests/tunnel.e2e.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateStack, writeStack, COMPOSE_FILENAME, TRYCLOUDFLARE_URL_PATTERN } from '../src/tunnel-stack.ts'
import { ensureCerts } from '../src/certs.ts'
import { buildFragment, writePendingFragment, removePendingFragment, readPendingFragment } from '../src/mcp-client-config.ts'

const PROJECT = 'e2e-tunnel'
const HOST_PORT = 44180

async function dockerOk(): Promise<{ ok: boolean; reason: string }> {
  const probe = spawnSync('docker', ['info'], { timeout: 10_000, encoding: 'utf8' })
  if (probe.error !== undefined) {
    const code = (probe.error as { code?: string }).code
    return { ok: false, reason: code === 'ENOENT' ? '未找到 docker（前置提示，非崩溃，验收标准 5）' : `docker 不可用：${code}` }
  }
  if (probe.status !== 0) return { ok: false, reason: `docker daemon 未就绪（exit ${String(probe.status)}）：${(probe.stderr ?? '').slice(0, 200)}` }
  return { ok: true, reason: '' }
}

const enabled = process.env.DSH_MCP_TUNNEL_E2E === '1'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 预检：是否启用 + docker 是否可用（eager，注册前算好 skip 理由）。 */
async function preflightSkip(): Promise<string | false> {
  if (!enabled) return '未启用：设 DSH_MCP_TUNNEL_E2E=1 才运行（会访问公网 Cloudflare 边缘）'
  const probe = await dockerOk()
  if (!probe.ok) return probe.reason
  return false
}

function runCollect(binary: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolveOnce) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout?.on('data', (c: Buffer) => { out += c.toString() })
    child.stderr?.on('data', (c: Buffer) => { err += c.toString() })
    child.on('close', (code) => resolveOnce({ code, out, err }))
    child.on('error', (error) => resolveOnce({ code: null, out, err: String(error instanceof Error ? error.message : error) }))
  })
}

const skipReason = await preflightSkip()

test('tunnel.e2e: 真栈（Quick Tunnel 公开 URL + 停止失效 + 片段移除）', { skip: skipReason }, async (t) => {
  const deployDir = await fs.mkdtemp(join(tmpdir(), 'tunnel-e2e-'))
  const composeArgs = (name: string) => ['compose', '-p', name, '-f', join(deployDir, COMPOSE_FILENAME)]

  try {
    // 1) 栈 + 证书 + .env（与插件 create 主流程一致，仅复用纯模块）
    await ensureCerts({ dir: join(deployDir, 'certs') })
    const files = generateStack({
      projectName: PROJECT,
      provider: 'cloudflare-quick',
      hostProxyPort: HOST_PORT,
      externalHostname: `${PROJECT}.trycloudflare.com`,
      upstreamUrl: 'http://hello-mcp:8000/sse',
      useHelloMcp: true,
    })
    await writeStack(deployDir, files)
    await fs.writeFile(join(deployDir, '.env'), `API_KEY=${'a'.repeat(64)}\n`, { mode: 0o600 })

    // 2) up：真容器栈（mcp-proxy + cloudflared + hello-mcp）
    const up = await runCollect('docker', [...composeArgs(PROJECT), 'up', '-d', '--build'])
    assert.equal(up.code, 0, `compose up 失败：\n${(up.err + up.out).slice(-1200)}`)

    // 3) 轮询公开 URL（≤240s）
    let url: string | undefined
    const deadline = Date.now() + 240_000
    while (url === undefined && Date.now() < deadline) {
      const logs = await runCollect('docker', [...composeArgs(PROJECT), 'logs', '--tail', '300', 'cloudflared'])
      const match = TRYCLOUDFLARE_URL_PATTERN.exec(logs.out + logs.err)
      if (match !== null) url = match[0]
      else await sleep(2000)
    }
    assert.ok(url !== undefined, '240s 内未拿到 Quick Tunnel URL')
    t.diagnostic(`公开 URL：${url}`)

    // 4) 远程侧形态：带 Authorization 的 GET 打到 SSE 接入面（模拟远程 dsh-mcp-client）
    await t.test('公开 URL 可达且接受带鉴权头的请求', { timeout: 60_000 }, async () => {
      const res = await fetch(url!, {
        headers: { Accept: 'text/event-stream', Authorization: 'Bearer ' + 'a'.repeat(64) },
        signal: AbortSignal.timeout(30_000),
      })
      assert.ok(res.status === 200 || res.status === 202, `SSE 接入面返回 ${res.status}`)
      assert.match(String(res.headers.get('content-type') ?? ''), /text|json|stream/, '响应为流式/JSON 接入面')
    })

    // 待确认片段（create 的产出物之一）
    const fragment = buildFragment(PROJECT, url, 'a'.repeat(64))
    await writePendingFragment(deployDir, fragment)
    assert.ok((await readPendingFragment(deployDir)) !== null)

    // 5) 停栈：down + 移除片段 + URL 失效（验收标准 4）
    const down = await runCollect('docker', [...composeArgs(PROJECT), 'down'])
    assert.equal(down.code, 0, `compose down 失败：\n${(down.err + down.out).slice(-800)}`)
    await t.test('停栈后片段被移除、URL 失效', { timeout: 60_000 }, async () => {
      assert.equal(await removePendingFragment(deployDir), true)
      assert.equal(await readPendingFragment(deployDir), null)
      try {
        await fetch(url!, { signal: AbortSignal.timeout(15_000) })
        assert.fail('停栈后公开 URL 仍可达（不应如此）')
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error)
        assert.ok(/fetch failed|terminated|ECONNREFUSED|ETIMEDOUT|502|503|521|522|error/i.test(message), `应连接失败，实为：${message}`)
      }
    })
  } finally {
    await runCollect('docker', [...composeArgs(PROJECT), 'down']).catch(() => undefined)
  }
})