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
- 在修改前用 `preview_patch` **只读预演**多文件 Diff：复用写入路径限制与 Git 上下文校验，报告能否应用、目标文件的已有 Git 修改、增删行数和失败原因；预演不更改源码，但结果可能因外部修改而过期
- 用 `write`、`edit` 或受保护的 `apply_patch` 编辑（正式写入仍需重新验证 Patch）
- 用 `import_file` 导入 ChatGPT 附件
- 用 `bash` 运行白名单检查
- 用 `show_changes` 审查 diff 及可能的影响范围
- 在 `.ai-bridge` 下写计划
- 为不能调工具的会话导出 context bundle

### 内置仓库智能

CodexPro 不只是原始文件搜索：

- `inspect_workspace` 会映射语言、项目类型、入口、区域、符号和内部关系。
- `search` 除普通文本和正则搜索外，还支持 `symbol`、`references` 和 `impact` 意图。
- `find_symbol` / `find_references` 对 TypeScript/JavaScript 使用编译器语义解析，返回精确声明和引用的文件、行列号，支持 `Class.method`、同名定义的 `path` 消歧、`include_tests` 与 `max_results`。例如 `find_references({symbol: "authenticate", path: "src/auth.ts"})`。不会把注释或不相关同名函数当作引用；如索引预算耗尽会标记 `truncated`。Java 新增**方法级声明及保守引用查询**：`find_symbol({symbol: "UserService.updateUser", path: "src/main/java/.../UserService.java"})` 返回包括 `signature`、`parameter_types`、行列号的重载定义；`find_references` 还可用 `parameter_types: ["String", "int"]` 选择具体重载。Java 采用受限源码词法解析，识别明确的类名、`this`、局部变量或参数类型等接收者，并按参数个数保守匹配调用；结果始终标记 `source: java-source-heuristic` 和 `confidence: inferred`。它在**未启用 JDT LS**时不是编译器绑定，对同参数个数重载、继承/接口动态分派、泛型和外部依赖可能漏报，遇到无法消歧的调用会跳过并给出警告；不能将其作为重构的完整引用保证。启用 JDT LS 后，带明确 Java `path` 的查询优先使用语言服务器；如未就绪/查询失败，则返回带警告的启发式结果，不会把推断伪装为编译器结果。TypeScript/JavaScript 仍使用编译器解析；首版只索引允许访问的工作区源文件及 TypeScript 自带标准库，未解析第三方包和自定义 tsconfig 路径映射。
- `show_changes` 会给出受影响区域、可能的依赖方、相关测试、风险信号和建议验证命令。
- 可识别 TypeScript/JavaScript、Python、Go、Rust、Swift、Java、C#、C 和 C++ 声明；其他语言仍可安全清点和词法搜索。

分析在本地运行，受明确上限约束；轻量索引按工作区指纹缓存。默认不需要模型 API key、语言服务器、向量数据库或 embedding 服务；只有显式配置 JDT LS 时才启动可选的 Java 语言服务器进程。覆盖不完整或关系仅为推断时，结果会明确标示，而不会伪装成确定结论。

### 可选的 Java JDT Language Server 语义后端

CodexPro 的 Java 语义分析**默认不启动任何 JVM**，仍可使用上方的轻量级方法解析。若需要精确方法引用、实现类或类型层次，可自行安装 [Eclipse JDT Language Server](https://github.com/eclipse-jdtls/eclipse.jdt.ls)，并在启动 CodexPro 的 PowerShell 中设置：

```powershell
# JDT LS 解压根目录，需包含 plugins/ 与 config_win/
$env:CODEXPRO_JDTLS_HOME = "D:\tools\jdt-language-server"
# 根据已安装的 JDT LS 发行包要求选用运行时；1.62.0 发行包需要 JDK 25
$env:CODEXPRO_JDTLS_JAVA = "C:\Program Files\Java\jdk-25\bin\java.exe"
node scripts/codexpro.mjs start --mcp-trace redacted
```

**JDT LS 的运行时 JDK 与 Java 项目的编译目标不同**；分析 Java 17 项目不代表 JDT LS 可以用 JDK 17 启动。实际 JDT LS 版本的最低 JDK 要求以其发布说明为准。配置是显式可选的，不自动下载 JDT、不新增 npm/Java 依赖；只有首次查询时才启动子进程。同一工作区复用 JDT 进程，空闲约 5 分钟会关闭；索引数据目录在系统临时目录中按工作区隔离。JDT 可在导入 Maven 项目时生成 Eclipse 配置文件，应在已有源码工作区中检查 Git 差异，并视需要设置 Maven 和 Lombok 环境。

启用后支持：

- `find_symbol({symbol: "UserService.updateUser", path: "src/main/java/com/example/UserService.java"})`：JDT 能唯一匹配时将方法声明标记为 `source: jdt-lsp`、`confidence: resolved`。
- `find_references({symbol: "UserService.updateUser", path: "src/main/java/com/example/UserService.java", parameter_types: ["String", "int"]})`：使用 JDT 的引用查询；越出工作区安全边界的结果被过滤。
- `find_implementations({symbol: "UserService", path: "src/main/java/com/example/UserService.java"})`：查询实现关系。
- `get_type_hierarchy({symbol: "UserService", path: "src/main/java/com/example/UserService.java", direction: "both"})`：查询父类型及子类型，可设置 `direction` 为 `supertypes` 或 `subtypes`。

带明确 `path` 的 Java 查询先扫描**指定文件**获取声明坐标，不依赖可能达到容量限制的全仓库轻量索引。若 JDT 的 `documentSymbol` 为空或尚未索引完成，引用/实现/层次工具仍可使用文件内定位坐标尝试 LSP 查询；仅由词法扫描得到的声明继续标记 `source: java-source-heuristic` / `confidence: inferred`，不能冒充 JDT 已确认。返回的 `jdt_diagnostic` 只包括符号数量与响应格式、定位来源、扫描截断及有界服务状态/进度计数，不包含源码或服务器日志；这些计数并不能单独证明索引已经完成。

新接口为只读；**未配置 JDT 时实现类和类型层次查询会返回 `unavailable`，不会编造结果**。项目依赖不完整、Maven 导入中或索引尚未完成时，也可能返回空结果或退回启发式分析。此功能不提供完整运行时 Spring Bean 注入、反射或 Reactor 调度图。日常 `smoke:core` 使用模拟 LSP 子进程，不依赖本机 JDK/JDT。配置好 `CODEXPRO_JDTLS_HOME`、`CODEXPRO_JDTLS_JAVA` 后，可单独执行 `npm run build` 和 `node scripts/jdt-real-smoke.mjs`，在系统临时目录创建独立 Maven 示例，使用**真实 JDT LS**验证类型、接口实现关系和方法引用；不修改现有业务源码。首次 Maven 导入与索引可能需要数十秒，脚本采用有界重试，测试结束后关闭 JVM 并移除脚本生成的示例目录。本机已使用 JDT LS 1.62.0 / JDK 25 验收通过；大型业务仓库的索引完整性仍需逐仓库验证。

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
codexpro trace timeline --last --html ./codexpro-timeline.html
codexpro trace timeline --job check_xxx --html ./codexpro-job-timeline.html
codexpro trace timeline --trace-id tr_xxx --html ./codexpro-change-timeline.html
codexpro trace timeline --request req_xxx --json
```

**实时查看（推荐）**：在运行 `codexpro start --mcp-trace redacted` 的终端出现 `codexpro>` 后，直接按 **`t`**，即可启动仅监听 `127.0.0.1` 的 Trace Explorer 并自动在本机浏览器打开。再次按 `t` 会重新打开同一个页面。终端中已有的 Enter / c / o / q 快捷键不变；`q` 停止 CodexPro 时查看器也随进程退出。

也可以在另一个终端独立启动（支持无日志文件时等待后续事件）：

```bash
codexpro trace explorer
codexpro trace explorer --trace-dir ~/.codexpro/traces --no-open
```

实时页面默认打开「文件变更」标签：左侧按文件聚合，按最近修改排序；中间以纵向修改记录浏览每一次操作；右侧提供同步对齐的 Before/After Diff。需要排查 MCP/HTTP/SSE 调用时可切换至「协议事件」标签。顶部保留全局搜索，项目（workspace ID）、开始/结束时间、工具及文件路径放在可展开的筛选面板中。选择同一文件的某次修改，点击「上一次 / 下一次」逐步查看代码 Diff；展开「比较多个修改步骤」后可选择起止记录，按时间顺序展示多次 Patch。每一步记录的是操作级差异，**不是完整文件快照，也不保证能计算任意两个历史版本的最终净差异**。多文件 `apply_patch` 在实时页面中按当前选中文件拆分 Diff，并按文件统计增删行数；无法可靠定位（如二进制变更、日志截断）时显示缺失提示，不混入其他文件内容。Diff 默认单栏展示，可切换双栏，长代码支持横向滚动，成对的删除/新增代码展示字符级高亮。浏览器通过本地 SSE 接收变更提醒；不会把查看器挂载到公网 MCP 服务或隧道。查看器地址包含随机访问令牌，请勿转发；进程重启后地址会变化。Trace 默认关闭，若未开启记录只能查看已存在的日志。

**Agent 执行轨迹**：点击「Agent 执行」标签，按一次 MCP 请求的 `trace_id` 查看工具调用时间线、命令与工作目录、退出状态、已保留的脱敏 stdout/stderr、托管检查的 `execution.*` 进度与输出片段、失败信息及关联文件修改。点击关联修改可跳转至文件 Diff。筛选条件对请求列表同样生效；列表最多返回最近 80 条匹配请求，单条详情最多显示最近 250 步，索引仍受最近 12000 条事件限制。**该页面展示的是可观察到的工具执行事件，不是 ChatGPT 隐藏推理，也不是完整聊天记录**；同步 `bash` 输出通常在工具结束后可见，托管检查有持续输出事件，未被 Trace 记录或被截断的内容无法补全。

**跨请求任务回放（显式 `task_id`）**：在「Agent 执行」标签中切换「按任务」，即可把同一个客户端任务的多个 MCP 请求按真实时间顺序串起来。关联标识必须由客户端**按任务明确传入**，且满足 1–64 字符（字母或数字开头，后续可用字母、数字、`_`、`.`、`:`、`-`）。支持以下两种输入方式，HTTP 请求头优先：

- HTTP MCP 请求头：`X-CodexPro-Task-Id: task_review_42`
- MCP JSON-RPC 请求 `params._meta["codexpro/task_id"]`：值为同一个 `task_review_42`。

同一任务的每次请求使用相同标识，不同任务使用不同标识；**不要在多个无关聊天任务共用的连接配置中永久固定一个任务 ID**。未标记、无效或旧版日志不会凭 MCP Session、时间或工作区自动归组，仍可在「按请求」查看。当前 Task 列表最多展示 80 条，单任务详情最多显示 400 步，整体受最近 12000 条事件的内存索引限制。任务标识仅供日志关联，不具备鉴权作用；不记录隐藏推理或完整聊天内容。若客户端不支持自定义请求头或 MCP `_meta`，则需要先扩展客户端传值能力，不能自动获得可靠的跨任务归属。

**ChatGPT 自动会话关联**：在「Agent 执行」标签选择「按会话」。ChatGPT 客户端支持在工具调用的 MCP `params._meta["openai/session"]` 中提供匿名化会话 ID，CodexPro 会自动把此标识转换为 SHA-256 摘要 `conversation_id`，仅存储摘要并从原始请求 Trace 中遮盖该字段，无需手动设置 `task_id`。可在一个会话下按时间顺序查看多次 MCP 工具调用、命令输出和文件修改。其他客户端如果未提供该元数据，则不会出现在「按会话」中；历史日志也无法补出缺失的标识。**同一个聊天可能包含多个开发任务，因此「按会话」不保证精确任务边界，「按任务」仍需显式 `task_id`**。会话 ID 只用于日志关联，不能用于鉴权或代替完整聊天内容。当前列表最多 80 个会话，单会话最多展示最近 400 步；仍受最近 12000 条 Trace 事件索引限制。官方参考：https://developers.openai.com/plugins/reference。

**扩展代码阅读空间**：在文件标题右侧点击「隐藏文件列表」可收起左侧文件栏；在 Diff 工具栏点击「隐藏修改记录」可收起版本栏。两个栏位可以独立展开/折叠，不会丢失当前文件和修改版本。点击「全屏审查」进入**页面内全屏代码审查**（覆盖页面导航和两侧栏，不调用浏览器原生全屏），点击「退出全屏」或按 **Esc** 返回；退出后恢复之前的折叠状态。实时刷新不会重置这些布局选择。

**离线导出**：用浏览器打开生成的本地 HTML 文件，即可按时间展开 HTTP、MCP、Tool、Execution Supervisor 和 SSE 事件。页面顶部的 **Change history** 汇总选定 Trace 中 `write`、`edit`、`apply_patch` 成功操作产生的文件变更，展开后可以查看代码修改前后的左右对比，并通过 `span_id` 找到对应的工具调用。旧 Trace 在保留了完整工具返回值时也可展示差异；`meta` 模式只保留变更元数据，截断的 Patch 只显示预览，不应当作完整历史。SSE 的 `mcp.sse.chunk`、`mcp.sse.event`、`mcp.sse.summary` 只记录分块大小、完整帧数和事件类型等元数据，不额外复制 `data:` 负载；长流对明细记录做采样，但最终计数保持完整。

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
