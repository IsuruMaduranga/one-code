# Configure One Code

Use this page to find the right settings file, learn what One Code stores
and where, change the terminal appearance, and set up language-server
diagnostics. Provider keys are covered in
[Providers and models](providers-and-models.md); permission rules in
[Permissions, modes, and auto mode](permissions-modes-and-auto-mode.md).

## Where settings live

Three kinds of files are involved: pi's own settings (terminal, theme,
default model), One Code's settings, and Claude Code's settings, which One
Code reads but never writes.

| What you want to change | File |
|---|---|
| Theme, full-screen mode, and other pi settings, in the `onecode` app | `~/.onecode/agent/settings.json` |
| The same, on your own pi installation | `~/.pi/agent/settings.json` |
| One Code's user-wide settings: subagent model, auto-mode configuration, global allow rules, web-search keys, disabled MCP servers | `~/.onecode/settings.json` |
| One Code's per-repository settings: allow rules and disabled MCP servers for one repository | `~/.onecode/projects/<slug>/settings.json` |
| Claude Code user configuration that One Code reads | `~/.claude/settings.json` |
| Claude Code project configuration that One Code reads | `.claude/settings.json`, `.claude/settings.local.json` |

The per-repository slug is derived from the repository root, so worktrees
and subdirectories of one repository share one file.

Commands such as `/allow`, `/subagent`, `/auto-mode model`, and the
`/mcp` panel write to One Code's files. Both One Code files are written
atomically; a malformed file is reported rather than overwritten.

### Relocating directories

| Variable | Moves |
|---|---|
| `ONECODE_STATE_DIR` | One Code's state (default `~/.onecode`). |
| `PI_CODING_AGENT_DIR` | pi's agent directory. The bundled app sets it to `~/.onecode/agent`. |
| `CLAUDE_CONFIG_DIR` | Where Claude Code's user configuration is read from (default `~/.claude`). |

Setting one does not move the others.

## What is stored under ~/.onecode

| Path | Contents |
|---|---|
| `settings.json` | User-wide One Code settings. |
| `projects/<slug>/settings.json` | Per-repository settings. |
| `agent/` | pi's own state under the bundled app: credentials, model catalog, sessions, pi's settings, and One Code's plugin directory (`agent/plugins/`). |
| `plans/<name>.md` | Plan files from plan mode. |
| `hooks/project-approvals.json` | Which projects' hooks you approved. |
| `mcp/project-approvals.json` | Which projects' MCP servers you approved. |
| `permissions/project-allow-approvals.json` | Which projects' allow rules you trusted. |
| `mcp-auth/<server>.json` | OAuth tokens for MCP servers, owner-readable only. |
| `cache/artificial-analysis.json` | The cached model-capability snapshot, when a key is set. |
| `hooks/hooks-decisions.jsonl` | A hook decision log, written only while `CC_HOOKS_DEBUG` is set. |

The bundled app also keeps a timestamp of its last update check at
`agent/last-update-check`.

## Settings reference

Keys in `~/.onecode/settings.json`. Keys marked "per repository" may also
appear in `projects/<slug>/settings.json`.

| Key | Type | Set by | Effect |
|---|---|---|---|
| `subagentModel` | string | `/subagent` | Default model for subagents and workflow agents: `provider/model-id`, a short alias, or `inherit`. |
| `permissions.allow` | string array | `/allow` (per repository) or `/allow … global` | Allow rules in Claude Code's format. |
| `autoMode.environment` | string array | `/auto-mode setup` | Describes your environment to the classifier. |
| `autoMode.hard_deny`, `autoMode.soft_deny`, `autoMode.allow` | string array | `/auto-mode setup` | Extra classifier rules, appended to the built-ins. |
| `autoMode.classifierModel` | string | `/auto-mode model` | The classifier model. |
| `autoMode.classifyAllShell` | boolean | By hand | Send every shell command to the classifier. |
| `autoMode.logDecisions` | boolean | By hand | Log every gate decision next to the session files. |
| `webSearch.apiKeys.brave`, `webSearch.apiKeys.tavily` | string | By hand | Search keys when the environment variables are not set. |
| `webSearch.order` | string array | By hand | Order of the fallback search backends: `brave`, `tavily`, `exa-free`. |
| `capabilityIndex.artificialAnalysisApiKey` | string | By hand | Artificial Analysis key for measured model selection. |
| `disabledMcpServers` | string array | `/mcp` (user or per repository) | MCP servers kept disabled. |

Two keys are stamped alongside model choices (`subagentModelSetFor`,
`autoMode.classifierModelSetFor`) to record the provider a choice was made
on; leave them alone.

The main model chosen with `/model` is saved in pi's own settings file as
`defaultProvider` and `defaultModel`, not in One Code's.

## Full-screen mode and themes

The bundled app starts in full-screen mode with the `onecode` theme and
quiet startup. It sets these on first run in pi's settings and never
overrides a value you change later.

On your own pi, to use full-screen mode for one session:

```bash
pi --tui-mode fullscreen
```

For a persistent setting, merge these keys into pi's settings file (the
first two rows of the table under [Where settings live](#where-settings-live)),
preserving its other keys such as `packages`:

```json
{
  "tuiMode": "fullscreen",
  "theme": "onecode",
  "quietStartup": true
}
```

Use `"theme": "onecode-light"` for the light theme. Full-screen mode uses
the terminal's alternate screen and restores your terminal on exit.

One Code also works with other pi extensions, themes, and settings; see pi's
own documentation for those.

## Main and subagent models

Connect providers with `/login` and choose the main model with `/model`.
Set the subagent default with `/subagent`, or apply a preset with
`/doctor preset <economical|balanced|quality>`. See
[Providers and models](providers-and-models.md) and
[Choose the subagent model](subagents-and-workflows.md#choose-the-subagent-model).

## Permission settings

`/permissions` shows the mode and rules, `/allow` adds a rule, and
`/auto-mode setup` configures the classifier. **ctrl+q** cycles modes. To
start a session in a given mode:

```bash
onecode --permission-mode plan
```

A persistent default goes in a Claude Code settings file, not in
`~/.onecode/settings.json`. See
[Choose the starting mode](permissions-modes-and-auto-mode.md#choose-the-starting-mode).

## Language-server diagnostics

One Code runs a language server for each language it detects in the
project and reports diagnostics to the model after edits. The server must
be installed and on the `PATH` used to launch One Code.

| Language | Server | Install |
|---|---|---|
| TypeScript, JavaScript | `typescript-language-server` | `npm install -g typescript-language-server typescript` |
| Python | `pyright-langserver` | `npm install -g pyright` |
| Go | `gopls` | `go install golang.org/x/tools/gopls@latest` |
| Rust | `rust-analyzer` | `rustup component add rust-analyzer` |
| Java | `jdtls` | `brew install jdtls` |

A server is started for a language the first time the model touches one of
its files, from the nearest directory that has a project marker such as
`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, or `pom.xml`. A
server that crashes is restarted twice, then disabled for the session.

If the project's TypeScript installation lacks `lib/tsserver.js`
(TypeScript 7's native compiler), the server cannot start; One Code
reports this. Install a TypeScript 5.x development dependency in that
project.

Plugins can add servers through a `.lsp.json` file. A plugin's server takes
precedence over the built-in table for the file extensions it claims.

Run `/lsp` to see each server's status and diagnostic count, start
failures, and plugin configuration problems. `/doctor report` lists the
servers your project needs and whether they are installed.

## Environment variables

Every toggle is listed in the
[environment-variable reference](reference.md#environment-variables).
