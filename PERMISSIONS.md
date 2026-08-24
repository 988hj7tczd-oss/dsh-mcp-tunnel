# PERMISSIONS — dsh-mcp-tunnel 权限与失败边界声明

本文件供 DSH STORE 自动审查与人工复核使用，如实描述插件在运行时
做什么、不做什么，以及失败边界。

## 运行时行为
- **目的**：把本机 MCP server 暴露给远程 Agent——生成 mcp-proxy +
  cloudflared 的 Docker Compose 隧道栈，管理其生命周期
  （`mcp_tunnel_create` / `mcp_tunnel_status` / `mcp_tunnel_stop`）。
- **读取**：隧道部署目录（`deployRoot`，默认 `~/.dsh/mcp-tunnels`）内的
  `docker-compose.yml` 与服务状态（`state.json`）、`.env`（仅 API_KEY 一项，
  供命名隧道复用）。
- **写入**：仅写入隧道部署目录 `<deployRoot>/<name>/`：
  - `docker-compose.yml`（compose 栈定义）；
  - `.env`（仅 `API_KEY=` 一项，以 **0600** 权限创建——刻意收紧的密钥文件，
    写入时设置权限位而非 chmod 命令；绝不把密钥写进 compose 文件）；
  - 证书目录（本地 CA 与站点证书，供本机 mcp-proxy TLS 使用）；
  - `state.json`（隧道运行状态；`mcp_tunnel_stop` 后标记 url 下线 + lastError）。
- **命令执行**：经 Node `child_process.spawn` 以**固定 argv（非 shell）**
  调用容器运行时（`docker` 或 `podman`，可配 `dockerBinary`）：
  - `docker <compose args> up -d --build` / `ps` / `logs --tail <n>` / `down`
  - `<binary> --version`（前置可用性检查，8s 超时，缺失给出清晰提示）
  命令行任何位置都不拼接用户/模型输入。
- **网络**：插件进程本身无 fetch；隧道连通由 Compose 栈内的 **cloudflared
  容器**发起出站连接（Cloudflare Quick Tunnel / 命名隧道）。Quick Tunnel
  免账号开箱即用；命名隧道需用户在 `.env` 配置 API_KEY（由用户提供）。
- **外部服务**：Cloudflare 隧道端点（compose 栈容器内完成）；当且仅当
  用户配置 `mcpServer` 指向远程地址时，mcp-proxy 才连接该地址。
- **凭据/密钥**：API_KEY 以 0600 写入 `.env`，仅用于命名隧道；不转发、
  不写入 compose 文件、不进日志。
- **全局资源**：不安装全局包、不修改 DSH 宿主配置之外的内容。

## 依赖
| 依赖 | 用途 | 提供方 |
|---|---|---|
| Node.js ≥ 23.6 | 插件加载与工具执行（含 TS 测试运行） | DSH 宿主 |
| @deepseek-ai/schemastery | 配置 Schema（peer） | DSH 宿主 |
| docker 或 podman | 运行隧道 compose 栈 | 主机预装/系统包 |
| cloudflared（容器镜像内） | Quick/命名隧道出站连接 | compose 栈镜像提供 |

## 文件权限信号说明
- 运行时**不**执行 `chmod`/`chown` 等权限位修改；`.env` 以 0600 权限
  **创建**（写入时一次性设置，非 chmod 命令），其余生成文件（compose/
  证书/state.json）以宿主默认权限创建。
- 仓库中文件均以普通文件权限提交（644），无 setuid/setgid/sticky 信号。

## 失败边界（结构化，绝不静默）
| 情形 | 行为 |
|---|---|
| 容器运行时缺失/daemon 未启动 | 前置检查结构化错误（ENOENT → 提示安装 docker/podman；否则提示检查 daemon），不崩溃 |
| compose 构建/启动失败 | 错误含收集到的 stderr 尾部；清除失败标注 |
| cloudflared 长时间未就绪 | 轮询日志超时 → 明确错误（不产出假 URL） |
| 停止隧道 | `docker compose down` + `state.json` 标记 url 下线与 lastError |
| 证书生成失败 | 结构化错误，二次调用复用已生成 CA |
| `.env` 缺失 API_KEY（命名隧道） | 指示用户配置；Quick Tunnel 无需密钥 |

## 与 DSH STORE 契约的关系
- 供应链：运行时依赖全部由 DSH 宿主提供（peer），不随包下载第三方二进制；
  Docker 镜像由 compose 栈在运行时拉取（用户显式触发创建隧道时）；
  本包内无 postinstall 网络行为。
- 生命周期：一次性 Profile 安装/启动/卸载验证步骤与当前证据见
  `docs/store-evidence.md`；真实 Profile 运行证据在装有 DSH 的宿主上执行该文档步骤补全。