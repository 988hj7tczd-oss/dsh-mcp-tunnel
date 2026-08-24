# store-evidence — dsh-mcp-tunnel 一次性 Profile 安装 / 启动 / 卸载证据

本文件记录 DSH STORE 要求的一次性 Profile 安装、启动、卸载验证的证据与执行步骤。
**真实 Profile 运行**需在装有 DSH CLI 的宿主上执行（本仓库离线环境无法完成该步骤）；
以下同时记录已完成的离线等价证据，保证可复现、可审计。

## 1. 一次性 Profile 安装 / 启动 / 卸载步骤（在 DSH 宿主执行）
```bash
# 0) 前置：仓库与构建
git clone https://github.com/988hj7tczd-oss/dsh-mcp-tunnel.git
cd dsh-mcp-tunnel
pnpm install --offline        # 依赖 = @deepseek-ai/*（DSH 宿主 peer）+ 本地工具链
pnpm build                    # tsc → lib/*

# 1) 隔离环境（不触碰 ~/.dsh）
export DSH_HOME=$(mktemp -d /tmp/dsh-mt-profile-XXXXXX)

# 2) 安装（dsh plugin add 本地包，行名裸包名 dsh-mcp-tunnel）
dsh plugin --profile mt-demo add /path/to/dsh-mcp-tunnel

# 3) 启动冒烟：Profile 应正常启动；工具注册表出现
#    mcp_tunnel_create / mcp_tunnel_status / mcp_tunnel_stop
#    （会话内工具清单核对 + 读日志无 fatal/parse 错误）

# 4) 卸载
dsh plugin --profile mt-demo remove dsh-mcp-tunnel
#    Profile 重启后工具清单不再含 mcp_tunnel_*；DSH_HOME 临时目录可整体删除
rm -rf "$DSH_HOME"
```

## 2. 已完成的离线等价证据（本仓库内可复现，2026-08-24）
| 检查 | 命令 | 结果 |
|---|---|---|
| 构建 | `pnpm build`（tsc -p tsconfig.build.json） | 0 错误，产出 `lib/` |
| 冒烟测试 | `pnpm test`（node --test tests/tunnel.smoke.ts tests/tunnel.e2e.ts） | **18 通过 / 0 失败 / 1 skip**（19 用例；e2e 需 docker 环境的泳道离线跳过：无 docker daemon 时前置检查错误路径已验证） |
| 验收覆盖 | smoke 含：证书生成+CA 复用、state.json stop 失效标注、templates 与交付物一致、README 安全模型要点 | 全过 |
| 权限面 | `PERMISSIONS.md` | 运行时固定 argv 调 docker/podman（无 shell）；写面仅 deployRoot 部署目录（.env 0600 创建、compose/证书/state.json） |

## 3. 仍未补全（待宿主环境）
- 真实 `dsh --profile` 安装 → 启动（工具清单含 mcp_tunnel_*）→ 卸载的
  一段运行记录；`docker … up -d --build` 真实链路（1 skip 项）需在
  装有 Docker 的主机补跑。
- 建议同时跑 `.mount-verify` 输出本项目的 BOOT_OK 记录作为补充证据。

## 4. 对 STORE 自动审查信号的逐项回应
| 信号 | 本仓库回应 |
|---|---|
| 清单仓库与 canonical 不匹配 | package.json `repository` 已指向 `https://github.com/988hj7tczd-oss/dsh-mcp-tunnel.git` |
| 未声明 Node.js 兼容性 | `engines.node` = `>=23.6.0`；`dsh.compatibility` 同时声明 DSH ≥ 0.1.0 |
| 依赖需供应链审查 | 运行时依赖全部为 DSH 宿主 peer；无第三方二进制随包分发；镜像运行时由 compose 拉取（用户触发）；无 postinstall 网络行为 |
| 文件权限信号 | 运行时无 chmod/chown 命令；`.env` 以 0600 权限创建（密钥刻意收紧）；仓库文件均为 644 |
| 命令权限信号 | 仅固定 argv 调用 `docker`/`podman`（compose 子命令白名单 + `--version`），无 shell 透传；命令清单见 `dsh.permissions.commands` |
| 一次性 Profile 证据 | 本节第 1 步步骤 + 第 2 节离线证据；真实 Profile 证据待宿主运行后补录 |