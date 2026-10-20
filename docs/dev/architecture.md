# Architecture

[← Developer docs](README.md)

One Code is a set of [pi](https://github.com/earendil-works/pi) extensions.
pi supplies the agent loop, sessions, the terminal UI and the provider
clients. One Code adds the prompts, tools, permission system, steering and
agent coordination on top, using only pi's public extension API. Nothing in
this repository forks or patches pi.

This page shows how the pieces fit together. Each diagram has a short
explanation and names the files to open next.

- [The big picture](#the-big-picture)
- [The extensions, by role](#the-extensions-by-role)
- [One turn through the hooks](#one-turn-through-the-hooks)
- [How a tool call is decided](#how-a-tool-call-is-decided)
- [Steering the model: the reminder queue](#steering-the-model-the-reminder-queue)
- [Subagents and workflows](#subagents-and-workflows)
- [Configuration and state on disk](#configuration-and-state-on-disk)

## The big picture

Two npm packages ship from this repository. `one-code-extension` (the
repository root) is the pi package: the extensions, the bundled agents,
skills and themes. `@one-ai/one-code` (`app/`) is the `onecode` command. It
bundles an exact-pinned pi, keeps its state in `~/.onecode` and registers the
extension package, so users get One Code without installing pi themselves.

```mermaid
flowchart TB
    user(["Developer in a terminal"])

    subgraph appPkg["@one-ai/one-code &nbsp;(app/)"]
        bin["bin.mjs launcher<br/>Node version check · state in ~/.onecode<br/>registers the extension package"]
    end

    subgraph piPkg["pi harness"]
        direction LR
        tui["pi-tui<br/>terminal UI"]
        core["pi-coding-agent<br/>agent loop · sessions · built-in tools<br/>extension runtime and event hooks"]
        ai["pi-ai<br/>provider clients"]
    end

    subgraph extPkg["one-code-extension &nbsp;(repository root)"]
        direction LR
        exts["extensions/&lt;name&gt;/index.ts<br/>loaded in package.json order"]
        lib["extensions/lib/<br/>shared pure modules"]
        catalogs["agents/ · skills/ · themes/<br/>bundled catalogs"]
    end

    subgraph outside["Outside the process"]
        direction LR
        providers[("Model providers<br/>Anthropic · OpenAI · OpenRouter<br/>Gemini · local models")]
        claudeCfg[("Claude Code configuration<br/>CLAUDE.md · .claude/ · ~/.claude<br/>read-only")]
        ownState[("One Code state<br/>~/.onecode")]
        external["MCP servers · language servers<br/>shells · the web"]
    end

    user -->|onecode| bin --> core
    user -.->|"pi, with one-code-extension installed"| core
    core --- tui
    core --- ai
    core <-->|"loads · hooks · tools · commands · pi.events"| exts
    exts --- lib
    exts --- catalogs
    ai --> providers
    exts --> claudeCfg
    exts --> ownState
    exts --> external
```

Start with `package.json` (the `pi.extensions` list) and `app/bin.mjs`.

## The extensions, by role

Each folder under `extensions/` is one pi extension with a thin `index.ts`
that wires pi events to pure logic modules beside it. Shared logic lives in
`extensions/lib/`. `extensions/auto-mode/` is the one folder that is not an
extension: it is the auto-mode classifier library that `permissions` calls.

```mermaid
flowchart LR
    subgraph ctx["Prompt and context"]
        c1["system-prompt<br/>claude-context · memory"]
        c2["system-reminder<br/>context-budget"]
        c3["tool-search · cache-marks<br/>search-tools"]
        c4["compaction · idle-compact<br/>kept-thinking · context-management"]
    end

    subgraph safety["Safety"]
        s1["permissions<br/>+ auto-mode library"]
        s2["hooks"]
        s3["file-tracker<br/>worktree"]
        s4["tool-call-corruption"]
    end

    subgraph eco["Ecosystem"]
        e1["claude-compat"]
        e2["plugins"]
        e3["skill"]
        e4["mcp"]
    end

    subgraph tools["Tools"]
        t1["bash · powershell<br/>background"]
        t2["web · web-fetch<br/>lsp · notebook"]
        t3["tasks · plan-mode<br/>ask-user · artifacts"]
    end

    subgraph agents["Agents"]
        g1["subagents"]
        g2["workflow"]
    end

    subgraph ui["Terminal UI and commands"]
        u1["branding · tool-style<br/>footer · spinner"]
        u2["turn-duration · interrupted<br/>send-now · session-title"]
        u3["recap · btw · effort<br/>model-default · newer-model"]
        u4["doctor<br/>exit · init · clear"]
    end
```

| Role | What the group does |
|---|---|
| Prompt and context | Builds the system prompt per model tier, loads project instructions and memory into the first message, steers the model through `<system-reminder>` blocks, defers rarely used tools behind `tool_search`, and compacts long sessions. |
| Safety | Decides whether each tool call runs (rules, modes, the auto-mode classifier), runs user hooks, guards against stale edits, confines work to a Git worktree, and stops calls from damaged provider streams. |
| Tools | The tools the model calls, beyond pi's built-in `read`, `edit` and `write`. |
| Agents | Background subagents with two-way messaging, and JavaScript workflow scripts that fan work out across many agents. |
| Ecosystem | Discovers Claude Code skills, commands, agents and plugins, and connects MCP servers. |
| Terminal UI and commands | Everything the user sees around the conversation, plus small slash commands. |

The architecture rules that keep these extensions working together are in
[Extension rules](extension-rules.md).

## One turn through the hooks

pi runs an agent loop and fires events at fixed points. One Code does almost
all of its work inside those event handlers. The sequence below follows one
user prompt that leads to one tool call. The names on the arrows are pi
events; the notes name the extensions that handle them.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant pi as pi agent loop
    participant ext as One Code extensions
    participant llm as Model provider
    participant tool as Tool

    User->>pi: prompt
    pi->>ext: input
    Note right of ext: hooks (UserPromptSubmit),<br/>subagents (message to a viewed agent)
    pi->>ext: before_agent_start
    Note right of ext: system-prompt builds the tiered prompt,<br/>claude-context queues CLAUDE.md, memory and date,<br/>skill queues the skill listing

    loop until the model stops calling tools
        pi->>ext: context
        Note right of ext: kept-thinking strips old signed thinking,<br/>system-reminder injects queued reminders
        pi->>ext: before_provider_request
        Note right of ext: tool-search keeps the tools array stable,<br/>system-reminder lays out the payload,<br/>compaction saves the request for reuse
        pi->>llm: request
        llm-->>pi: streamed reply with a tool call
        pi->>ext: tool_call
        Note right of ext: tool-call-corruption, hooks (PreToolUse may<br/>block or rewrite the input), worktree,<br/>file-tracker, permissions
        alt allowed
            pi->>tool: execute
            tool-->>pi: result
        else blocked
            ext-->>pi: block with a reason the model reads
        end
        pi->>ext: tool_result
        Note right of ext: context-budget, system-reminder writes<br/>one-shot reminders into the result,<br/>hooks (PostToolUse), lsp diagnostics
    end

    pi->>ext: agent_end / agent_settled
    Note right of ext: hooks (Stop), turn-duration,<br/>recap idle timer, queued notifications
    pi-->>User: final reply
```

Handlers for the same event run in the order the extensions appear in
`package.json`. That order is load-bearing; see
[Extension rules](extension-rules.md#load-order).

## How a tool call is decided

Every tool call passes the `tool_call` handler in
`extensions/permissions/index.ts`. The pure decision is `decide()` in
`extensions/permissions/matcher.ts`. In auto mode, calls the rules do not
settle go to the classifier in `extensions/auto-mode/`.

```mermaid
flowchart TD
    call(["Tool call from the model"]) --> hk{"PreToolUse hook<br/>blocks?"}
    hk -->|yes| b1(["Blocked"])
    hk -->|no| deny{"Deny rule<br/>matches?"}
    deny -->|yes| b2(["Blocked"])
    deny -->|no| decide["decide() checks, in order:<br/>mode · ask rules · protected paths<br/>working directory · allow rules<br/>read-only shell proof · mode fast paths"]
    decide --> floor{"Auto mode, and the call<br/>writes permission or<br/>auto-mode settings?"}
    floor -->|yes| b3(["Blocked"])
    floor -->|no| verdict{"decide()<br/>verdict"}

    verdict -->|allow| r1(["Runs"])
    verdict -->|ask| ask1["Ask the user"]
    verdict -->|"classify<br/>(auto mode)"| grant{"Approved once<br/>in /permissions?"}

    grant -->|yes| r2(["Runs"])
    grant -->|no| paused{"Paused after<br/>repeated blocks?"}
    paused -->|yes| ask2["Ask the user<br/>to resume"]
    paused -->|no| pregate{"Shell pre-gate<br/>proves it safe?"}
    pregate -->|yes| r3(["Runs"])
    pregate -->|no| s1["Classifier stage 1<br/>harm check, short reply"]
    s1 -->|low risk| r4(["Runs"])
    s1 -->|possible harm| s2["Classifier stage 2<br/>full evaluation with reasoning"]
    s2 -->|allow| r5(["Runs"])
    s2 -->|block| b4(["Blocked"])

    classDef run fill:#d3f0d8,stroke:#2f7d3b,color:#123d19
    classDef blocked fill:#f8d7d7,stroke:#a33a3a,color:#4a1212
    classDef human fill:#fdf0c8,stroke:#9a7a1c,color:#3d300a
    class r1,r2,r3,r4,r5 run
    class b1,b2,b3,b4 blocked
    class ask1,ask2 human
```

A few properties hold throughout:

- Deny rules win over everything, including `bypassPermissions` mode.
- An explicit ask rule always prompts, even in auto mode.
- The shell pre-gate can only conclude "safe". It never denies, so it can
  never be the reason a call is blocked. The rules for extending it are in
  [Extension rules](extension-rules.md#safety-and-permissions).
- Any classifier failure (no model, no credentials, a timeout, an unreadable
  reply) blocks. A gate that cannot reach its classifier has approved
  nothing.

## Steering the model: the reminder queue

Extensions never inject text into the conversation directly. They emit on
the `one-code:system-reminder` channel, and the `system-reminder` extension
places each block in the outgoing request. The placement depends on the kind
of fact, and every placement keeps already-sent messages byte-identical, so
the provider's prompt cache keeps hitting.

```mermaid
flowchart LR
    subgraph emitters["Any extension"]
        e1["claude-context<br/>tool-search · skill · mcp"]
        e2["permissions · plan-mode<br/>worktree · effort"]
        e3["file-tracker · lsp<br/>tool-search · context-budget"]
        e4["clear · model-default<br/>panel commands"]
    end

    bus{{"pi.events<br/>one-code:system-reminder"}}
    queue["system-reminder<br/>ReminderQueue"]

    e1 -->|"first-prepend"| bus
    e2 -->|"sticky-append"| bus
    e3 -->|"last-append"| bus
    e4 -->|"user-prepend"| bus
    bus --> queue

    subgraph req["Outgoing request"]
        direction TB
        m1["First user message<br/>session context stack, then the user's text"]
        mN["Later user messages<br/>open session states appended"]
        tr["Tool results<br/>one-shot reminders written in"]
        tail["Request tail<br/>late one-shots pinned in place"]
    end

    queue --> m1
    queue --> mN
    queue --> tr
    queue --> tail
```

| Placement | For | Where it lands |
|---|---|---|
| `first-prepend` | Session context that never changes: instructions, memory, deferred tool names, the skill and agent catalogs | Front of the first user message, frozen after the first request |
| `sticky-append` | Session state that switches on and off: auto mode, plan mode, a worktree session | Every user message after the state switched on |
| `last-append` | One-shot news about what just happened: a file changed on disk, new diagnostics | Written into the next stored tool result, or pinned to the request's tail |
| `user-prepend` | Breadcrumbs from slash commands the user ran | Before the user's text on the next prompt |

The contract and the full rules are in the header of
`extensions/lib/reminders.ts`.

## Subagents and workflows

Subagents and workflow agents run in the same process as the main session.
Each one is a separate pi `AgentSession` opened through
`openChildSession` in `extensions/lib/agent-loader.ts`, with a curated set of
extensions (`extensions/lib/child-extensions.ts`). Safety and hooks reach the
child through bridges published by the parent, and completions come back to
the main session as notifications.

```mermaid
flowchart LR
    subgraph main["Main session"]
        direction TB
        model["Model"]
        agentTool["Agent and SendMessage<br/>tools (subagents)"]
        wfTool["workflow tool<br/>script runs in a worker thread"]
        gates["permissions · hooks"]
        mcpExt["mcp"]
        panel["Agent panel<br/>/agents · /tasks"]
        notifier["Task notifier<br/>lib/notifications.ts"]
    end

    subgraph child["Child session, one per agent"]
        direction TB
        childLoop["AgentSession<br/>own model · own transcript on disk"]
        childExt["Child extensions<br/>system-reminder · tool-search<br/>claude-context · file-tracker<br/>search-tools · skill · bash<br/>powershell · web · web-fetch · notebook"]
        childGate["Gate bridges<br/>lib/permission-gate.ts<br/>lib/hook-gate.ts"]
    end

    wtree[("Optional<br/>Git worktree")]

    model --> agentTool
    model --> wfTool
    agentTool -->|openChildSession| childLoop
    wfTool -->|"agent() calls"| childLoop
    mcpExt -.->|"shared MCP tools"| childLoop
    childLoop --- childExt
    childLoop --- childGate
    childGate -.->|"each tool call;<br/>a failed bridge blocks"| gates
    childLoop -->|progress| panel
    childLoop -->|result| notifier
    notifier -->|"task notification"| model
    childLoop -.->|"runs in"| wtree
```

A few properties worth knowing before you change this area:

- A fork inherits the parent's conversation. Its request is built from the
  parent's last saved request plus the fork's own tail, so it reads the
  parent's prompt cache instead of paying for the whole conversation again.
- A child never loads `lsp` or `mcp`. MCP tools are shared in from the
  parent, and a child's language servers would outlive it.
- In one-shot runs (`-p`, `--mode json`) a background agent blocks until it
  finishes, because the process exits when the turn settles.

## Configuration and state on disk

One Code reads Claude Code's configuration and never writes it, with one
exception: per-repository memory, which both tools share. Everything One
Code writes goes to its own state directory.

```mermaid
flowchart LR
    subgraph read["Read-only inputs"]
        direction TB
        proj["Project<br/>CLAUDE.md · AGENTS.md · ONECODE.md<br/>.claude/settings.json · .claude/skills<br/>.claude/agents · .claude/commands<br/>.mcp.json · .lsp.json"]
        userCfg["User<br/>~/.claude/settings.json · ~/.claude/CLAUDE.md<br/>~/.claude skills, agents, plugins"]
    end

    subgraph write["Written by One Code"]
        direction TB
        oc["~/.onecode<br/>settings.json · projects/&lt;slug&gt;/settings.json<br/>plans/ · artifacts/ · plugins/<br/>consent stores · cached model catalogs"]
        piState["pi agent directory<br/>sessions · pi settings · auth<br/>(~/.onecode/agent in the app, resolved by getAgentDir())"]
        memDir["~/.claude/projects/&lt;repo&gt;/memory<br/>shared auto-memory"]
    end

    proj --> exts["One Code extensions"]
    userCfg --> exts
    exts --> oc
    exts --> piState
    exts <--> memDir
```

The path helpers are `extensions/lib/paths.ts` (Claude Code locations),
`extensions/lib/one-code-settings.ts` (One Code's own settings) and pi's
`getAgentDir()` (pi state). The rules for using them are in
[Extension rules](extension-rules.md#paths-state-and-shells), and the
[configuration guide](../guide/configuration.md#what-is-stored-under-onecode)
lists what `~/.onecode` holds.
