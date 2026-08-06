# pincer

The Claude Code experience, as a package for the [pi coding agent](https://github.com/earendil-works/pi) — so the same workflow runs on **any model provider**, and upstream pi improvements arrive as a version bump.

It brings across the parts of Claude Code that live in the harness rather than the model: a ported system prompt, a permission system that reads your existing `.claude/settings.json`, `<system-reminder>` steering, read-before-write guards, subagents, ultracode workflows, todos, plan mode, skills, MCP, and ToolSearch-style deferred tool loading.

Your existing Claude Code setup works unchanged — `CLAUDE.md`, `.claude/commands`, `.claude/skills`, `.claude/agents`, `.mcp.json`, and installed plugins are all picked up.

## Requirements

- **Node 22.19 or newer** (pi's requirement; check with `node --version`)

  If you manage Node with nvm and your default is older, `pi` will be missing from
  new terminals — it lives in the bin directory of whichever version you installed
  it under. Either make that version your default (`nvm alias default 22`), or drop
  a small shim on your `PATH` that pins pi to a suitable version, which leaves the
  default alone.
- **pi** — `npm install -g @earendil-works/pi-coding-agent`
- Credentials for at least one model provider (`pi` will prompt, or use `/login`)

## Install

```bash
pi install npm:pincer-agent
```

From a local checkout instead — note the `npm install`, because a path install does **not** fetch dependencies and the extensions will fail to load without them:

```bash
git clone https://github.com/IsuruMaduranga/pincer-agent
cd pincer-agent && npm install && cd ..
pi install ./pincer-agent
```

Confirm it registered:

```bash
pi list
```

## Running it

Just run pi — the package loads automatically in every session:

```bash
cd your-project
pi
```

That's the whole story for interactive use. Other modes:

```bash
pi -p "explain what src/server.ts does"        # one-shot, prints the answer
pi -c                                          # continue the last session
pi --mode json -p "…"                          # one JSON event per line, for scripts
pi --permission-mode plan                      # start in read-only planning mode
pi --dangerously-skip-permissions              # no prompts (use deliberately)
```

Switch models mid-session with `/model`, or pick one at launch:

```bash
pi --model anthropic/claude-sonnet-5
pi --model openai-codex/gpt-5.5
pi --model ollama/qwen3-coder      # any provider in ~/.pi/agent/models.json
```

## What you get

**Always available:** pi's file and shell tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) plus `subagent`, `workflow`, `todo_write`, `skill`, `ask_user_question`, `enter_plan_mode`, `exit_plan_mode`, and `tool_search`.

**Loaded on demand** via `tool_search`, so their schemas stay out of the prompt until needed: `web_search`, `web_fetch`, `url_context`, `notebook_edit`, `lsp_diagnostics`, `list_mcp_resources`, `read_mcp_resource`, and every MCP tool. On Anthropic and recent OpenAI models this uses the provider's native deferred-tool mechanism, so loading a tool doesn't invalidate the cached prompt prefix.

### Slash commands

| Command | What it does |
|---|---|
| `/permissions` | Show the current mode, loaded rules, and recent auto-mode denials |
| `/auto-mode [defaults\|config]` | Built-in vs effective classifier rules |
| `/allow <rule>` | Persist an allow rule, e.g. `/allow Bash(npm test:*)` (add `global` for user scope) |
| `/agents`, `/skills`, `/todos` | List available agents, skills, current todos |
| `/effort` | Reasoning effort slider, including `ultracode` (xhigh + workflows) |
| `/workflows` | Workflow runs and saved workflows; `stop <runId>` / `log <runId>` |
| `/plugins`, `/mcp`, `/lsp` | Status of plugins, MCP servers, language servers |
| `/tools-deferred` | Which tools are deferred vs loaded |

Plugin commands appear namespaced, e.g. `/commit-commands:commit`.

### Workflows (ultracode)

For work that is worth spreading across many agents — a broad audit, a
migration, a review that should be independently double-checked — say
**`ultracode`** in your message, or just ask for a workflow. The model then
writes a short JavaScript orchestration script and runs it through the
`workflow` tool.

To leave it on rather than saying the word each time, run **`/effort`** and pick
the last stop on the slider:

```
Effort

Faster                                          Smarter
────────────────────────────────────────────│──────────
                                                  ▲
off  minimal  low  medium  high  xhigh  max │ ultracode
                                              xhigh + workflows
```

`ultracode` is xhigh reasoning *plus* orchestration armed on every turn, which is
why it sits past `max` behind a divider. The plain stops are the same ones
shift+tab cycles — pincer calls that dial "effort" throughout, since it is one
dial with two ways to reach it — and `/effort <level>` sets any of them directly.
A footer `✦ ultracode` shows while the mode is on, and cycling with shift+tab
turns it back off. Here is what a script looks like:

```js
export const meta = { name: 'audit', description: 'find routes missing auth', phases: [{ title: 'Scan' }, { title: 'Audit' }] }
phase('Scan')
const files = await agent('List every route file under src/routes/.')
phase('Audit')
return await pipeline(
  files.split('\n').filter(Boolean),
  file => agent(`Audit ${file} for missing auth checks.`, { label: file }),
)
```

Each `agent()` call is a subagent with its own context window, so only what the
script keeps comes back. `parallel()` fans out with a barrier, `pipeline()`
without one; pass a JSON Schema as `schema` to get a validated object instead of
text, and `isolation: 'worktree'` when parallel agents will edit files.
Concurrency is capped at 16.

Runs go to the background: you get a run id immediately, a live progress panel,
and the result as a follow-up message. `/workflows` lists runs and saved
workflows, `/workflows stop <runId>` ends one. Every run journals its completed
agent calls, so re-running with `resumeFromRunId` replays the unchanged prefix
from cache instead of paying for it twice — edit the script and only what
changed re-runs. Drop a script in `.claude/workflows/` (project) or
`~/.claude/workflows/` (personal) to invoke it by name.

Workflow agents obey your permission rules: `deny` rules always win, edits are
allowed as Claude Code does for subagents, and anything that would normally
prompt is refused, since there is nobody to ask mid-run.

## Configuration

Everything is read from Claude Code's locations, so there is nothing new to learn.

**Permissions** — `.claude/settings.json` in the project, `~/.claude/settings.json` for user-wide, `.claude/settings.local.json` for personal project overrides:

```json
{
  "permissions": {
    "allow": ["Bash(npm run test:*)", "Read"],
    "deny": ["Read(.env)", "Bash(rm -rf:*)"],
    "ask": ["Bash(git push:*)"],
    "defaultMode": "default"
  }
}
```

Claude Code's PascalCase tool names are mapped automatically (`Bash`, `Glob`, `WebFetch`, `Task`, …), so rules you already have keep working. `deny` beats everything, including `bypassPermissions`.

**ctrl+q** cycles the permission mode — manual → accept edits → plan → auto —
with a footer badge showing where you are (`⏸ manual mode on`, `⏵⏵ accept edits
on`, `⏸ plan mode on`, `⏵⏵ auto mode on`). Claude Code puts this cycle on
shift+tab, but pi reserves that key for the thinking dial, so pincer uses the
one ctrl+letter both pi and terminals leave free. `bypassPermissions` joins the
cycle only when the session was started with it; `dontAsk` (deny instead of
prompting) is available via `--permission-mode dontAsk` or `defaultMode`.
`manual` is accepted as an alias for `default` everywhere a mode is named.

**Auto mode** removes routine prompts without removing the boundary: instead of
asking you, each tool call is screened by a classifier. `deny` rules are applied
before it and `ask` rules always prompt, so those stay authoritative. Reads and
in-project work go through untouched; writes outside the working directory,
credential paths, force pushes, production deploys, and `curl | bash` get
stopped — unless your own message named the operation and its target, which
clears the rules marked as clearable. After 3 consecutive or 20 total blocks
auto mode pauses and prompts instead; approving a prompt resumes it.

Some paths are never auto-approved in any mode but `bypassPermissions`, however
your rules are written: `.git`, `.claude`, `.vscode`, `.husky`, `.mvn`, shell rc
files, `.npmrc`, pre-commit config, and build wrappers like `mvnw`. Writes there
take effect later without further approval, so the check runs *before* allow
rules — an `Edit(.claude/**)` rule cannot pre-approve rewriting this agent's own
permissions. In auto mode they route to the classifier; in manual and accept-edits
they prompt.

Subagents are checked at three points in auto mode: the delegated task before the
child starts, each of the child's own actions (it inherits the mode), and the
child's action list when it returns — that last one catches a sequence whose
individual steps each passed, and prepends a warning to the result rather than
blocking work that has already happened.

Shell commands hit a deterministic pre-gate first. It can only ever conclude
"provably safe" — never "unsafe" — so plainly read-only commands skip the
classifier entirely, and anything it cannot clear goes to the classifier with
the facts it extracted (resolved write targets, whether they escape the working
directory, credential paths, the real command behind any wrapper).

Configure it in `~/.claude/settings.json`, using Claude Code's `autoMode` schema:

```json
{
  "autoMode": {
    "environment": ["$defaults", "Source control: github.example.com/acme-corp"],
    "allow": ["$defaults", "Deploying to the staging namespace is allowed"],
    "soft_deny": ["$defaults", "Never run migrations outside the migrations CLI"],
    "hard_deny": ["$defaults"],
    "classifyAllShell": false
  }
}
```

Rules are prose, not patterns — the classifier reads them as instructions.
`"$defaults"` splices the built-in rules in at that position; omitting it
replaces that list entirely. `classifyAllShell: true` sends every shell command
to the classifier, ignoring narrow `Bash(...)` allow rules (broad ones like
`Bash(*)` are always suspended in auto mode). `/auto-mode defaults` prints the
built-in rules and `/auto-mode config` prints what is actually in effect.

`autoMode` is read from user and managed settings only, never from the project's
`.claude/settings.json` — otherwise a checked-in file could grant itself allow
rules and switch off the gate meant to contain it.

**Project instructions** — `CLAUDE.md` (or `AGENTS.md`), discovered from the working directory upward.

**Subagents** — markdown with frontmatter in `.claude/agents/` (project) or `~/.claude/agents/` (user):

```markdown
---
name: reviewer
description: Reviews a diff for correctness problems
tools: read, grep, find, ls
model: anthropic/claude-sonnet-5
---

You review code for correctness. Report findings as path:line with a one-line
explanation each.
```

Three are bundled: `general-purpose`, `explore` (read-only search), `plan` (read-only architect). A definition of yours with the same name wins. `agent: "fork"` runs a child that inherits the current conversation, and `isolation: "worktree"` gives a child its own git worktree.

**Skills** — standard [Agent Skills](https://agentskills.io) directories: `.claude/skills/`, `~/.claude/skills/`. Invoked by the model through the `skill` tool.

**MCP servers** — `.mcp.json` in the project (walked up to the repo root), or `~/.claude.json`:

```json
{
  "mcpServers": {
    "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] },
    "internal": { "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer $TOKEN" } }
  }
}
```

Tools appear as `mcp__<server>__<tool>` and are deferred behind `tool_search`.

**Plugins** — anything installed in `~/.claude/plugins` contributes its agents, skills, commands, and MCP servers, namespaced `<plugin>:<name>`.

**Environment variables** — the package's own switches, all optional:

| Variable | Effect |
|---|---|
| `CC_NO_BANNER=1` | Keep pi's original startup header instead of this package's mascot banner. |
| `CC_CLEAR_THINKING=0` / `=1` | Long-session context trimming (Anthropic `context_management` / `clear_thinking`). Default: **on** for first-party Anthropic (api.anthropic.com), **off** for Bedrock/Vertex/proxies. `0` forces it off anywhere; `1` forces it on for an anthropic-messages endpoint you have confirmed accepts it. |
| `CC_VERSION` | Version string shown in the banner (defaults to the package version; useful for wrappers that pin their own). |
| `CC_E2E_LOG=<path>` | Development only, with `test/e2e/debug-capture.ts` loaded via `-e`: append every raw provider request to `<path>` as JSONL. Note it logs payloads *before* this package's extensions mutate them. |

## Optional extras

- **Web search** uses your current model provider's own search API (OpenAI/Codex, Anthropic, Gemini) — no extra key, but it needs a provider that offers one.
- **LSP diagnostics** after edits need the language server on your `PATH`: `npm i -g typescript-language-server typescript` for TypeScript, or `pyright`, `gopls`, `rust-analyzer`. TypeScript projects need **typescript 5.x** — version 7's native compiler no longer ships the `tsserver.js` that `typescript-language-server` requires.
- **Themes.** Two ship with the package: `pincer` (dark) and `pincer-light` — a warm clay accent with neutral surfaces, in the spirit of Claude Code's terminal. Select one with `/settings`, or set it directly:

  ```json
  { "theme": "pincer" }
  ```

  in `~/.pi/agent/settings.json`. pi hot-reloads a theme file while it is active, so you can tweak `themes/pincer.json` and watch it change.
- **The startup banner** is replaced with this package's own. `CC_NO_BANNER=1` restores pi's.
- **Hide pi's startup resource listing** (whose `[Extensions]` section lists this package's twenty-odd internal modules) by setting `"quietStartup": true` in `~/.pi/agent/settings.json`. The banner detects this and shows compact `context` / `skills` / `workflows` / `themes` lines instead — same information, no extension noise.
- **Long-session context trimming on Anthropic**: on by default for first-party Anthropic — the API is asked to drop old thinking blocks, as Claude Code does. See the `CC_CLEAR_THINKING` row in Configuration and `docs/decisions.md`.

## Known limitations

- **No sandbox.** pi runs shell commands with your privileges; the permission system decides *whether* a command runs, not what it can reach. For a hard boundary, run pi in a container or add a sandbox extension — see pi's `docs/containerization.md`.
- **Subagents run in the foreground.** No detached runs, so no `TaskOutput`/`TaskStop` equivalents yet. (Workflows *do* run in the background, with `/workflows stop`.)
- **Background workflow runs end with the session.** They do not survive `/reload` or switching sessions; resume one with its run id and the journaled prefix replays for free.
- **`web_fetch` returns extracted markdown** (windowed, with pagination) rather than summarising the page with a small model.
- Verified end-to-end on OpenAI/Codex and Anthropic models, including Anthropic's native deferred-tool loading, the pre-5.4 fallback, and `context_management` trimming. Bedrock/Vertex/proxy endpoints are not yet exercised — context trimming stays off there by default.

## Development

### Running the checkout you are working on

Register the repo once as a pi package; after that every `pi` session anywhere on
the machine loads your working copy, so there is nothing to rebuild:

```bash
cd pincer-agent
npm install                     # required — a path install does not fetch deps
pi install .                    # register this checkout
pi list                         # confirm it is listed

cd ~/some-project && pi         # your working copy is live here
```

Editing an extension takes effect on the next session — **restart `pi`** (or try
`/reload`, which re-reads auto-discovered extensions). Useful while iterating:

```bash
pi -ne                                       # start with NO extensions (bisect a break)
pi -e ./extensions/<name>/index.ts -p "…"    # load one extension in isolation
pi --no-session -p "…"                       # one-shot, leaves no session behind
```

`pi remove .` unregisters it again.

### Checks

```bash
npx tsc --noEmit     # typecheck
npx vitest run       # unit tests
```

Logic lives in pure modules with no pi imports (unit-tested); each `index.ts` is thin wiring (verified end to end). Interactive behaviour — permission prompts, plan approval, questions — can only be driven through `pi --mode rpc`; see `test/e2e/rpc-permission-test.mjs`. To inspect what actually reaches the model, load `test/e2e/debug-capture.ts` with `-e` and set `CC_E2E_LOG=/path/log.jsonl`.

`docs/decisions.md` records why the package is shaped the way it is, including which community packages were adopted, rejected, or replaced and on what evidence.

## License

MIT — see [LICENSE](LICENSE).
