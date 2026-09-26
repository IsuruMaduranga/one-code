# Permissions, modes, and auto mode

[← One Code user guide](README.md)

Every tool call the model makes passes through One Code's permission gate
before it runs. This page explains the permission modes, how to switch
between them, how to write rules, what the approval prompt offers, and how
plan mode and auto mode change what needs your approval.

For the security guarantees and the known gaps, read
[A boundary, not a promise](#a-boundary-not-a-promise) at the end of this
page before you rely on auto mode for unattended work.

## How a decision is made

For each tool call, the gate checks the following in order:

1. **Protected paths.** A write to a protected file or directory (see
   [Protected paths](#protected-paths)) is never approved automatically. In
   auto mode it goes to the classifier; in other modes it prompts you.
   Allow rules don't cover protected paths.
2. **`deny` rules.** A matching `deny` rule blocks the call. `deny` always
   wins.
3. **`ask` rules.** A matching `ask` rule prompts you, even in a mode that
   would otherwise approve the call.
4. **`allow` rules.** A matching `allow` rule approves the call without a
   prompt. A shell rule doesn't cover the command's redirects outside the
   working directory: with `Bash(echo:*)`, `echo x >> ~/.zshrc` still
   prompts you, and in auto mode it goes to the classifier.
5. **The mode's default.** Anything no rule covers is decided by the current
   permission mode.

A handful of tools are always allowed because other tools sit behind them:
`tool_search`, `skill`, `Agent`, `SendMessage`, `list_agents`, `workflow`,
`ask_user_question`, `lsp_diagnostics`, `list_mcp_resources`, the task-list
tools, `cron_list`, `cron_delete`, and the plan-mode tools. The tool calls
these tools make in turn (a subagent's own edits, for example) are still
gated. `cron_create` and `schedule_wakeup` are allowed too, except in auto
mode, where the classifier reviews what the scheduled prompt asks for unless an
allow rule names the tool, as in Claude Code. A fired prompt's own tool calls
go through the usual checks.

## Permission rules

One Code reads `allow`, `deny`, and `ask` rules from the same files Claude
Code uses, plus its own:

| File | Scope |
|---|---|
| `~/.claude/settings.json` | Your user-wide Claude Code rules. Read only. |
| `~/.onecode/settings.json` | Your user-wide One Code rules. `/allow … global` writes here. |
| `.claude/settings.json` and `.claude/settings.local.json` | The project's rules. Read only. Allow rules from these files need your approval once; see [Trusting a project](#trusting-a-project). |
| `~/.onecode/projects/<slug>/settings.json` | One Code's per-repository rules. `/allow` writes here. |
| Managed settings | Organization-wide rules, when present. Read only. |

Rules match tools by name and, optionally, by argument. Claude Code's
PascalCase tool names (`Bash`, `Read`, `Edit`, `WebFetch`, `Task`, and the
rest) work in these rules, so a setup you wrote for Claude Code applies as
it is. For the mapping from Claude Code names to One Code's tool names, see
[Tools](tools.md#claude-code-tool-names).

A rule naming an MCP server, such as `mcp__github`, covers every tool that
server provides. A rule naming a single MCP tool, such as
`mcp__github__create_issue`, covers only that tool.

### Bash rule patterns

Bash rules follow Claude Code's matching rules:

- `Bash(npm test)` matches that exact command line.
- `Bash(npm test:*)` matches `npm test` and any command that starts with
  `npm test` followed by a space. It does not match `npm tests` or
  `npm test:unit`; write `Bash(npm test:unit:*)` for the latter.
- `Bash(git * --dry-run)` uses `*` as a wildcard anywhere in the line. Write
  `\*` for a literal asterisk and `\\` for a literal backslash.

`deny` and `ask` rules are matched against every form of a command line, so
they are hard to sidestep. They apply when they match the raw line, any
subcommand of a compound line (`&&`, `||`, `;`, `|`, `&`, or a newline), or
the payload of a wrapper. Wrappers such as `env`, `command`, `nice`,
`timeout`, and `xargs` are peeled, `sh -c '…'` and the other shells are
expanded (so is a heredoc or here-string fed to a shell, as in
`sh <<'EOF'`), and the command word is reduced to its lowercased basename, so
`/bin/rm`, `\rm`, and `RM` all match a rule written for `rm`.

`allow` rules are matched against the literal spelling only, and a compound
command line is allowed only when an `allow` rule covers every one of its
subcommands, or when an exact rule matches the whole line. `eval`, `sh`, and
`xargs` are subcommands like any other, so each needs a rule of its own.

The commands inside a command substitution (`$(…)` or backticks) or a
process substitution (`<(…)`) must be covered too, because they run. A rule
can cover them, or One Code covers the whole substitution when it can prove
the substitution only reads files inside the project. So
`Bash(git commit:*)` allows `git commit -m "$(cat <<'EOF' … EOF)"`, but it
doesn't allow `npm test $(curl …)`. A line containing a subshell, a loop, or
a function is never covered by a prefix or wildcard `allow` rule.

### PowerShell rule patterns

`PowerShell(...)` rules have the same shape and follow Claude Code's
PowerShell matching: aliases are canonicalized on both sides
(`PowerShell(Remove-Item:*)` catches `rm`, `del`, and `ri`), cmdlet names
are case-insensitive, a line is split on `|`, `;`, `&&`, `||`, and newlines
outside quotes and here-strings, an `allow` rule must cover every statement,
and a `deny` or `ask` rule fires on any statement. A `$(…)` subexpression, a
backtick escape, a script block, the `&`/`.` call operators,
`Invoke-Expression`, or an encoded command keeps a wildcard `allow` from
applying. Details in [Windows](windows.md#permission-rules).

### Add a rule during a session

To add an allow rule for the current repository, run:

```
/allow Bash(npm test:*)
```

Add `global` at the end to save it for every repository instead:

```
/allow Bash(npm test:*) global
```

Rules One Code adds are saved under `~/.onecode`, never under `~/.claude`.

### Manage permissions in the panel

Run `/permissions` to open the permissions panel. It has the same tabs as
Claude Code's:

- **Recently denied**: calls the auto-mode classifier blocked in this
  session. See [Approve a call auto mode denied](#approve-a-call-auto-mode-denied).
- **Allow**, **Ask**, and **Deny**: every rule, with the file it came from.
  Type to filter the list. Choose **Add a new rule…** to add one, and pick
  whether it's saved for this project or for every project.
- **Auto mode**: the classifier's own rules and environment. See
  [Configure auto mode](#configure-auto-mode).
- **Workspace**: the working directory and any extra directories. See
  [Workspace directories](#workspace-directories).

Use ←/→ to switch tabs, ↑/↓ to move, Enter to open a row, and Esc to close.
The footer always shows the keys that work where you are.

The panel only changes One Code's own files and this session's grants. A
rule from Claude Code's settings, the repository's `.claude` files, or
managed settings is listed but read-only, and its detail view names the file
to change instead. Whatever you change is passed to the model when the panel
closes, so it knows a rule is gone.

## Permission modes

A mode sets the default answer for actions no rule covers. **Auto is the
default**, matching Claude Code: a classifier approves routine actions and
stops risky ones, so you're not prompted for every step.

| Mode | Badge | What it does |
|---|---|---|
| Manual | `⏸ manual mode on` | Prompts for anything not already allowed. The `--permission-mode` value is `default`. |
| Accept edits | `⏵⏵ accept edits on` | File edits inside the working directory run without a prompt. With a frontier or workhorse model, so do in-project `mkdir`, `touch`, `cp`, `mv`, `rm`, and `rmdir` commands. Everything else still prompts. The flag value is `acceptEdits`. |
| Plan | `⏸ plan mode on` | Read-only investigation plus one plan file. See [Plan mode](#plan-mode). The flag value is `plan`. |
| Auto | `⏵⏵ auto mode on` | A classifier screens each action. See [Auto mode](#auto-mode). The flag value is `auto`. |
| Bypass permissions | `⏵⏵ bypass permissions on` | Runs everything without prompts, including writes to protected paths. The flag value is `bypassPermissions`; `--dangerously-skip-permissions` also selects it. |
| Don't ask | `⏵⏵ don't ask on` | Never prompts. Anything that would have prompted is denied instead. The flag value is `dontAsk`. |

The current badge appears in the banner and is announced when the mode
changes.

### Cycle modes with ctrl+q (alt+m on Windows and WSL)

Press **ctrl+q** to cycle through manual, accept edits, plan, and auto. On
Windows and WSL the key is **alt+m**. Two modes join the cycle only under certain conditions:

- **Auto** appears only when a model that can run the classifier is
  available. With no provider connected, the cycle skips it.
- **Bypass permissions** appears only when the session started in it.

**Don't ask** is never in the cycle; reach it with the `--permission-mode`
flag or a settings file.

Claude Code cycles modes with shift+tab. One Code can't use that key
because pi reserves it for the reasoning-effort dial. On Windows and WSL,
pi's own default keybindings use ctrl+q to queue a follow-up message, so
One Code cycles modes with alt+m there instead. The footer badge and the
startup hints name whichever key applies on your machine.

### Choose the starting mode

To start one session in a different mode, pass `--permission-mode`:

```bash
onecode --permission-mode plan
```

For a reusable shortcut, add an alias to your shell configuration:

```bash
alias onecode-manual='onecode --permission-mode default'
```

For a persistent default, One Code reads `permissions.defaultMode` from your
Claude Code settings files. Merge this into the existing object:

```json
{
  "permissions": {
    "defaultMode": "default"
  }
}
```

The scopes aren't equal:

- **User scope** (`~/.claude/settings.json`) and **managed settings** can
  set any mode.
- **Project scope** (`.claude/settings.json` and `.claude/settings.local.json`)
  can set `default`, `acceptEdits`, `plan`, or `dontAsk`. It can't set
  `auto` or `bypassPermissions`; a checked-in file must not be able to turn
  off approvals for whoever clones it.
- A `defaultMode` in `~/.onecode/settings.json` has no effect.

The `--permission-mode` flag takes precedence over every configured default.

To make bypass mode impossible from any source, set
`permissions.disableBypassPermissionsMode` to `"disable"` in any scope. One
Code then refuses bypass whether it was requested by flag or by settings.

The mode you choose during a session persists across `/clear`. A session
you resume later starts in the configured default, not in the mode it was
in when it ended.

## The approval prompt

When an action needs your decision, a prompt shows the tool, its arguments,
and these choices:

- **Yes.** Run it this once.
- **Yes, and don't ask again … this session.** Approve this action and
  similar ones until the session ends. The scope of "similar" depends on the
  action:
  - A command: only that exact command line, never a pattern.
  - A file inside the working directory: that tool anywhere in the working
    directory.
  - A file outside the working directory: that tool within the file's
    directory only.
  - A URL: that host.
- **No, tell the agent what to do differently.** Deny it, with an optional
  note that is passed to the model as the reason.

The "don't ask again" option isn't offered for protected paths, for writes
that the auto-mode safety floor caught, or in auto mode. Session grants never
apply in auto mode and are cleared when the session ends.

In non-interactive runs (`-p` and `--mode json`) nothing can prompt, so an
action that would have prompted is denied and the model is told why.

## The working directory boundary

Reads and edits are confined to the working directory by default:

- Reading a file inside the working directory is allowed in every mode.
  Reading outside it prompts in manual mode and is denied in don't-ask
  mode. In auto mode it runs without the classifier with a frontier or
  workhorse model, after a one-time question (see [Reads outside the
  working directories](#reads-outside-the-working-directories)), and goes
  to the classifier with a cheap or tiny model.
- A shell command that only reads inside the working directory (`ls`,
  `git status`, `head README.md`) runs without a prompt in every mode, the
  way Claude Code's shell tools approve one themselves. The same analysis
  auto mode uses decides it, so a command it can't prove read-only prompts,
  and one that reads outside the working directory is treated like an
  outside read.
- Accept-edits mode approves edits only inside the working directory. With
  a frontier or workhorse model it also approves a command line made only
  of `mkdir`, `touch`, `cp`, `mv`, `rm`, and `rmdir` whose paths all stay
  inside, as Claude Code does. Removing or moving the working directory
  itself, a `.git` directory, or a directory that holds one still prompts.
  So does any of these commands that would remove, overwrite, or create a
  protected path or a credential file, even inside a directory it names
  (`cp settings.json .claude`, `rm -rf .husky`).
- The harness's own session directories count as inside: the auto-memory
  folder, the session scratchpad, persisted tool output, the plan file, and
  this project's own session transcripts (with auto mode's decision log next
  to them), which is what `/doctor` reads. Other projects' transcripts are
  outside, as they are for Claude Code.

Paths are compared after resolving symlinks, so a symlink inside the project
that points outside it counts as outside.

### Workspace directories

To let One Code read another directory without asking, add it to the
workspace. It works like Claude Code's additional working directories:

- Run `/add-dir PATH`, then choose **Yes, for this session** or **Yes, and
  remember this directory**. A remembered directory is saved to this
  project's One Code settings.
- Start One Code with `--add-dir PATH`. To add several, separate them with
  `:` (`;` on Windows).
- List them under `permissions.additionalDirectories` in your settings.
- Add or remove them in the **Workspace** tab of `/permissions`.

Reading inside a workspace directory then works like reading inside the
working directory, and accept-edits mode can edit files there. A
credential file inside a workspace directory, such as a key under `.ssh`,
still prompts. With a cheap or tiny model, auto mode also sends every write
or delete in a workspace directory to the classifier; with a frontier or
workhorse model it treats them like writes in the working directory.

The filesystem root, your home directory, and any directory that contains
it (such as `/Users`) can't be added; add something narrower. If a settings file lists one of them, One Code ignores it and warns
you. Directories listed in the repository's own `.claude` settings apply
only after you trust the repository (see [Trusting a project](#trusting-a-project)).
The system prompt lists the workspace directories that were in force when
the session started.

In auto mode, a shell command that reads outside the working directory, a
bare `env`, or a `printenv` is never treated as safe by the deterministic
check and always goes to the classifier.

## Protected paths

Writes to these paths are never approved automatically in any mode other
than bypass, and allow rules don't cover them.

Protected directories, including everything inside them:

`.git`, `.config/git`, `.vscode`, `.idea`, `.husky`, `.cargo`,
`.devcontainer`, `.yarn`, `.mvn`, `.claude`, `.onecode`,
`Library/LaunchAgents`, `.config/fish`, `.local/bin`.

`.claude/worktrees` and `.onecode/plans` are ordinary working space and are
exempt.

Protected files:

Shell startup files (`.bashrc`, `.bash_profile`, `.bash_login`,
`.bash_aliases`, `.bash_logout`, `.zshrc`, `.zprofile`, `.zshenv`, `.zlogin`,
`.zlogout`, `.profile`, `.envrc`), git files (`.gitconfig`, `.gitmodules`),
package-manager files (`.npmrc`, `.yarnrc`, `.yarnrc.yml`, `.pnp.cjs`,
`.pnp.loader.mjs`, `.pnpmfile.cjs`, `bunfig.toml`, `.bunfig.toml`), build
files (`.bazelrc`, `.bazelversion`, `.bazeliskrc`, `gradle-wrapper.properties`,
`maven-wrapper.properties`), hook runners (`.pre-commit-config.yaml`,
`lefthook.yml`, `lefthook.yaml`, `.lefthook.yml`, `.lefthook.yaml`), and
tool configuration (`.devcontainer.json`, `.ripgreprc`, `pyrightconfig.json`,
`.mcp.json`, `.claude.json`, `managed-settings.json`).

pi's agent directory, Claude Code's configuration directory, and One Code's
state directory are protected wherever they are, including when relocated
by an environment variable.

## Trusting a project

Some project-provided configuration can run code or widen permissions, so
One Code asks you once per project before using it. Each approval is
remembered under `~/.onecode` together with a hash of the configuration, so
a change to the configuration asks again. Declining is remembered for the
current session only.

| What | When you are asked | Stored in |
|---|---|---|
| Hooks in `.claude/settings.json` or `.claude/settings.local.json` | At startup: "Run this project's hooks?", listing each command. | `~/.onecode/hooks/project-approvals.json` |
| MCP servers in `.mcp.json` | At startup, for each new server. See [MCP servers](skills-plugins-and-mcp.md#mcp-servers). | `~/.onecode/mcp/project-approvals.json` |
| `permissions.allow` rules in the project's settings files | The first time such a rule would decide a call: "Trust this repository's allow rules?" | `~/.onecode/permissions/project-allow-approvals.json` |
| `permissions.additionalDirectories` in the project's settings files | The first time a read inside one of them would skip a prompt. The same question covers the project's allow rules. | `~/.onecode/permissions/project-allow-approvals.json` |

`deny` and `ask` rules from a project never prompt; they only tighten the
gate. Hooks and servers from your user settings, managed settings, or an
installed plugin never prompt either, because installing them was the
consent.

## Plan mode

Plan mode lets the model investigate and write a plan without changing your
code. Only read-only tools and edits to one plan file are available.

- The plan file lives at `~/.onecode/plans/<name>.md`, where the name is a
  random three-word slug. The same file is reused when you resume the
  session or switch branches in `/tree`.
- The model is reminded to explore with the `explore` agent, design with the
  `plan` agent, and then write the plan.
- You can read and edit the plan file yourself while the model works.

Enter plan mode by cycling to it with **ctrl+q** (**alt+m** on Windows and WSL), by starting with
`--permission-mode plan`, or by asking the model to plan first (it can call
`enter_plan_mode` itself).

When the model finishes, it calls `exit_plan_mode` and an approval dialog
shows the plan. Nothing runs until you choose. The choices are:

1. **Approve and return to the mode you were in** before planning, when that
   mode is available.
2. **Approve into auto mode**, when a classifier model is available.
3. **Approve into accept-edits mode.**
4. **Approve into manual mode.**
5. **Keep planning.** No mode change; the model refines the plan file.

The initial highlight is the option that restores your previous mode, or
manual mode when that isn't offered. It never lands on a more permissive
option by default. Press the number of a choice to pick it directly, or
**Esc** to keep planning.

In a non-interactive run there's no one to approve, so `exit_plan_mode`
refuses and the session stays in plan mode with the plan on disk.

## Auto mode

Auto mode removes routine approval prompts without removing the boundary.
It combines a deterministic first pass with Claude Code's own two-stage
classifier.

### What is approved without a classifier call

Which actions skip the classifier depends on the tier of the model making
the call (see [Prompting adapts to the
model](providers-and-models.md#prompting-adapts-to-the-model)). Frontier
and workhorse models get Claude Code's shortcuts. Cheap and tiny models
get a stricter set: Claude Code doesn't run auto mode on Haiku-class
models at all, and smaller models are the likeliest to take a risky
action nobody asked for.

With every model:

- Actions a deterministic analysis proves safe. Read-only shell commands
  inside the working directory are the common case (they run without a
  prompt in every mode, see [the working directory
  boundary](#the-working-directory-boundary)), including multi-line
  commands, heredocs, and substitutions whose own commands are read-only
  (`diff <(git show HEAD:a) a`). An in-project redirect such as
  `echo hi > notes.txt` counts too. This analysis can only ever conclude
  "safe"; anything it can't parse or recognize, or a value that only exists
  when the command runs (an environment variable, say), goes to the
  classifier rather than through.
- Edits and writes to files inside the project that are not credential
  files, not protected paths, and not files that run code on their own
  (build wrappers, CI workflows, editor auto-run configuration).

With a frontier or workhorse model, also everything accept-edits mode
would approve, as in Claude Code:

- Edits and writes anywhere in the working directory and the workspace
  directories, including CI workflows and build wrappers. Protected paths
  are still judged.
- Command lines made only of `mkdir`, `touch`, `cp`, `mv`, `rm`, and
  `rmdir` whose paths all stay inside. `sed` isn't included; it goes to the
  classifier.
- Reads outside the working directories, except credential files (see
  [Reads outside the working directories](#reads-outside-the-working-directories)).

A subagent's calls are judged by the subagent's own model, so a subagent
on a cheaper model gets the stricter set. When you switch the session to a
model on the other side of this line, One Code shows a notice.

### What goes to the classifier

Everything else: `git reset --hard` and other destructive commands,
deleting files with a cheap or tiny model, anything that reaches outside
the project other than the reads described earlier, network-affecting
commands, and writes to protected paths.

### Reads outside the working directories

With a frontier or workhorse model, the first time auto mode reads a file
outside the working directories, One Code asks once, as Claude Code does:

- **Yes, keep allowing reads outside the working directories** allows the
  read and doesn't ask again.
- **No, block reads outside the working directories from now on** refuses
  the read and saves `permissions.blockReadsOutsideWorkingDirectories: true`
  to `~/.onecode/settings.json`. From then on the read tools refuse any path
  outside the working directories, in every mode except bypass and in every
  project.
- **No, ask again next time** refuses this read and asks again on the next.

The question isn't asked in a one-shot run, or when you already answered
it in One Code or in Claude Code. To undo **Block**, remove the setting.
You can also set it yourself in any settings file. Reading a credential
file outside the working directories, such as a key under `~/.ssh`, still
goes to the classifier.

The classifier is Claude Code's two-stage ruleset, embedded verbatim:

1. **Stage 1** grades harm only, on a 0 to 100 scale. Below 50 the action
   is allowed and nothing more runs.
2. **Stage 2** runs when stage 1 scores 50 or above. It weighs the user's
   stated intent and the allow list, and either approves or blocks with a
   named rule.

Verdicts are checked before they're acted on. A block must cite a real
rule from the ruleset. An approval based on intent must quote your own
words from the conversation. A classifier that can't be reached, times
out, or returns something unparseable blocks the action; a gate that can't
consult its classifier approves nothing.

A blocked action is reported to the model with the reason so it can choose
a safer route. You're not prompted per action while auto mode runs. After
repeated blocks in a row, auto mode pauses and the next action prompts you;
approving it resumes auto mode. So that an unattended session isn't held
indefinitely, the first of these prompts after three blocks in a row denies
the action if nobody answers within two minutes, as Claude Code does, and
shows a countdown. A later prompt in the same run of blocks waits for you.
To change the wait, set `CLAUDE_CODE_TICKLISH_WHISPER_TIMEOUT_MS`, Claude
Code's variable for it, to a number of milliseconds.

### Approve a call auto mode denied

When the classifier blocks a call, a notice says so and points to
`/permissions`. If the block was wrong, open the **Recently denied** tab:

- Press Enter on the call to approve it. The model is told it may retry.
- Press `r` to approve it and have the model retry right away.

Approvals apply when you close the panel. An approval covers that exact call
once: the same tool, the same input, and the same directory. The retry then
runs without the classifier, and the next call is judged as usual. Deny
rules and the safety floor still apply to it. Claude Code handles this
differently: it tells the model permission was granted, but judges the
retry again.

Allow rules that are broad enough to pre-approve arbitrary execution, such
as `Bash(*)`, a wildcarded interpreter, or a rule that allows delegation to
subagents, are suspended in auto mode so they can't bypass the classifier.
Session grants from the approval prompt don't apply in auto mode either.

### The classifier model

The classifier runs on a model from the same provider as your session,
chosen automatically as the cheapest model that is at least as capable as
the floor: a Sonnet-class model when your session runs a Sonnet-class or
stronger model, a Haiku-class model otherwise. A weak classifier is a
measurably weaker boundary; in testing, a Haiku-class classifier scored an
explicitly requested recursive delete far below the block threshold that a
Sonnet-class classifier applied to the same command.

To choose the classifier yourself, run `/auto-mode model <provider/model-id>`.
`/auto-mode model clear` returns to automatic selection. The choice is saved
to `~/.onecode/settings.json`. When auto mode is active, the banner shows
the classifier in use.

### The safety floor

A deterministic floor protects the gate's own configuration regardless of
what the classifier or the model decides. A write to any of these files
never reaches the classifier; it prompts you in an interactive session and
is blocked in a non-interactive one:

- `.claude/settings.json` and `.claude/settings.local.json` anywhere
- `~/.onecode/settings.json` and any `~/.onecode/projects/<slug>/settings.json`
- `~/.claude.json`
- Managed settings files

### Configure auto mode

Run `/auto-mode` (or `/auto-mode config`) to see the effective
configuration: the files it was read from, the environment description,
any extra rules, and which classifier model is in use.

The **Auto mode** tab of `/permissions` edits the same configuration. It
lists each section's built-in rules and your own, and you can add a rule
as a plain sentence, edit it, or delete it. The environment opens in an
editor. Changes are saved to `~/.onecode/settings.json` and apply from the
next classifier call. The built-in rules are always in effect. Unlike Claude
Code's panel, this one has no switch to turn a section's built-ins off.

Run `/auto-mode setup` to have a model draft a configuration for your
environment. It asks how you use One Code here, offers to scan recent shell
history for evidence, proposes an environment description and extra rules,
and saves them to `~/.onecode/settings.json` only when you approve. It also
audits your allow rules and offers to remove any that are broad enough to
bypass the classifier.

The configuration keys, under `autoMode`, follow Claude Code's own schema:

| Key | Type | Effect |
|---|---|---|
| `environment` | string array | Describes your environment to the classifier, replacing Claude Code's default description. Include `"$defaults"` to keep the defaults and add to them. |
| `hard_deny` | string array | Extra rules that always block. Appended to Claude Code's built-in list; the built-ins cannot be removed. |
| `soft_deny` | string array | Extra rules that block unless you explicitly asked for the action. |
| `allow` | string array | Extra rules that approve. |
| `classifyAllShell` | boolean | Send every shell command to the classifier, even ones a narrow allow rule covers. |
| `classifierModel` | string | The classifier model, as `provider/model-id`. |
| `logDecisions` | boolean | Append every gate decision to `auto-mode-decisions.jsonl` next to the session files. |

One Code reads `autoMode` from `~/.claude/settings.json`,
`~/.onecode/settings.json`, and managed settings. It never reads `autoMode`
from a project's `.claude/settings.json` or `.claude/settings.local.json`,
because a checked-in file must not be able to loosen the classifier for
whoever clones it. `classifierModel` is read only from `~/.onecode` and
managed settings.

To see the classifier's verdicts while you work, set `CC_AUTO_MODE_DEBUG=1`
before launching; each decision is printed to stderr with its stage,
severity, and rule.

## A boundary, not a promise

One Code's security model is the permission gate plus auto mode, not an
assumption that the model behaves. Read these facts before you leave a
session unattended:

- **There's no operating-system sandbox.** The gate decides whether a
  command runs; nothing constrains what an approved command can touch. For
  an OS-level wall, run One Code inside a container. The gate and the
  container work together.
- **Bypass mode bypasses everything**, including protected paths. Claude
  Code keeps its protected-path checks active even under
  `--dangerously-skip-permissions`; One Code doesn't.
- **Auto mode is the default without a first-run consent step**, and
  without the OS sandbox Claude Code pairs its own auto default with.
- **A weak classifier is a weaker boundary.** Automatic selection applies a
  floor, but a provider whose catalog has nothing stronger is screened by
  what it has. One tested model family (GLM-5.3 and GLM-5.3 Flash) approved a
  request to back up the project to an unnamed outside location, which the
  ruleset says to block.
- **A known, accepted gap:** a write or edit tool can reach a file that only
  a `Bash` deny rule protects, because in-project writes take the
  deterministic fast path and are never classified. Write a `deny` rule for
  the write tools too if a path must stay untouched.
- The license carries an autonomous-execution notice: the permission rules,
  classifier, and safety checks are best-effort measures, not guarantees.
  Keep backups and version control of anything you care about.
