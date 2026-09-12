# Troubleshooting

[← One Code user guide](README.md)

Symptoms you might hit, what causes them, and what to do.

## Start with the doctor

Most setup problems show up in the report:

```bash
onecode doctor
```

Inside a session, `/doctor report` shows the same report and `/doctor` has
the model fix what it finds. See [Check your setup with doctor](doctor.md).

## Installation and startup

**`onecode requires Node >= 22.19`.** The bundled app refuses to start on
older Node, because pi crashes at import time there. Install Node 22.19 or
later, or use the Homebrew formula, which installs Node for you.

**`brew install` says no matching version was found.** Homebrew refuses
npm packages published less than a day ago. Wait a day after a release, or
install with `npm install -g @one-ai/one-code` in the meantime.

**The banner shows `model none`.** No provider has credentials. Run
`/login`, or set a provider key such as `ANTHROPIC_API_KEY` before
launching. Two providers offer free models; see
[Connect your first provider](providers-and-models.md#connect-your-first-provider).

**A warning says the pi version is outside the tested range.** This appears
on the extension installation when your pi is newer or older than the
versions One Code was tested against. Most things keep working; if
something breaks, pin pi to a tested version or use the bundled app, which
pins pi itself.

**`Failed to load extension` on startup.** The extension package and the
pi it runs on are out of step. On the bundled app, reinstall it. On your own
pi, run `pi update --extensions`.

**The stock pi first-run wizard didn't appear.** The bundled app seeds
pi's settings with the One Code theme, quiet startup, and full-screen mode
on first run, so there's nothing to ask.

## Permissions

**Auto mode is missing from the ctrl+q cycle.** Auto mode needs a model to
run its classifier. Connect a provider.

**ctrl+q does something else.** On Windows and WSL, pi's default
keybindings also bind ctrl+q, to queue a follow-up message. Rebind one of
them in pi's keybindings file.

**Everything prompts, even in auto mode.** Auto mode pauses after several
blocked actions in a row and prompts you once; approving resumes it. Also
check `/permissions`: an `ask` rule prompts in every mode.

**An allow rule I wrote has no effect in auto mode.** Broad execution rules
(`Bash(*)`, wildcarded interpreters, delegation rules) are suspended in
auto mode so they can't bypass the classifier. Session grants from the
approval prompt are also ignored there. Narrow the rule or switch to
accept-edits or manual mode.

**A project's `defaultMode: "auto"` is ignored.** Project-scope settings
may not select auto or bypass mode. Set it in `~/.claude/settings.json`
or pass `--permission-mode auto`.

**`defaultMode` in `~/.onecode/settings.json` does nothing.** The
permission loader doesn't read that key from One Code's file. Use a Claude
Code settings file or the flag.

**The model is denied a write to `.claude/settings.json`.** The auto-mode
safety floor never lets the model change the gate's own configuration
unattended. Approve the prompt, or make the edit yourself.

**Every action is denied in a `-p` run.** Nothing can prompt in a
non-interactive run, so anything that would have prompted is denied. Add
allow rules, or use auto mode with a provider that can run the classifier.

## Auto-mode classifier

**Actions are blocked with a message about the classifier being
unavailable.** The classifier model couldn't be reached or returned
nothing usable; the gate fails closed. Check `/auto-mode config` for the
model in use, and `/doctor report` for provider credentials. Set
`CC_AUTO_MODE_DEBUG=1` to see each verdict on stderr.

**The classifier approves or blocks something it shouldn't.** Choose a
stronger classifier with `/auto-mode model <provider/model-id>`. A
Haiku-class classifier is a measurably weaker boundary than a Sonnet-class
one.

## Models and providers

**The subagent model is stale after switching providers.** A saved
`/subagent` choice from another provider no longer applies. Run
`/subagent status`, then `/subagent clear` or pick a model on the current
provider.

**Cache-hit in the footer is low.** Changing the model or the effort level
re-caches the conversation once. A `-p` run and every subagent use the
provider's short cache lifetime. A persistent low rate on an interactive
session is worth reporting.

**A side call failed on a Gemini or OpenAI model with a message about
reasoning or temperature.** Some models reject an option others accept.
One Code avoids these options in its side calls; if you still see this,
choose a different classifier or reader model and report the model.

## Web search

**A warning about Exa's free keyless endpoint.** Your provider has no
search of its own and you set no Brave or Tavily key, so search fell back
to a rate-limited endpoint. Set `BRAVE_SEARCH_API_KEY` or
`TAVILY_API_KEY`, or add the key to `~/.onecode/settings.json`. See
[Web search](providers-and-models.md#web-search-on-providers-without-a-search-api).

## Language servers

**No diagnostics appear after edits.** The language server must be on the
`PATH` One Code was launched with. Run `/lsp` for each server's status and
`/doctor report` for install hints.

**TypeScript diagnostics fail with a message about `lib/tsserver.js`.**
TypeScript 7's native compiler doesn't ship that file, and
`typescript-language-server` needs it. Install a TypeScript 5.x development
dependency in the project.

## MCP servers

**A server from `.mcp.json` is disabled.** Project servers run only after
you approve them. Open `/mcp`, select the server, and choose Enable.

**A server asks for approval again.** Its command or URL changed since you
approved it. Approvals are tied to the configuration.

**A server needs sign-in.** Open `/mcp`, select the server, and choose
Authenticate. Tokens are stored under `~/.onecode/mcp-auth/`.

## Hooks

**A project's hooks don't run.** They need one-time approval at startup.
Restart the session and accept, or check
`~/.onecode/hooks/project-approvals.json`.

**A hook blocks a call with no message.** A `PreToolUse` or
`UserPromptSubmit` hook that times out blocks by design. Set
`CC_HOOKS_DEBUG=1` to see each dispatch and outcome.

## Sessions

**My background shells are gone after `/clear`.** Background work ends
with the session. The new session lists what was stopped.

**A resumed session is in a different permission mode.** Modes aren't
saved with the session. Pass `--permission-mode` or set a default.

**The `/effort` level reset after a restart.** `/effort` doesn't save the
level. Open pi's `/thinking` picker and press **ctrl+s** to save a startup
default, or pass `--thinking <level>` at launch.

## Interface

**PgUp and PgDn do nothing in a panel.** In full-screen mode pi uses them
for its scrollback. Use the keys the panel's footer names (**Space** and
**b** page in the doctor report, for example).

**I want pi's own banner, footer, or spinner back.** Set `CC_NO_BANNER=1`,
`CC_FOOTER=0`, or the other toggles listed in
[Environment variables](reference.md#environment-variables).

## Getting help

Report problems at the project's GitHub repository. Include the output of
`onecode doctor`, your platform, and the model and provider in use.
