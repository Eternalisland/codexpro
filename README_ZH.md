<p align="center">
  <img src="docs/favicon.svg" width="72" height="72" alt="CodexPro logo">
</p>

<h1 align="center">CodexPro</h1>

<p align="center">
  让 ChatGPT 在你明确允许的本地仓库上使用编码工具。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/codexpro"><img alt="npm" src="https://img.shields.io/npm/v/codexpro?style=flat-square"></a>
  <a href="https://github.com/rebel0789/codexpro/actions"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/rebel0789/codexpro/ci.yml?branch=main&style=flat-square"></a>
  <a href="https://github.com/rebel0789/codexpro/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/rebel0789/codexpro?style=flat-square"></a>
  <a href="https://rebel0789.github.io/codexpro/zh.html"><img alt="中文站点" src="https://img.shields.io/badge/site-%E4%B8%AD%E6%96%87%E6%96%87%E6%A1%A3-67e8f9?style=flat-square"></a>
</p>

<p align="center">
  <a href="README.md">English</a>
  ·
  <a href="https://rebel0789.github.io/codexpro/zh.html">中文网站</a>
  ·
  <a href="FAQ_ZH.md">中文 FAQ</a>
  ·
  <a href="SECURITY.md">安全说明</a>
</p>

## 它是什么

CodexPro 是本地 MCP server。它连接**你的 ChatGPT 会话**、**你的机器**和**你允许的仓库**。

ChatGPT 可以读取、搜索、编辑、审查、验证、导入附件，并写 handoff 计划。范围始终限制在这些 root 内。

它不是托管 SaaS、模型代理、配额绕过、账号池或远程 shell 服务。

## 安装

需要：

- Node.js 20+
- 能创建自定义 MCP 插件的 ChatGPT 账号
- ChatGPT Web 可用的 HTTPS 地址（tunnel 或 Tailscale Funnel）

```bash
npm install -g codexpro
cd /path/to/your/repo
codexpro setup
```

## 在 ChatGPT 中连接

1. `Settings -> Security and login` → 打开 **Developer mode**（保持 CSP 开启）。
2. `Settings -> Plugins` → Plugins 标签页 → 搜索框旁的 **+**。
3. 创建名为 `CodexPro` 的插件。
4. 连接方式：**Server URL** → 粘贴 CodexPro 复制的 URL。
5. 认证：**No Authentication / None**（表单可能默认 OAuth，创建前改掉）。

CodexPro 的认证就在这个 URL 里的 token。不要分享该 URL。

| 打开 Plugins 并点击 `+` | 填写 New Plugin 表单 |
| --- | --- |
| ![打开 Plugins 并点击加号](docs/images/chatgpt-plugins-add.png) | ![填写 New Plugin 表单](docs/images/chatgpt-plugin-details.png) |

同一仓库日常启动：

```bash
codexpro start
```

如果创建插件失败，运行 `codexpro connection-test`，确认 ChatGPT 请求是否到达本地 server。

## ChatGPT 能做什么

在 workspace write 模式（常规 agent 设置）下：

- 使用有边界的代码智能读取、搜索和检查仓库
- 用 `write`、`edit` 或受保护的 `apply_patch` 编辑
- 用 `import_file` 导入 ChatGPT 附件
- 用 `bash` 运行白名单检查
- 用 `show_changes` 审查 diff 及可能的影响范围
- 在 `.ai-bridge` 下写计划
- 为不能调工具的会话导出 context bundle

### 内置仓库智能

CodexPro 不只是原始文件搜索：

- `inspect_workspace` 会映射语言、项目类型、入口、区域、符号和内部关系。
- `search` 除普通文本和正则搜索外，还支持 `symbol`、`references` 和 `impact` 意图。
- `show_changes` 会给出受影响区域、可能的依赖方、相关测试、风险信号和建议验证命令。
- 可识别 TypeScript/JavaScript、Python、Go、Rust、Swift、Java、C#、C 和 C++ 声明；其他语言仍可安全清点和词法搜索。

分析完全在本地运行，受明确上限约束，并按工作区指纹缓存。它不需要额外的模型 API key、语言服务器守护进程、向量数据库或 embedding 服务。覆盖不完整或关系仅为推断时，结果会明确标示，而不会伪装成确定结论。

### 产品重点

CodexPro 专注于一个清晰流程：把 ChatGPT 连接到明确允许的本地仓库，完成可审查的修改，运行验证，并保留交接记录。项目优先保证：

- 明确的工作区边界，以及读取、写入、命令、会话和交接的独立控制
- 无需把仓库发送到独立索引服务，也能获得实用代码导航
- 在支持的 Node.js 版本上进行跨平台安装和发布验证
- 紧凑、有边界的工具结果，让长时间 ChatGPT 会话仍然可用

后续可靠性、代码导航和工作流改进见[路线图](ROADMAP.md)。

## 多项目

一个 CodexPro 进程可以允许多个仓库：

```bash
codexpro settings set --project ~/code/web --project ~/code/api
codexpro settings show
codexpro start
```

让 ChatGPT 对已允许项目执行 `open_workspace`。`open_current_workspace` 切回启动仓库。

两个 ChatGPT 账号或需要硬隔离时，用不同端口和 Server URL 跑两个 CodexPro 进程。

## 命令

```bash
codexpro setup
codexpro start
codexpro start --root /path/to/repo
codexpro doctor
codexpro connection-test
codexpro settings
codexpro inspect
codexpro review
```

常用模式：

```bash
codexpro start --no-bash
codexpro start --tool-mode minimal
codexpro start --tool-mode full
codexpro start --mode handoff
codexpro start --mode pro
codexpro start --headless
```

可选工具卡片：

```bash
CODEXPRO_TOOL_CARDS=1 codexpro start
```

## MCP 请求、SSE 和执行时间线

需要排查 ChatGPT 连接中断、MCP 超时或长时间静默的 `vue-tsc` 时，可以显式开启脱敏 Trace：

```bash
codexpro start --mcp-trace redacted
codexpro trace tail --lines 30
codexpro trace show --job check_xxx --json
codexpro trace timeline --job check_xxx --html ./codexpro-timeline.html
codexpro trace timeline --request req_xxx --json
```

用浏览器打开生成的本地 HTML 文件，即可按时间展开 HTTP、MCP、Tool、Execution Supervisor 和 SSE 事件。SSE 的 `mcp.sse.chunk`、`mcp.sse.event`、`mcp.sse.summary` 只记录分块大小、完整帧数和事件类型等元数据，不额外复制 `data:` 负载；长流对明细记录做采样，但最终计数保持完整。

Trace 默认关闭。即使在 `redacted` 模式，日志仍可能包含文件路径、代码摘要、命令和业务信息，应只在可信设备保存和分享。离线 HTML 不加载脚本或外部资源；已存在的输出文件不会自动覆盖。HTTP `finish` 表示 Node 已完成响应写入，不表示 ChatGPT UI 一定收到或处理成功。

### 控制台实时诊断（长时间无输出时建议开启）

这与上方的 JSONL Trace 独立。Windows PowerShell 在启动 CodexPro 的同一个终端中设置：

```powershell
$env:CODEXPRO_LOG_REQUESTS = '1'
$env:CODEXPRO_LOG_TOOL_CALLS = '1'
$env:CODEXPRO_LOG_HEARTBEAT_MS = '10000'
codexpro start --mcp-trace redacted
```

每条 MCP HTTP/Tool 控制台诊断都带 CodexPro 所在机器的本地时间和明确的 UTC 偏移（例如 `2026-10-08 22:32:50.123 +08:00`）；持久化 Protocol Trace JSONL 仍保留 UTC `Z` 时间戳，便于跨机器关联。Tool 在启动时打印 `start`，每隔 10 秒打印 `running elapsed_ms`，最后打印 `ok/error` 和总耗时。对于直接调用的 `bash`，实时输出 `pid`、`output_bytes`、`last_output_age_ms`；命令名称只对安全的 npm/pnpm/yarn/bun 验证脚本显示，其他命令显示 `custom-command`，不会原样打印脚本或凭证。可以通过 `request_id` 串联 HTTP 与 Tool 诊断。

`GET /mcp received stream=sse` 通常表示**正常驻留的 SSE 连接**，每至少 30 秒报告一次待命；它没有立即返回 `200` 不代表卡死。`POST /mcp pending` 或 `[CodexProTool] bash running` 表示对应请求/命令仍在运行；`closed client_aborted=true` 表示响应未正常结束就关闭。建议长时间的 typecheck/build/test 使用 `start_check` + `wait_check`，不要让单次 `bash` MCP 调用阻塞几分钟。

## 公网 HTTPS

ChatGPT Web 需要 HTTPS：

```bash
codexpro start --tunnel cloudflare
codexpro ngrok --hostname your.ngrok-free.dev
codexpro stable --hostname codexpro.example.com --tunnel-name codexpro
codexpro tailscale --hostname your-device.your-tailnet.ts.net
codexpro start --tunnel none
```

稳定主机名请固定 token：

```bash
mkdir -p ~/.codexpro
openssl rand -hex 32 > ~/.codexpro/http-token
chmod 600 ~/.codexpro/http-token
```

客户端支持 header 时优先用 `Authorization: Bearer <token>`。`?codexpro_token=` 只是个人兼容回退。

## 安全默认

- 公网 tunnel 需要 CodexPro HTTP token（至少 24 bytes）
- 非 workspace write 模式不暴露写入工具
- 默认 safe bash
- 拦截 `.env`、密钥、`.git`、构建缓存等路径
- 附件导入只接受已批准 HTTPS 主机上的 ChatGPT Apps SDK 文件对象

公网暴露前先读 [SECURITY.md](SECURITY.md)。

## 更新

```bash
npm install -g codexpro@latest
codexpro --version
```

更新后重启 `codexpro start`。`~/.codexpro` 下的配置会保留。

## 文档

- [中文网站](https://rebel0789.github.io/codexpro/zh.html)
- [中文 FAQ](FAQ_ZH.md)
- [Security](SECURITY.md)
- [路线图](ROADMAP.md)
- [稳定 URL 指南](DOMAIN_SETUP.md)
- [Changelog](CHANGELOG.md)
- [Contributors](CONTRIBUTORS.md)
