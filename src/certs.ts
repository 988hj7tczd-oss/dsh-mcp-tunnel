/**
 * dsh-mcp-tunnel — 自签 CA / 服务端证书的生成与目录管理（本地 openssl exec）。
 *
 * 安全模型（对齐上游）：TLS 终结在隧道属主一侧，证书由属主掌控 —— 本模块
 * 在部署目录的 certs/ 下生成一套本地 CA + 服务端证书，命名隧道（anthropic）
 * 模式用于 mcp-proxy 的本地 TLS 终结；Quick Tunnel 模式证书仍生成并挂载，
 * 供将来启用 TLS / 自检使用。
 *
 * 复用规则（验收标准 3）：CA 密钥对已存在则**不重新生成**（仅校验可读）；
 * server 证书已存在也直接复用 —— 二次 create 不会覆盖既有证书。
 *
 * 所有步骤通过 child_process.execFile 执行 openssl（不经过 shell，避免
 * 参数注入），每步带超时与清晰的分步错误信息。
 *
 * @module dsh-mcp-tunnel/certs
 */

import { promisify } from 'node:util'
import { execFile as execFileCb } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const execFile = promisify(execFileCb)

/** 每步 openssl 调用的超时（毫秒）。 */
const OPENSSL_STEP_TIMEOUT_MS = 30_000

/** 证书目录内的固定文件名。 */
export const CA_CERT_FILENAME = 'ca.crt'
export const CA_KEY_FILENAME = 'ca.key'
export const SERVER_CERT_FILENAME = 'server.crt'
export const SERVER_KEY_FILENAME = 'server.key'
export const SERVER_CSR_FILENAME = 'server.csr'

/** 生成的证书文件路径集合。 */
export interface CertPaths {
  dir: string
  caCrt: string
  caKey: string
  serverCrt: string
  serverKey: string
  serverCsr: string
}

/** ensureCerts 的选项。 */
export interface CertOptions {
  /** 证书目录（绝对路径；不存在则创建）。 */
  dir: string
  /** SAN 中的 hostname 集合（默认 ['localhost']）。 */
  hostnames?: string[]
  /** CA 证书有效期天数（默认 3650）。 */
  caDays?: number
  /** 服务端证书有效期天数（默认 825）。 */
  serverDays?: number
}

/** CA 密钥对是否已存在（复用判定）。 */
export async function caExists(dir: string): Promise<boolean> {
  return (await fileExists(join(dir, CA_CERT_FILENAME))) && (await fileExists(join(dir, CA_KEY_FILENAME)))
}

/** server 证书/密钥是否已存在（复用判定）。 */
export async function serverCertExists(dir: string): Promise<boolean> {
  return (await fileExists(join(dir, SERVER_CERT_FILENAME))) && (await fileExists(join(dir, SERVER_KEY_FILENAME)))
}

/**
 * 确保证书目录就绪：存在则复用，缺失则用 openssl 生成。
 * 私钥（ca.key / server.key）生成后立即收紧为 0600（同机其他用户不可读）。
 * @param options - 证书目录与 SAN 配置。
 * @returns 全部证书路径。
 */
export async function ensureCerts(options: CertOptions): Promise<CertPaths> {
  const dir = options.dir
  const hostnames = options.hostnames ?? ['localhost']
  const caDays = options.caDays ?? 3650
  const serverDays = options.serverDays ?? 825

  await fs.mkdir(dir, { recursive: true })

  const paths: CertPaths = {
    dir,
    caCrt: join(dir, CA_CERT_FILENAME),
    caKey: join(dir, CA_KEY_FILENAME),
    serverCrt: join(dir, SERVER_CERT_FILENAME),
    serverKey: join(dir, SERVER_KEY_FILENAME),
    serverCsr: join(dir, SERVER_CSR_FILENAME),
  }

  if (!(await caExists(dir))) {
    await runOpenSSL('genrsa', ['-out', paths.caKey, '2048'], '生成 CA 私钥', paths.caKey)
    await fs.chmod(paths.caKey, 0o600)
    await runOpenSSL(
      'req',
      ['-x509', '-new', '-key', paths.caKey, '-sha256', '-days', String(caDays), '-out', paths.caCrt, '-subj', '/CN=dsh-mcp-tunnel-local-ca'],
      '签发 CA 证书',
      paths.caCrt,
    )
  }

  if (!(await serverCertExists(dir))) {
    // 重新生成全套 server 证书（密钥 → CSR → 用本地 CA 签发），SAN 覆盖回环地址。
    await runOpenSSL('genrsa', ['-out', paths.serverKey, '2048'], '生成 server 私钥', paths.serverKey)
    await fs.chmod(paths.serverKey, 0o600)
    const firstHost = hostnames[0] ?? 'localhost'
    await runOpenSSL(
      'req',
      ['-new', '-key', paths.serverKey, '-out', paths.serverCsr, '-subj', `/CN=${firstHost}`],
      '生成 server CSR',
      paths.serverCsr,
    )
    const san = buildSan(hostnames)
    const sanFile = await writeSanFile(dir, san)
    await runOpenSSL(
      'x509',
      [
        '-req', '-in', paths.serverCsr,
        '-CA', paths.caCrt, '-CAkey', paths.caKey, '-CAcreateserial',
        '-out', paths.serverCrt, '-days', String(serverDays), '-sha256',
        '-extfile', sanFile,
      ],
      '用本地 CA 签发 server 证书',
      paths.serverCrt,
    )
  }

  return paths
}

/** 把 hostname 集合转成 openssl subjectAltName 文本。 */
function buildSan(hostnames: readonly string[]): string {
  const names = new Set<string>(['localhost', '127.0.0.1', ...hostnames])
  const parts: string[] = []
  for (const name of names) {
    parts.push(name.includes(':') ? `IP:${name}` : `DNS:${name}`)
  }
  return `subjectAltName=${parts.join(',')}`
}

/** 写 SAN ext 文件，返回其路径（调用方保留即可）。 */
async function writeSanFile(dir: string, san: string): Promise<string> {
  const file = join(dir, 'san.cnf')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(file, `${san}\n`, 'utf8')
  return file
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

/** 执行一步 openssl；失败时抛出带步骤名与 stderr 的清晰错误。 */
async function runOpenSSL(step: string, args: readonly string[], label: string, outputPath: string): Promise<void> {
  try {
    await execFile('openssl', [step, ...args], { timeout: OPENSSL_STEP_TIMEOUT_MS })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `certs: ${label} 失败（openssl ${step}）→ ${detail}` +
      (outputPath ? `；目标文件：${outputPath}` : ''),
    )
  }
}