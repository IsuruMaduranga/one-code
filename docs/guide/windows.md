# Windows

[← One Code user guide](README.md)

One Code on native Windows works the way Claude Code does today: Git for
Windows is optional, PowerShell is the primary shell tool when it is
enabled, and the Windows-specific pieces of your Claude Code configuration
keep working. This page says what that means in practice and what has and
hasn't been verified.

## Two shell tools

| Tool | When it is active | What runs it |
|---|---|---|
| `powershell` | On by default on Windows. Off elsewhere unless `CLAUDE_CODE_USE_POWERSHELL_TOOL=1`. | `pwsh.exe`, else `powershell.exe`, from your PATH. On macOS and Linux, a `pwsh` on PATH. |
| `bash` | Whenever a bash exists. | Git Bash (`Program Files\Git\bin\bash.exe`, then `bash.exe` on PATH), or the bash named by `CLAUDE_CODE_GIT_BASH_PATH`. |

When both are active, PowerShell is the primary shell: the system prompt says
so and the model reaches for it first, with bash alongside for POSIX scripts.
`CLAUDE_CODE_USE_POWERSHELL_TOOL=0` turns the PowerShell tool off and makes
bash primary again, which is the shape Claude Code had before 2.1.126.

A Windows machine with neither Git for Windows nor PowerShell has no shell
tool. One Code says so at startup, in Claude Code's words, and the fix is to
install one of them.

`CLAUDE_CODE_GIT_BASH_PATH` is read from your environment or from the `env`
block of `~/.claude/settings.json`. A value that isn't a `bash` or `sh`
binary is ignored with a warning, as Claude Code does since 2.1.219.

## The PowerShell tool

The tool the model sees is Claude Code's PowerShell tool: same parameters
(`command`, `timeout` in milliseconds, `description`, `run_in_background`)
and Claude Code's own description text, including the edition section. One
Code picks that section from the executable it found: PowerShell 7 guidance
for `pwsh`, Windows PowerShell 5.1 guidance for `powershell.exe`. Under the
hood it is pi's `powershell` tool, run with `-NoProfile -NonInteractive
-ExecutionPolicy Bypass -Command`, output forced to UTF-8.

`run_in_background` works like bash's: a task id comes back at once, output
spools to the session directory, completion arrives as a notification, and
the shell shows up in the panel below the editor. A foreground command that
starts with `Start-Sleep` is refused with a pointer to background runs and
the monitor tool, and `Read-Host`, `Get-Credential`, `Out-GridView`, `pause`
and interactive git are refused because the shell has no console to prompt
on.

Inside a worktree session, every PowerShell command is prefixed with a
`Set-Location` into the worktree, the way bash commands get a `cd`.

## Permission rules

`PowerShell(...)` rules use the same shape as `Bash(...)` rules and follow
Claude Code's PowerShell matching:

- Aliases are canonicalized on both sides, so `PowerShell(Remove-Item:*)`
  catches `rm -Recurse build`, `del x`, and `ri y`, and
  `PowerShell(Get-ChildItem:*)` allows `ls` and `dir`. Cmdlet names are
  case-insensitive.
- A command line is split on `|`, `;`, `&&`, `||`, and newlines, outside
  quotes and here-strings. An `allow` rule has to cover every statement; a
  `deny` or `ask` rule fires on any statement, including inside a nested
  `pwsh -Command '…'`.
- A line with a `$(…)` subexpression, a backtick escape, a script block, the
  `&` or `.` call operators, `Invoke-Expression`, or an encoded command is
  never covered by a wildcard or prefix allow rule. An exact rule for the
  literal line still is.
- Unbalanced quoting is a parse failure: no allow rule applies and you are
  asked.

Blanket rules (`PowerShell`, `PowerShell(*)`, `PowerShell(iex *)`,
`PowerShell(Start-Process *)`) are suspended in auto mode like their bash
counterparts. Hook matchers accept `PowerShell`, `Bash|PowerShell`, and
`Bash,PowerShell`.

## Auto mode and plan mode

Claude Code's read-only cmdlets run without a prompt or a classifier call:
`Get-ChildItem`, `Get-Content`, `Get-Item`, `Test-Path`, `Resolve-Path`,
`Select-String`, `Get-Location`, `Get-Process`, `Get-Service`,
`Get-FileHash`, `Get-Acl`, `Format-Hex`, `findstr`, `where.exe`, plus
`Write-Output` and `Write-Host`. The check is textual and strict: no
redirection, no variables, no script blocks, and every path relative and
inside the project. A UNC path, a drive-lettered path, `~`, or `..` takes
the ordinary route.

Everything else goes to the auto-mode classifier. One Code has no PowerShell
command parser yet, so unlike bash there is no deterministic shortcut for
in-project deletes: a `Remove-Item` inside the repository is classified, not
auto-approved. The safety floor still applies. Any PowerShell line that
names a permission settings file (`.claude/settings.json`,
`~/.onecode/settings.json`, `.claude.json`, managed settings) stops for you,
whether it reads or writes.

Plan mode allows the read-only cmdlets above and refuses the rest, as it
does for bash.

## Hooks

Hooks run in bash where one exists and in PowerShell on a Windows machine
without Git for Windows. A hook can pick its interpreter with Claude Code's
`shell` field: `"shell": "powershell"` or `"shell": "bash"`. Timeouts kill
the whole process tree through `taskkill /T` on Windows. See
[Hooks](hooks.md#which-shell-runs-a-hook).

## Paths and state

- One Code's state lives in `%USERPROFILE%\.onecode`; Claude Code's
  configuration is read from `%USERPROFILE%\.claude` (or
  `CLAUDE_CONFIG_DIR`).
- The scratchpad directory is under `%TEMP%`.
- The `Shell:` line in the system prompt is the basename of `SHELL`, else
  `COMSPEC`, with `.exe` stripped, the value Claude Code prints.
- Language servers installed with npm are `.cmd` shims on Windows
  (`typescript-language-server.cmd`). One Code finds them on `PATH` and
  starts them through `cmd.exe`, so a plugin's `.lsp.json` can name the
  command the way it does elsewhere.
- Auto mode's shell pre-gate and the worktree guards understand Git Bash's
  path spellings inside a command line: `/c/Users/…` is `C:\Users\…`, and
  `/tmp/…` is your temp directory, which Git for Windows mounts there. A
  path rule with a wildcard is spelled with forward slashes
  (`Read(C:/notes/**)` or `Read(//c/notes/**)`), because a backslash before
  `*` is the escape character.

## What is verified

- The unit suite, including live PowerShell runs, passes on the
  `windows-latest`, `macos-latest`, and `ubuntu-latest` GitHub runners.
- A real model drives both shell tools on the `windows-latest` runner: the
  bash tool under Git Bash and the PowerShell tool under PowerShell 7, each
  running a command whose output has to come back in the tool result. This
  runs as its own workflow whenever the shell-facing code changes.
- Drive-letter, backslash, `C:/` and `~` paths in `Read(...)`/`Edit(...)`
  rules, Windows PowerShell 5.1 (edition text, UTF-8 output, no `&&`),
  stopping background PowerShell commands and timed-out hooks, and
  npm-installed language servers all have Windows-only unit tests that run
  on that runner.
- The PowerShell tool has also been driven through a real model with a
  `pwsh` on macOS, the same way Claude Code's own PowerShell tool was
  captured for reference.
- An interactive session on a Windows desktop (Windows Terminal, permission
  prompts, plan mode) has not been checked by hand yet. If you hit something
  there, [Troubleshooting](troubleshooting.md) says what to collect.

## Not provided

- No PowerShell command parser or pre-gate beyond the read-only list.
- No sandbox on Windows. Claude Code has none there either.
- `defaultShell` for the user's own `!` prefix is pi's to handle; One Code
  does not read it.
