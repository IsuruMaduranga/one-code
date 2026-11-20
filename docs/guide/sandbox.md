# The command sandbox

[← One Code user guide](README.md)

The command sandbox is an operating-system wall around the shell commands
the model runs. The permission gate decides whether a command runs. The
sandbox limits what a command that runs can write and which hosts it can
reach. It is off until you turn it on.

This page explains how to turn the sandbox on, what it limits, how each
permission mode treats a sandboxed command, and every setting.

## Requirements

| Platform | What the sandbox uses | What you install |
|---|---|---|
| macOS | Seatbelt, which ships with macOS. | Nothing. |
| Linux and WSL2 | bubblewrap, with socat for the network proxy. | `bubblewrap` and `socat`, from your package manager. |
| Native Windows | No sandbox. Commands run without one. | Not applicable. |

The sandbox is built on Anthropic's open source sandbox runtime, which is in
beta.

## Turn on the sandbox

1. Add the following to `~/.onecode/settings.json` or
   `~/.claude/settings.json`:

   ```json
   {
     "sandbox": {
       "enabled": true
     }
   }
   ```

2. Start a new session. One Code reads the sandbox settings when it starts,
   so a change applies from the next start.

3. To confirm, run `/sandbox`. The command prints whether the sandbox is
   running, the writable directories, the allowed hosts, and the settings in
   force.

If the sandbox can't start (for example, bubblewrap is missing), One Code
warns you and runs commands without it. To refuse commands instead, set
`failIfUnavailable`.

## What the sandbox limits

The sandbox applies to each Bash command and each monitor command, and to
every process the command starts. It doesn't apply to the file tools (read,
edit, write), hooks, MCP servers, or commands you run yourself with `!`.
While the sandbox is running, the PowerShell tool is refused, because the
sandbox runs Bash commands only.

**Writes.** A sandboxed command can write to the following locations only:

- The working directory, or the worktree in a worktree session.
- Your workspace directories.
- The session's private temporary directory, which `$TMPDIR` names inside
  the sandbox.
- The paths you list in `filesystem.allowWrite`.

Inside those locations, some paths are never writable: the settings files
that hold permission rules, the project's `skills`, `hooks`, `commands`,
`agents`, `rules`, and `workflows` folders, shell startup files, Git hooks,
and Git configuration.

**Reads.** A sandboxed command can read any file your account can read,
except the paths you list in `filesystem.denyRead`. The sandbox doesn't hide
your credentials by default. To hide them, list them.

**Network.** Connections go through a filtering proxy. A host you list in
`network.allowedDomains` is allowed, and a host in `network.deniedDomains`
is refused. For any other host, the permission mode decides, as the next
section describes.

When the sandbox blocks a command, the command fails with an error such as
`Operation not permitted`, and a refused host is named in the result. The
model reads that and either reports it to you or asks to run the command
again outside the sandbox.

## How the permission modes treat sandboxed commands

The sandbox doesn't replace the permission gate. Rules, prompts, and the
auto-mode classifier work as they do without it, with these additions:

| Mode | A host your settings don't list | A request to run outside the sandbox |
|---|---|---|
| Default, accept edits, plan | You're asked. **Yes** holds until the model finishes its turn. You can also allow the host for the session. | You're asked. The prompt says `(unsandboxed)`. |
| Auto | Refused. The model names the hosts the command needs, and the classifier reviews that list with the command. If the classifier approves, the hosts apply to that one command. | The classifier reviews the command. |
| Don't ask | Refused. | Denied, unless an allow rule matches. |
| Bypass | Allowed. | Runs. |

A request to run outside the sandbox never takes a shortcut. A command the
gate normally approves without a prompt, such as `ls`, still needs your
approval or the classifier's when the model asks to run it unsandboxed. An
allow rule that matches the command approves it.

In auto mode, a command that names its own hosts is always reviewed by the
classifier, even when an allow rule matches the command. The hosts a command
names never override `network.deniedDomains`. Per-command hosts apply to
foreground commands; a background command or a monitor reaches only the
hosts in your settings.

### Run sandboxed commands without a prompt

By default, a sandboxed command goes through the same prompts as any other
command. To skip the prompt for commands that run inside the sandbox, set
`autoAllowBashIfSandboxed` in your user settings:

```json
{
  "sandbox": {
    "enabled": true,
    "autoAllowBashIfSandboxed": true
  }
}
```

With this setting, a sandboxed Bash command runs without a prompt in default
and accept-edits modes. `deny` rules and `ask` rules still apply, and a
command that visibly writes to a protected path still prompts you. Auto mode
doesn't change: its classifier reviews sandboxed commands too.

Before you turn this setting on, consider that a sandboxed command can read
most of your files and can run any program in the working directory.

## Settings

All keys go under `sandbox` in a settings file. One Code reads the same keys
Claude Code uses.

| Key | Default | What it does |
|---|---|---|
| `enabled` | `false` | Turns the sandbox on. |
| `allowUnsandboxedCommands` | `true` | Lets the model ask to run a command outside the sandbox. When `false`, the request is ignored and every command stays sandboxed. |
| `autoAllowBashIfSandboxed` | `false` | Runs sandboxed Bash commands without a prompt in default and accept-edits modes. |
| `failIfUnavailable` | `false` | Refuses shell commands when the sandbox can't start, instead of running them without it. |
| `excludedCommands` | none | Commands that run outside the sandbox, such as `docker *`. A pattern is the exact command or a prefix that ends in ` *`. A command with a pipe, a redirect, `;`, `&&`, or a substitution stays sandboxed. Excluded commands go through the permission gate as usual. |
| `filesystem.allowWrite` | none | More writable paths. |
| `filesystem.denyWrite` | none | Paths that are never writable. |
| `filesystem.denyRead` | none | Paths a sandboxed command can't read. |
| `filesystem.allowRead` | none | Exceptions inside a `denyRead` path. |
| `network.allowedDomains` | none | Hosts a sandboxed command can reach without a question, such as `registry.npmjs.org` or `*.pythonhosted.org`. |
| `network.deniedDomains` | none | Hosts that are always refused. |
| `network.allowLocalBinding` | `false` | Lets a sandboxed command listen on a local port, which a development server needs. |
| `network.allowUnixSockets` | none | Unix socket paths a sandboxed command can connect to. |

### What a project's settings can change

A project's `.claude/settings.json` and `.claude/settings.local.json` travel
with the repository, so they can only tighten the sandbox. From those files,
One Code honors the following:

- `enabled: true`
- `allowUnsandboxedCommands: false`
- `autoAllowBashIfSandboxed: false`
- Entries in `filesystem.denyWrite`, `filesystem.denyRead`, and
  `network.deniedDomains`

Everything that widens access counts only from your user settings, One
Code's own settings files, and managed settings. A project can't turn the
sandbox off, add writable paths, allow hosts, or exclude commands.

If your user settings set `allowUnsandboxedCommands` to `false`, that value
holds whatever another file sets.

## Limits

- The sandbox doesn't cover the file tools, hooks, or MCP servers. The
  permission gate is what guards those.
- A sandboxed command can read your files unless you list them in
  `filesystem.denyRead`.
- An allowed host is allowed for any use. A command that can reach a host
  can send data to it.
- Subagents run their commands in the same sandbox as the main session.
- A directory you add with `/add-dir` becomes writable in the sandbox from
  the next start.
- The sandbox runtime is in beta. For a wall around the whole agent rather
  than its shell commands, run One Code in a container.
