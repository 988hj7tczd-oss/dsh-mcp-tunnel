/**
 * dsh-mcp-tunnel — 离线冒烟测试（node:test，无需 docker / 网络）。
 *
 * 覆盖：迷你模板渲染器、栈生成（文件集合 + 内容不变量：仅回环绑定、
 * 出站-only、无秘密落盘）、mcp-client 片段校验/序列化/待确认往返、
 * 证书复用（真实 openssl，不可用时跳过）。
 *
 * 运行：node --test tests/tunnel.smoke.ts （Node ≥ 23.6 原生 TS 即可；22.x 需 --experimental-strip-types）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  renderTemplate, generateStack, writeStack, DEFAULT_HOST_PROXY_PORT,
  TUNNEL_NAME_PATTERN, expandHome, TRYCLOUDFLARE_URL_PATTERN,
  readState, writeState,
} from '../src/tunnel-stack.ts'
import {
  buildFragment, validateServerName, fragmentToPatchYaml, writePendingFragment,
  readPendingFragment, removePendingFragment, generateToken, PENDING_FILENAME,
  MCP_CLIENT_PACKAGE,
} from '../src/mcp-client-config.ts'
import { ensureCerts, caExists, serverCertExists, CA_KEY_FILENAME } from '../src/certs.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const projectRoot = join(here, '..')

/* ------------------------------------------------------------------ */
/* 迷你模板渲染器                                                      */
/* ------------------------------------------------------------------ */

test('renderTemplate: 插值 + if/else + 嵌套', () => {
  const out = renderTemplate('a={{x}} {{#if on}}yes{{else}}no{{/if}} {{#if off}}X{{else}}N{{/if}} {{#if on}}{{#if deep}}d{{/if}}{{/if}}', {
    x: '1', on: true, off: false, deep: true,
  })
  assert.equal(out, 'a=1 yes N d')
})

test('renderTemplate: 缺变量抛错（防静默生成坏配置）', () => {
  assert.throws(() => renderTemplate('{{missing}}', {}), /missing variable "missing"/)
})

test('renderTemplate: if 缺变量视为假，但不抛错', () => {
  assert.equal(renderTemplate('{{#if ghost}}x{{else}}y{{/if}}', {}), 'y')
})

test('renderTemplate: 未闭合块抛错', () => {
  assert.throws(() => renderTemplate('{{#if a}}x', { a: true }), /missing/)
})

/* ------------------------------------------------------------------ */
/* 栈生成                                                              */
/* ------------------------------------------------------------------ */

test('generateStack: 默认 quick + hello-mcp 全套文件', () => {
  const files = generateStack({
    projectName: 'demo-tunnel',
    provider: 'cloudflare-quick',
    hostProxyPort: DEFAULT_HOST_PROXY_PORT,
    externalHostname: 'demo-tunnel.trycloudflare.com',
    upstreamUrl: 'http://hello-mcp:8000/sse',
    useHelloMcp: true,
  })
  const names = Object.keys(files)
  for (const required of ['docker-compose.yml', 'proxy-config.env', '.env.example', 'README.stack.md']) {
    assert.ok(names.includes(required), `缺少 ${required}`)
  }
  assert.ok(names.includes('hello-mcp/Dockerfile'), '缺少 hello-mcp/Dockerfile')
  assert.ok(names.includes('hello-mcp/server.py'), '缺少 hello-mcp/server.py')

  const compose = files['docker-compose.yml']!
  assert.ok(compose.includes('name: demo-tunnel'), 'compose 项目名')
  assert.ok(compose.includes('network_mode: service:mcp-proxy'), 'cloudflared 共享网络命名空间（出站-only）')
  assert.ok(compose.includes('127.0.0.1:43180:80'), '仅回环端口绑定')
  assert.ok(!compose.includes('0.0.0.0:'), '不得出现公网端口绑定')
  assert.ok(!/ports:[\s\S]{0,120}0\.0\.0\.0/.test(compose), 'ports 段不得含 0.0.0.0')
  assert.ok(compose.includes('service_started'), 'cloudflared 用 service_started 依赖')
  assert.ok(compose.includes('command: [\'tunnel\', \'--no-autoupdate\''), 'quick tunnel 命令')
  assert.ok(compose.includes('${API_KEY:?set API_KEY in .env'), 'compose 引用 .env 密钥（不直写秘密）')
  // 秘密不得进入 compose / 环境文件
  assert.ok(!compose.includes('Bearer '), 'compose 不得含令牌')
  const env = files['proxy-config.env']!
  assert.ok(env.includes('UPSTREAM_MCP_URL=http://hello-mcp:8000/sse'), 'env 含上游地址')
  assert.ok(!env.includes('API_KEY='), 'proxy-config.env 不含秘密')
  // .env.example 只含占位
  assert.ok(files['.env.example']!.includes('change-me-mcp-access-token'), '.env.example 为占位令牌')
})

test('generateStack: 无 hello-mcp 时不含示例服务；anthropic 走命名隧道分支', () => {
  const files = generateStack({
    projectName: 'prod-tunnel',
    provider: 'anthropic',
    hostProxyPort: 43222,
    externalHostname: 'prod-tunnel.tunnel.local',
    upstreamUrl: 'https://10.0.0.5:8443/mcp',
    useHelloMcp: false,
  })
  const compose = files['docker-compose.yml']!
  assert.ok(!compose.includes('hello-mcp:'), '无示例服务（注：文件头注释允许出现 hello-mcp 字样）')
  assert.ok(!compose.includes('trycloudflare.com'), 'anthropic 模式无 quick URL 引用')
  assert.ok(compose.includes('--config'), '命名隧道配置段落存在')
  assert.ok(compose.includes('127.0.0.1:43222:80'), '自定义回环端口生效')
  assert.ok(!compose.includes('--url'), 'anthropic 模式无 quick --url')
  assert.ok(files['proxy-config.env']!.includes('UPSTREAM_MCP_URL=https://10.0.0.5:8443/mcp'))
})

test('generateStack: 非法输入抛错', () => {
  assert.throws(
    () => generateStack({
      projectName: 'bad name!', provider: 'cloudflare-quick', hostProxyPort: 43180,
      externalHostname: 'x', upstreamUrl: 'http://x/sse', useHelloMcp: false,
    }),
    /invalid project name/,
  )
  assert.throws(
    () => generateStack({
      projectName: 'ok-name', provider: 'cloudflare-quick', hostProxyPort: 99999,
      externalHostname: 'x', upstreamUrl: 'http://x/sse', useHelloMcp: false,
    }),
    /hostProxyPort out of range/,
  )
  assert.throws(
    () => generateStack({
      projectName: 'ok-name', provider: 'cloudflare-quick', hostProxyPort: 43180,
      externalHostname: 'x', upstreamUrl: 'not-a-url', useHelloMcp: false,
    }),
    /upstreamUrl must be an http\(s\) URL/,
  )
})

test('writeStack: 落盘并返回相对路径', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'tunnel-stack-'))
  const files = generateStack({
    projectName: 'w-stack', provider: 'cloudflare-quick', hostProxyPort: 43180,
    externalHostname: 'w-stack.trycloudflare.com', upstreamUrl: 'http://hello-mcp:8000/sse', useHelloMcp: true,
  })
  const written = await writeStack(dir, files)
  assert.deepEqual(written.slice().sort(), Object.keys(files).sort())
  const composeOnDisk = await fs.readFile(join(dir, 'docker-compose.yml'), 'utf8')
  assert.ok(composeOnDisk.includes('name: w-stack'))
})

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

test('TUNNEL_NAME_PATTERN / 约束与展开', () => {
  assert.ok(TUNNEL_NAME_PATTERN.test('demo-tunnel_1'))
  assert.ok(!TUNNEL_NAME_PATTERN.test('bad name'))
  assert.ok(!TUNNEL_NAME_PATTERN.test('a'.repeat(33)))
  const home = expandHome('~')
  assert.ok(home.length > 0 && !home.includes('~'))
  assert.ok(expandHome('~/x') === join(home, 'x'))
  assert.equal(expandHome('/abs/path'), '/abs/path')
})

test('TRYCLOUDFLARE_URL_PATTERN 匹配 cloudflared 日志行', () => {
  const log = 'Your quick tunnel has been created! Visit it at (it may take some time to be reachable):\nhttps://tunnel-abc123.trycloudflare.com'
  const match = TRYCLOUDFLARE_URL_PATTERN.exec(log)
  assert.ok(match !== null)
  assert.equal(match[0], 'https://tunnel-abc123.trycloudflare.com')
})

/* ------------------------------------------------------------------ */
/* mcp-client 配置片段                                                  */
/* ------------------------------------------------------------------ */

test('buildFragment / validateServerName', () => {
  assert.equal(validateServerName('hello-world'), null)
  assert.equal(validateServerName('HELLO_1'), null)
  assert.ok(validateServerName('bad name') !== null)
  assert.ok(validateServerName('a'.repeat(33)) !== null)
  assert.ok(validateServerName('中文') !== null)

  const fragment = buildFragment('demo', 'https://x.trycloudflare.com/sse', 'tok123')
  assert.equal(fragment.transport, 'streamable-http')
  assert.equal(fragment.serverName, 'demo')
  assert.equal(fragment.headers.Authorization, 'Bearer tok123')
  assert.equal(fragment.toolCallTimeoutMs, 60_000)
  assert.equal(fragment.failOnStartupError, false)
  assert.throws(() => buildFragment('bad name', 'https://x/sse', 't'), /invalid serverName/)
  assert.throws(() => buildFragment('ok', 'ftp://x', 't'), /must be http/)
})

test('generateToken: 64 位 hex', () => {
  const token = generateToken()
  assert.match(token, /^[0-9a-f]{64}$/)
  assert.notEqual(token, generateToken())
})

test('fragmentToPatchYaml: 结构对齐 dsh-mcp-client 配置', () => {
  const yaml = fragmentToPatchYaml(buildFragment('demo', 'https://x.trycloudflare.com/sse', 'tok123'), 'mcp-demo')
  assert.ok(yaml.includes(MCP_CLIENT_PACKAGE))
  assert.ok(yaml.includes('id: mcp-demo'))
  assert.ok(yaml.includes('serverName: demo'))
  assert.ok(yaml.includes('transport: streamable-http'))
  assert.ok(yaml.includes("url: 'https://x.trycloudflare.com/sse'"), '含冒号的 url 值应被单引号包裹')
  assert.ok(yaml.includes("Authorization: 'Bearer tok123'"), '含空格的 header 值应被单引号包裹')
})

test('待确认片段写入/读取/移除往返（安全护栏 1 的落盘形态）', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'tunnel-pending-'))
  const fragment = buildFragment('demo', 'https://x.trycloudflare.com/sse', 'tok123')
  const path = await writePendingFragment(dir, fragment)
  assert.ok(path.endsWith(PENDING_FILENAME))
  const read = await readPendingFragment(dir)
  assert.ok(read !== null)
  assert.equal(read!.serverName, 'demo')
  assert.equal(read!.url, 'https://x.trycloudflare.com/sse')
  assert.equal(read!.headers.Authorization, 'Bearer tok123')
  assert.equal(await removePendingFragment(dir), true)
  assert.equal(await readPendingFragment(dir), null)
  assert.equal(await removePendingFragment(dir), false)
})

/* ------------------------------------------------------------------ */
/* 证书复用（真实 openssl；缺失时跳过）                                  */
/* ------------------------------------------------------------------ */

const opensslOk = spawnSync('openssl', ['version']).status === 0

test('certs: 生成 + 二次调用复用 CA（验收标准 3）', { skip: opensslOk ? false : 'openssl 不可用' }, async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'tunnel-certs-'))
  const first = await ensureCerts({ dir })
  for (const p of [first.caCrt, first.caKey, first.serverCrt, first.serverKey, first.serverCsr]) {
    assert.ok((await fs.stat(p)).isFile(), `缺少 ${p}`)
  }
  assert.equal(await caExists(dir), true)
  assert.equal(await serverCertExists(dir), true)

  const caKeyBefore = await fs.readFile(first.caKey, 'utf8')
  const caCrtBefore = await fs.readFile(first.caCrt, 'utf8')
  const serverCrtBefore = await fs.readFile(first.serverCrt, 'utf8')

  // 二次 create：复用既有 CA 与 server 证书，不重新生成。
  const second = await ensureCerts({ dir })
  assert.equal(second.caKey, first.caKey)
  assert.equal(await fs.readFile(second.caKey, 'utf8'), caKeyBefore, 'CA 私钥未重新生成')
  assert.equal(await fs.readFile(second.caCrt, 'utf8'), caCrtBefore, 'CA 证书未重新生成')
  assert.equal(await fs.readFile(second.serverCrt, 'utf8'), serverCrtBefore, 'server 证书未重新生成')

  // 私钥权限应由 certs.ts 生成后立即收紧为 0600（不再由测试手工修补掩盖）。
  // 选择：openssl 按 umask 落盘（通常 0644），chmod 必须在生成路径内完成。
  for (const keyPath of [first.caKey, first.serverKey]) {
    const mode = (await fs.stat(keyPath)).mode & 0o777
    assert.equal(mode, 0o600, `${keyPath} 私钥权限应为 0600`)
  }
})

/* ------------------------------------------------------------------ */
/* state.json 失效标注（验收标准 4：stop 保留 state + lastError）         */
/* ------------------------------------------------------------------ */

test('state.json 承载 stop 失效标注（url 下线 + lastError，验收标准 4）', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'tunnel-state-'))
  // 初始状态：create 落盘的 state.json（含公开 URL）。
  await writeState(dir, {
    name: 'mark-tunnel',
    provider: 'cloudflare-quick',
    url: 'https://live.trycloudflare.com',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
  // stop 路径（index.ts）：不整文件删除 state.json，而是重写为失效标注。
  const stoppedAt = '2026-01-01T00:05:00.000Z'
  await writeState(dir, {
    name: 'mark-tunnel',
    provider: 'cloudflare-quick',
    url: undefined,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: stoppedAt,
    lastError: `隧道已于 ${stoppedAt} 由 mcp_tunnel_stop 停止：URL 已下线、待确认片段已移除（state.json 保留为失效标注，status 可见）`,
  })
  const state = await readState<{ url?: string; lastError?: string; updatedAt?: string }>(dir)
  assert.ok(state !== null, 'stop 后 state.json 仍存在（status 可读失效标注）')
  assert.ok(!('url' in state!), '失效标注写入后不再携带 url 字段（URL 已下线）')
  assert.ok(state!.lastError !== undefined && state!.lastError.includes('mcp_tunnel_stop'), 'lastError 含 stop 标注')
  assert.equal(state!.updatedAt, stoppedAt, 'updatedAt 更新为 stop 时刻')
})

/* ------------------------------------------------------------------ */
/* 元信息 sanity：模板文件确实随包存在                                    */
/* ------------------------------------------------------------------ */

test('templates 文件与交付物清单一致', async () => {
  for (const file of ['docker-compose.yml.hbs', 'proxy-config.env.hbs']) {
    await assert.doesNotReject(fs.access(join(projectRoot, 'templates', file)))
  }
})

test('README 声明安全模型要点（对齐上游 security model）', async () => {
  const readme = await fs.readFile(join(projectRoot, 'README.md'), 'utf8')
  assert.ok(readme.includes('安全模型'), 'README 含安全模型章节')
  assert.ok(/production|生产|鉴权/.test(readme), 'README 提示生产需鉴权')
})