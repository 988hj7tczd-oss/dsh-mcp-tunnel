# dsh-mcp-tunnel

> [!IMPORTANT]
> **依赖前置：相邻 `dsh-src` 检出（`link:` 依赖）**
> 本项目在开发形态下使用 `link:` 依赖指向相邻的 DeepSeek Harness 源码检出（`dsh-src`），
> 与当前仓库保持同一父目录布局（`<parent>/dsh-src`）。克隆本仓库后：
> 1. 先把官方 `deepseek-ai/deepseek-harness` 检出到与本仓库同级的 `dsh-src/` 目录，并执行其 `pnpm install && pnpm run build`；
> 2. 再按下方「安装」一节执行本仓库的 `pnpm install --offline && pnpm build` 与测试。
> 发布到 npm 的版本会尽量把 `link:` 依赖替换为 registry 真实版本；无法替换的内部包保持 `link:`，见各包 README 说明。


把本机 MCP Server 安全暴露给远程 Agent 的 DSH 隧道插件：一键为本机目录中的 MCP server
拉起隧道栈（**mcp-proxy + cloudflared** 的 Docker Compose 栈），并把最终公开 URL 注册到
`@deepseek-ai/dsh-mcp-client` 的 streamable-http 配置里（**待确认片段**，安全护栏 1）。

> 设计取向（对齐上游 anthropics/claude-plugins-official#mcp-tunnels，仅参考行为、不抄源码）：
> 隧道 = **传输层**；鉴权/授权应明确标注为「由暴露方自行加」。默认提供方
> cloudflare-quick（免账号、开箱即用），与上游 security model 的立场一致：
> **免费快速隧道仅限测试，生产流量必须自行加鉴权层**。

---

## 一、架构与安全模型

```
远程 Agent (dsh-mcp-client, streamable-http)
        │  HTTPS + Authorization: Bearer <token>
        ▼
https://<random>.trycloudflare.com        ← Cloudflare 边缘（TLS 由 Cloudflare 提供）
        │  （cloudflared 与边缘之间的出站隧道连接）
        ▼
┌──────────── Docker Compose 网络（共享命名空间）────────────┐
│  cloudflared ── network_mode: service:mcp-proxy ──► mcp-proxy │
│         （出站-only，与代理共享网络命名空间，无任何入站端口）    │
│  mcp-proxy（校验 Bearer 令牌 → 转发到上游）                        │
│       │                                                        │
│       ├─► hello-mcp（可选 FastMCP 示例：echo / uptime）          │
│       └─► 你的 MCP server 的 HTTP(S) 端点（容器网络/宿主机回环）   │
└──────────────────────────────────────────────────────────────┘
  （宿主机仅绑定 127.0.0.1:<回环调试端口> —— 公网无任何监听端口）
```

关键属性：

- **出站-only**：cloudflared 只主动连到 Cloudflare 边缘；公网无入站端口，
  宿主机唯一端口绑定是 `127.0.0.1:43180` 的回环调试端口（验收标准 1）。
- **本地 TLS 终结（命名隧道模式）**：`certs/` 下的自签 CA + 服务端证书由隧道属主掌控，
  与上游「证书用户掌控」做法一致；Quick Tunnel 模式公网侧 TLS 由 Cloudflare 提供，
  证书仍生成并挂载供复用/自检。
- **鉴权边界（重要）**：mcp-proxy 校验 `Authorization: Bearer <token>`（令牌在部署目录
  `.env` 中，0600）。Quick Tunnel 的随机域名不是安全边界 —— **生产流量必须由暴露方
  自行加鉴权层/网关**，本插件只保证「隧道=传输层」。

## 二、交付物

```
dsh-mcp-tunnel/
├── cordis.yml              # Cordis 装配（一行插件 + config 默认值；兼作 dsh.bundle.patch）
├── package.json            # dsh-mcp-tunnel，声明 dsh.bundle（MIT）
├── src/index.ts            # 装配 + 3 工具（create/status/stop）+ ctx.jobs 后台流程
├── src/tunnel-stack.ts     # compose 栈生成（迷你 .hbs 渲染器）+ 落盘
├── src/certs.ts            # 自签 CA/证书生成与目录管理（本地 openssl exec）
├── src/mcp-client-config.ts# dsh-mcp-client 追加片段：生成/校验/待确认管理
├── templates/
│   ├── docker-compose.yml.hbs   # 栈布局（mcp-proxy / cloudflared / 可选 hello-mcp）
│   └── proxy-config.env.hbs     # 代理非敏感环境配置（秘密一律走 .env）
├── README.md               # 本文档（安全模型 + 限制）
├── LICENSE                 # MIT
├── tsconfig.json           # tsc --noEmit 类型检查用
└── tests/
    ├── tunnel.smoke.ts     # 离线冒烟（node:test，无需 docker）
    └── tunnel.e2e.ts       # 真栈 e2e（需 docker + 公网，显式 DSH_MCP_TUNNEL_E2E=1 启用）
```

## 三、安装

本地开发（scratch-plugin 风格，直接加载 TS 源码）：

```yaml
# 你的 profile 的 cordis.patch.yml 追加：
- insert:
    - id: dsh-mcp-tunnel
      name: '/绝对路径/dsh-mcp-tunnel/src/index.ts'
      config: {}
```

作为 profile bundle 安装（`dsh.bundle.patch: ./cordis.yml` 已声明）：

```bash
cd <你的 DSH profile>
pnpm add ./dsh-mcp-tunnel
# 行内引用建议改为包路径形式（随 exports 解析）：
#   name: 'dsh-mcp-tunnel/src/index.ts'
```

> 依赖对齐（npm 上已发布的真实版本）：peerDependencies 声明 `@deepseek-ai/cordis ^4.0.1`、
> `@deepseek-ai/dsh-tools ^0.1.1-rc.2`、`@deepseek-ai/dsh-jobs ^0.1.0-rc.8`；dependencies 为
> `@deepseek-ai/schemastery ^3.18.1`（运行时仅真正 import schemastery；其余为类型级/服务级
> 依赖）。peer 关系保留：目标运行时是 DSH 宿主，由宿主提供 cordis / dsh-tools / dsh-jobs 服务。

## 四、工具用法

### `mcp_tunnel_create`

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string | ✓ | 隧道名 = compose 项目名 = mcp-client `serverName`（`^[A-Za-z0-9_-]{1,32}$`） |
| `serverDir` | string | | MCP server 目录：优先读 `.mcp.json`（首个含 `url` 的条目作上游；`command` 型 stdio server 需先转成 HTTP 端点，见「限制」） |
| `upstreamUrl` | string | | 直接指定上游 MCP 端点（http/https），优先级高于 `.mcp.json` |
| `provider` | string | | `cloudflare-quick`（默认，免账号）/ `anthropic`（命名隧道，需自备 Cloudflare 账号与 DNS） |
| `deployDir` | string | | 覆盖部署目录（默认 `<deployRoot>/<name>`，`deployRoot` 默认 `~/.dsh/mcp-tunnels`） |
| `useHelloMcp` | boolean | | 无上游可用时内置 hello-mcp 示例 server（`echo`/`uptime`）；默认自动 |
| `token` | string | | 自定义访问令牌；缺省自动生成 32 字节随机令牌写入 `.env`(0600) |
| `hostProxyPort` | integer | | 宿主回环调试端口（默认 43180） |

行为：生成栈文件 + 证书（CA 存在即**复用**，验收标准 3）→ 写 `.env`(0600，秘密不进 compose)
→ 前置检查 docker（缺失给清晰提示，验收标准 5）→ 后台起容器（`ctx.jobs`，缺 jobs 时前台）
→ 轮询 cloudflared 日志出 **Quick Tunnel URL** → 写 `state.json` → 生成 **待确认片段**
`<deployDir>/mcp-client.pending.yml`。有 jobs 时返回 `{kind:'background', jobId}`，用
`job_output` 收尾；无 jobs 时前台返回完整结果。

### `mcp_tunnel_status`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `name` | string | 隧道名；缺省列出全部隧道 |

输出：每隧道的部署目录、`state.json`、栈文件存在性、`docker compose ps` 结果、
cloudflared 最近日志尾部（**≤50 行**）、待确认片段（serverName/url）。

### `mcp_tunnel_stop`

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `name` | string（必填） | | 隧道名 |
| `keepCerts` | boolean | true | `false` 时删除 `certs/` |

行为：`docker compose down` 停栈并下线 URL（验收标准 4）→ 移除待确认片段 →
写入 `state.json` 失效标注（`url` 下线 + `lastError`，status 可见）→ **保留证书目录**
供下次 create 复用（验收标准 3/4）。

## 五、mcp-client 配置片段（安全护栏 1）

`create` **绝不自动改写任何 profile 配置**，只在部署目录写出待确认片段
（`mcp-client.pending.yml`），由你在显式确认后手动粘贴：

```yaml
- insert:
    - id: mcp-<serverName>
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: <name>
        transport: streamable-http
        url: <https://xxx.trycloudflare.com>
        headers:
          Authorization: 'Bearer <token>'
        toolCallTimeoutMs: 60000
        failOnStartupError: false
```

- 字段名与 `@deepseek-ai/dsh-mcp-client` 的 `StreamableHttpConfig` 完全一致；
- 远程工具名 = `mcp__<serverName>__<rawName>`；
- `mcp_tunnel_stop` 会删除该片段文件（验收标准 4）。若你已粘贴进 profile，
  记得同步删除那一行，否则请把 URL 标注为失效；
- 「由 apply 注入」路径（显式确认后自动写 profile 的 cordis.patch.yml）留作后续版本。

## 六、安全护栏清单

1. **仅显式确认后写 mcp-client 配置**：插件只产出待确认片段文件，绝不自动改写 profile；
2. **秘密不进 compose**：访问令牌只写入部署目录 `.env`（0600，docker compose 原生读取），
   `docker-compose.yml` / `proxy-config.env` 只含 `${API_KEY:?…}` 引用与占位；
   无用户 API key 时生成随机令牌并同步提供 `.env.example`；
3. **公网无监听端口**：唯一宿主端口绑定是 `127.0.0.1` 回环；
4. **README 明示**：免费快速隧道仅限测试，生产流量需要鉴权层（对齐上游 security model）。

## 七、栈契约（本插件声明的 compose 规范）

| 服务 | 镜像 | 角色 |
| --- | --- | --- |
| `mcp-proxy` | `ghcr.io/anthropics/mcp-proxy:latest` | 校验 `Authorization: Bearer`，转发到 `proxy-config.env` 的 `UPSTREAM_MCP_URL` |
| `cloudflared` | `cloudflare/cloudflared:latest` | 出站-only 隧道；`network_mode: service:mcp-proxy` |
| `hello-mcp`（可选） | 内嵌 Dockerfile 构建 | FastMCP 示例，SSE 端点 `/sse` |

- 环境变量契约以 `proxy-config.env` / `docker-compose.yml` 为准（`UPSTREAM_MCP_URL`、
  `MCP_PROXY_EXTERNAL_HOSTNAME`、`API_KEY` 引用等）；若你的 mcp-proxy 镜像版本使用
  不同 env 名，请以镜像文档微调 compose —— 本插件把 compose 文件视为最终契约并已在
  README 中显式声明。
- 容器内依赖使用 `service_started`（cloudflared 对 mcp-proxy），不依赖镜像自带健康探针。

## 八、验收标准对照

1. ✅ 无外部账号（cloudflare-quick）拿到可达 HTTPS URL，且本机无公网监听端口
   （回环-only 绑定 + 出站-only cloudflared；e2e 可实测）。
2. ✅/⚠ 远程侧配到 dsh-mcp-client 后调用 echo —— 片段结构对齐 mcp-client 配置；
   e2e 覆盖**隧道栈可用性与可达性**（公开 URL 可达 + SSE 接入面 + Authorization 被接受）；
   MCP 协议握手（initialize → tools/call → echo 返回值断言）**未自动化**（见「限制」#3）。
3. ✅ 证书目录复用：`certs.ts` 对既有 CA 只复用、不重新生成（冒烟测试断言）；私钥 0600。
4. ✅ 停栈后 URL 下线、待确认片段移除；stop 保留 `state.json` 并写入失效标注
   （`url` 下线 + `lastError`，status 可见）。
5. ✅ docker 缺失给清晰前置提示而非崩溃（`checkRuntimeAvailable`）。

## 九、限制与后续工作

1. **stdio → HTTP 桥接未内置**：`.mcp.json` 的 `command` 型 server 需先用任意
   stdio→HTTP 网关转成 streamable-http/SSE 端点再交给 `upstreamUrl`。后续版本可内置
   host-side 桥接进程（spawn + job 生命周期管理）。
2. **`anthropic`（命名隧道）模式需要自备 Cloudflare 账号**：compose 模板已预留
   `--config`/凭据挂载注释位，但 URL 由你的 DNS 决定、不在日志轮询范围内。上游本
   身是 research preview，本项目默认用免账号 Quick Tunnel 保证开箱即用。
3. **完整 MCP 握手**（initialize → tools/call → echo 返回值断言）需要
   `@modelcontextprotocol/sdk` 客户端；当前 e2e 验证到「公开 URL 可达 + SSE 接入面 +
   Authorization 被接受」，把 sdk 放进 devDependencies 后即可补全验收标准 2 的端到端断言。
4. **镜像 env 契约未在离线环境验证**：`ghcr.io/anthropics/mcp-proxy` 的具体 env/flag
   以 README「栈契约」为准，遇到镜像版本差异时按镜像文档微调 compose。
5. **token 轮换**：`create` 支持显式传 `token`，但轮换/吊销流程建议交给部署方自行管理
   （改 `.env` 后重启容器）。
6. **回环端口冲突**：`hostProxyPort` 被占用时 `compose up` 会报错，暂无自动避让；
   可显式传 `hostProxyPort` 换端口。

## 十、开发与测试

```bash
# 离线冒烟（无需 docker/网络；Node ≥ 23.6 原生跑 TS，22.x 需 --experimental-strip-types）
npm test                # = node --test tests/
npm run test:smoke      # 仅离线冒烟

# 真栈 e2e（需要 docker daemon + 公网，会访问 Cloudflare 边缘）
DSH_MCP_TUNNEL_E2E=1 npm run test:e2e

npm run typecheck       # tsc --noEmit（需先 pnpm install）
```

## License

MIT（参考上游行为、未复制其 Proprietary 源码正文）。