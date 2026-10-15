# Getting started

[← Developer docs](README.md)

This page gets a checkout of One Code running against a real model and
walks through the pull request flow.

## What you need

- **Node.js 22.19 or later.** pi crashes on older versions at startup.
- **Git.**
- **A model provider.** An API key in the environment (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `OPENROUTER_API_KEY` and so on) or an account you sign in
  to with `/login`. A cheap model is fine for most work.
- **tmux**, if you want to run the terminal UI from a script or an agent's
  shell. See [Testing](testing.md#the-terminal-ui).
- **PowerShell 7 (`pwsh`)**, only if you work on the PowerShell tool or
  Windows behavior. It runs on macOS and Linux too.

## Set up the repository

Fork the repository on GitHub, then:

```bash
git clone https://github.com/<you>/one-code
cd one-code
git checkout dev
npm install
```

Work happens on `dev`, and `master` only moves when `dev` is promoted to
it. Branch from `dev` and open your pull request against `dev`.

Check that everything passes before you change anything:

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

Both must pass on every pull request. CI runs them on Linux, macOS and
Windows.

## Run your checkout

`npm install` puts pi itself in `node_modules`, so `npx pi` runs the same pi
version the repository develops against. There are three ways to run your
changes, from narrowest to widest.

### One extension on its own

```bash
npx pi -e ./extensions/<name>/index.ts -p "your prompt"
```

`-e` loads one extension file on top of whatever pi already loads. It's the
quickest loop for an extension that doesn't depend on others. Most One Code
extensions do talk to each other over `pi.events` (see
[Extension rules](extension-rules.md#extensions-talk-over-the-event-bus)),
so for anything that steers the model or gates tools, load the whole package
instead.

### The whole package in pi

Install your checkout as a pi package. Do it with a throwaway pi state
directory so your own pi setup stays untouched:

```bash
ONE_CODE="$PWD"
export PI_CODING_AGENT_DIR="$(mktemp -d)"
"$ONE_CODE/node_modules/.bin/pi" install "$ONE_CODE"

cd /path/to/some/project
"$ONE_CODE/node_modules/.bin/pi"
```

The new state directory has no saved logins, so use an API key from the
environment or run `/login` once inside the session.

pi loads the package straight from your checkout, so an edit takes effect
the next time you start pi, or after `/reload` inside a session. `pi list`
shows what's installed and `pi remove "$ONE_CODE"` takes it out again.

Useful run modes:

```bash
pi -p "prompt"                 # one-shot, prints the answer
pi --mode json -p "prompt"     # one-shot, JSONL events on stdout
pi --mode rpc                  # driven over stdin/stdout, see Testing
```

### The bundled app

`app/` is the `@one-ai/one-code` package, the `onecode` command. It's a thin
launcher (`app/bin.mjs`) that pins pi, keeps state in `~/.onecode` and
registers the extension package from its own dependencies. It depends on
the *published* `one-code-extension`, so it doesn't pick up your checkout.
To test the app against your changes, `test/e2e/app-smoke.sh` packs both
packages and installs them into a throwaway prefix. You rarely need this
unless you're changing `app/` or how the package is resolved.

## Repository layout

| Path | What's there |
|---|---|
| `extensions/<name>/` | One pi extension each. `index.ts` is wiring; the logic is in the modules beside it. |
| `extensions/lib/` | Pure modules shared across extensions. |
| `extensions/auto-mode/` | The auto-mode classifier library, called by `permissions`. Not an extension. |
| `agents/`, `skills/`, `themes/` | The bundled agent, skill and theme catalogs. |
| `app/` | The `onecode` app package. Plain JavaScript. |
| `test/unit/` | Vitest over the pure modules. |
| `test/e2e/` | Live harnesses: RPC drivers, request dumps, the cache probe, smoke tests. |
| `scripts/` | Generators, such as the bundled model catalog. |
| `docs/guide/` | The user guide. Ships in the npm package. |
| `docs/dev/` | These pages. |

The `pi.extensions` list in `package.json` decides which extensions load and
in what order. See [Architecture](architecture.md) for what each group does.

## Making a change

1. Find the extension that owns the behavior. The
   [extension map](architecture.md#the-extensions-by-role) and a search for
   the tool or command name usually get you there.
2. Put the logic in a pure module (no pi imports) and test it in
   `test/unit/`. Keep `index.ts` to wiring.
3. Read [Extension rules](extension-rules.md) for anything your change
   touches. The rules about load order, caching and the permission system are
   the ones that break silently.
4. Run it live against a model at least once, without
   `--dangerously-skip-permissions`, so the permission gate is part of the
   run.
5. If you changed anything that reaches the model's request (prompts, tool
   descriptions, reminders, deferral), run the cache probe. See
   [Testing](testing.md#the-prompt-cache-probe).

## Pull requests

- Open the pull request against `dev`. Keep it to one logical change.
- Describe what changed and why. Say how you checked it, and name the model
  if you ran it live.
- If your change mirrors a Claude Code feature, match how Claude Code
  behaves rather than inventing new behavior. Where One Code deliberately
  differs, the difference belongs in
  [`docs/guide/differences-from-claude-code.md`](../guide/differences-from-claude-code.md).
- Update the user guide when user-visible behavior changes.
- Don't add AI attribution or `Co-Authored-By` trailers to commit messages.
