<p align="center">
  <img src="docs/favicon.svg" width="72" height="72" alt="CodexPro logo">
</p>

<h1 align="center">CodexPro</h1>

<p align="center">
  Give ChatGPT local coding tools for repos you explicitly allow.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/codexpro"><img alt="npm" src="https://img.shields.io/npm/v/codexpro?style=flat-square"></a>
  <a href="https://github.com/rebel0789/codexpro/actions"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/rebel0789/codexpro/ci.yml?branch=main&style=flat-square"></a>
  <a href="https://github.com/rebel0789/codexpro/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/rebel0789/codexpro?style=flat-square"></a>
  <a href="https://rebel0789.github.io/codexpro/"><img alt="Website" src="https://img.shields.io/badge/site-GitHub%20Pages-67e8f9?style=flat-square"></a>
</p>

## What it is

CodexPro is a local MCP server. It connects **your ChatGPT session** to **your machine** and **repos you allow**.

ChatGPT can read, search, edit, review, verify, import attachments, and write handoff plans. It stays inside those roots.

It is not a hosted SaaS product, model proxy, quota bypass, account pool, or remote shell service.

## Install

Needs:

- Node.js 20+
- A ChatGPT account that can create custom MCP plugins
- An HTTPS URL to your machine for ChatGPT web (tunnel or Tailscale Funnel)

```bash
npm install -g codexpro
cd /path/to/your/repo
codexpro setup
```

## Connect in ChatGPT

1. `Settings -> Security and login` → turn **Developer mode** on (keep CSP enforcement on).
2. `Settings -> Plugins` → Plugins tab → **+** beside Search plugins.
3. Create a plugin named `CodexPro`.
4. Connection: **Server URL** → paste the URL CodexPro copied.
5. Authentication: **No Authentication / None** (change this if the form defaults to OAuth).

CodexPro auth is the token already in that URL. Do not share the URL.

| Open Plugins and click `+` | Complete the New Plugin form |
| --- | --- |
| ![Open Plugins and click the plus button](docs/images/chatgpt-plugins-add.png) | ![Complete the New Plugin form](docs/images/chatgpt-plugin-details.png) |

Windows PowerShell is supported as an opt-in command runtime without Git Bash. On Windows, run `codexpro start --bash-runtime powershell` for Windows PowerShell 5.1, or `--bash-runtime pwsh` for an installed PowerShell 7. The default `auto` preserves the existing Git for Windows Bash behavior. PowerShell uses UTF-8 streams, native .cmd package-manager shims to avoid PowerShell script-policy conflicts, and the existing process timeout/cancellation controls. Safe mode permits a restricted set of diagnostics and test scripts; opt into `--bash full` only for trusted workspaces. Use dedicated CodexPro tools for Git status/diffs and file reads.

Daily use from the same repo:

```bash
codexpro start
```

If plugin creation fails, run `codexpro connection-test` and check whether ChatGPT requests reach the local server.

## What ChatGPT can do

With workspace write mode (the normal agent setup):

- read, search, and inspect the repo with bounded code intelligence
- edit with `write`, `edit`, or guarded `apply_patch`
- import ChatGPT attachments with `import_file`
- run allowlisted checks with `bash`
- review diffs and likely impact with `show_changes`
- write plans under `.ai-bridge`
- export a context bundle for chats that cannot call tools

### Built-in repository intelligence

CodexPro does more than raw file search:

- `inspect_workspace` maps languages, project types, entrypoints, areas, symbols, and internal relationships.
- `search` supports targeted `symbol`, `references`, and `impact` intents as well as ordinary text and regex search.
- `show_changes` identifies affected areas, likely dependents, related tests, risk signals, and relevant verification commands.
- TypeScript/JavaScript, Python, Go, Rust, Swift, Java, C#, C, and C++ declarations are recognized. Other languages retain safe inventory and lexical search.

Analysis is local, bounded, and cached by a workspace fingerprint. It needs no model API key, language-server daemon, embedding service, or vector database. Coverage and inference strength are reported instead of presented as certainty.

### Product focus

CodexPro is optimized for a narrow loop: connect ChatGPT to explicitly allowed local repositories, make a reviewable change, verify it, and preserve a handoff record. The project prioritizes:

- explicit workspace boundaries and separate controls for reads, writes, commands, sessions, and handoffs
- useful code navigation without sending a repository to a separate indexing service
- cross-platform installation and release checks on supported Node.js versions
- compact, bounded tool results that remain usable in long ChatGPT sessions

See the [roadmap](ROADMAP.md) for the next reliability, code-navigation, and workflow improvements.

## Multiple projects

One CodexPro process can allow more than one repo:

```bash
codexpro settings set --project ~/code/web --project ~/code/api
codexpro settings show
codexpro start
```

Ask ChatGPT to `open_workspace` on an allowed project. `open_current_workspace` returns to the launch repo. `list_workspaces` keeps its existing opened-only `workspaces` field and adds `configured_workspaces` (including unopened roots, aliases, and selection state).

Use `codexpro settings set --root /code/api --alias web=/code/web` to save a named project, then `open_workspace({alias: "web"})` to select it. The repeatable `--alias name=path` flag also works for a single launch and includes those roots in the allowlist.

`list_workspaces.workspaces` and `selected_workspace_id` remain MCP-session-local for backwards compatibility; `server_opened_workspaces` and `configured_workspaces[].opened` expose workspace openings shared by sessions in the same CodexPro server process. Always pass a stable workspace ID or a configured alias as `workspace_id: "web"` when switching transports; another session cannot safely change your default selection.

For bounded, read-only static cross-project checks, use `analyze_workspace_dependencies({source_workspace_id: "ws_...", target_workspace_id: "ws_..."})` with IDs from `list_workspaces`. It returns evidence from npm/Maven manifests and Java/TS/JS imports with file and line locations; this is **not** a complete runtime call graph.

Vue SFC indexing now recognizes TypeScript/JavaScript declarations in `<script>` and `<script setup>` and relative imports with original `.vue` line numbers. Template references and full Vue type resolution are not yet covered. Optional `CODEXPRO_PYTHON_AST=1` enables bounded Python 3 standard-library AST parsing of classes, synchronous/async functions and resolvable local imports without executing repository modules. Set `CODEXPRO_PYTHON_EXECUTABLE` to select a Python 3 binary; without the flag or an available interpreter, indexing falls back to the existing lexical analysis.

For read-only API evidence across Vue/JS, Java and Python workspaces, use `analyze_api_contracts({frontend_workspace_id:"web", backend_workspace_id:"api", python_workspace_id:"model"})` after configuring these workspace aliases. The tool performs bounded static analysis of literal `fetch`, `EventSource`, Axios-like requests, Spring MVC mappings, adjacent Java WebClient `.post().uri(...)` calls, and single-line FastAPI route decorators. It reports two independent sets of candidate links (frontend → backend, backend → Python), line evidence, HTTP methods, SSE hints and coverage warnings. Matching static paths **does not prove runtime connectivity, correct base URLs, authentication or payload compatibility**, and it does not compose a verified end-to-end execution graph. Dynamic paths and complex routing are intentionally omitted.

For long-running tasks, `save_task_checkpoint` records explicit step progress and linked workspace fingerprints under `CODEXPRO_HOME/runtime/task-checkpoints/`, outside source repos. On reconnect use `recover_work` then `get_task_checkpoint` to review the next step and detect changes; `list_task_checkpoints` lists saved tasks. New tasks use `expected_revision: 0`; subsequent saves must provide the latest revision. Completed steps are user/agent-reported rather than verified. Recovery never automatically replays edits, and saving is disabled when write mode is off.

For two ChatGPT accounts or hard isolation, run two CodexPro processes on different ports and Server URLs.

## Commands

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

Useful modes:

```bash
codexpro start --no-bash
codexpro start --tool-mode minimal
codexpro start --tool-mode full
codexpro start --mode handoff
codexpro start --mode pro
codexpro start --headless
```

Opt-in tool cards:

```bash
CODEXPRO_TOOL_CARDS=1 codexpro start
```

## MCP request, SSE and execution timeline

For diagnosing ChatGPT disconnects, MCP timeouts or silent long-running checks such as `vue-tsc`, explicitly enable redacted tracing:

```bash
codexpro start --mcp-trace redacted
codexpro trace tail --lines 30
codexpro trace show --job check_xxx --json
codexpro trace timeline --job check_xxx --html ./codexpro-timeline.html
codexpro trace timeline --request req_xxx --json
```

Open the resulting offline HTML in a browser for an expandable, time-aligned view of HTTP, MCP, tool, execution and SSE events. SSE `mcp.sse.chunk`, `mcp.sse.event`, and `mcp.sse.summary` retain metadata (byte counts, frames and event types), not raw `data:` payloads. Very long streams sample detailed events while keeping complete aggregate counts.

Tracing is off by default. Even redacted traces may contain source previews, paths, commands and business information. Keep exported files private. The viewer contains no scripts or external dependencies and never overwrites an existing file. HTTP `finish` means Node completed its response write, not necessarily that ChatGPT received or processed it.

### Live console diagnostics (recommended for silent long-running requests)

This is independent of JSONL tracing. In the terminal starting CodexPro, enable:

```bash
CODEXPRO_LOG_REQUESTS=1 CODEXPRO_LOG_TOOL_CALLS=1 CODEXPRO_LOG_HEARTBEAT_MS=10000 codexpro start --mcp-trace redacted
```

HTTP and tool console messages use the CodexPro host's local time with an explicit UTC offset (for example, `2026-10-08 22:32:50.123 +08:00`). Persisted Protocol Trace JSONL continues to use UTC timestamps ending in `Z` for cross-machine correlation. A tool logs `start`, `running elapsed_ms` every 10 seconds, then `ok/error` with its final duration. Direct `bash` calls also expose PID, cumulative output bytes and last-output age. Only recognized npm/pnpm/yarn/bun verification script names appear; all other commands are labeled `custom-command` instead of echoing arbitrary shell content or credentials. Match HTTP and tool messages by `request_id`.

`GET /mcp received stream=sse` is usually a **normal long-lived SSE connection**, and not receiving an immediate HTTP completion log is expected. The logger prints periodic idle heartbeats (at least 30 seconds apart). `POST /mcp pending` and `bash running` identify active work; `closed client_aborted=true` identifies a response closed before normal completion. For long typechecks, builds and test suites, use `start_check` and poll `wait_check` instead of keeping one synchronous `bash` MCP request open for minutes.

## Public HTTPS options

ChatGPT web needs HTTPS:

```bash
codexpro start --tunnel cloudflare          # quick demo URL (changes)
codexpro ngrok --hostname your.ngrok-free.dev
codexpro stable --hostname codexpro.example.com --tunnel-name codexpro
codexpro tailscale --hostname your-device.your-tailnet.ts.net
codexpro start --tunnel none                # local only
```

Keep a stable token for stable hostnames:

```bash
mkdir -p ~/.codexpro
openssl rand -hex 32 > ~/.codexpro/http-token
chmod 600 ~/.codexpro/http-token
```

Prefer `Authorization: Bearer <token>` when the client supports headers. The `?codexpro_token=` query form is a personal compatibility fallback.

## Safety defaults

- Public tunnels require a CodexPro HTTP token (min 24 bytes)
- Writes stay hidden unless write mode is `workspace`
- Safe bash is the default
- Blocked paths cover `.env`, keys, `.git`, build caches, and similar
- Attachment import only accepts ChatGPT Apps SDK file objects from approved HTTPS hosts

Read [SECURITY.md](SECURITY.md) before exposing a tunnel.

## Update

```bash
npm install -g codexpro@latest
codexpro --version
```

Restart `codexpro start` after updating. Saved profiles under `~/.codexpro` stay in place.

## Development

```bash
npm install
npm run build
npm run smoke
npm run stress
npm run package:smoke
npm run release:check
```

Publish only from the CodexPro root:

```bash
cd /path/to/codexpro
npm run release:publish
```

## Docs

- [Website](https://rebel0789.github.io/codexpro/)
- [FAQ](FAQ.md)
- [Security](SECURITY.md)
- [Roadmap](ROADMAP.md)
- [Stable URL guide](DOMAIN_SETUP.md)
- [Changelog](CHANGELOG.md)
- [Contributors](CONTRIBUTORS.md)
