# AGENTS.md

Guidance for AI coding agents working in this repository. Human contributors
should start with the [developer docs](docs/dev/README.md); this file is the
short version and points there for detail.

One Code recreates the Claude Code workflow as a
[pi](https://github.com/earendil-works/pi) package, so the same agent
experience runs on any model or provider. The [user guide](docs/guide/README.md)
covers the product.

## Ground rules

- One Code is an ordinary pi package and uses the public pi extension API
  only. Never fork or patch pi.
- When a feature mirrors Claude Code, match Claude Code's behavior, with no
  extras, rather than inventing new behavior.

## Commands

Requires Node 22.19 or later.

```bash
npm install
npm run typecheck    # tsc --noEmit, must pass
npm test             # vitest run, must pass
npx vitest run test/unit/<name>.test.ts   # one file, while iterating

# One extension in isolation against a live model:
npx pi -e ./extensions/<name>/index.ts -p "…"
```

Running the whole package from source: [Getting started](docs/dev/getting-started.md#run-your-checkout).

## Where things are

- `extensions/<name>/`: one pi extension each, a thin `index.ts` plus pure
  logic modules. `extensions/lib/` holds the shared modules.
- `extensions/auto-mode/`: the auto-mode classifier library, used by
  `permissions`.
- `app/`: the bundled `onecode` app, plain JavaScript.
- `agents/`, `skills/`, `themes/`: bundled catalogs.
- `test/unit/`: vitest. `test/e2e/`: live harnesses.
- `docs/guide/`: the user guide. `docs/dev/`: the developer docs.

[Architecture](docs/dev/architecture.md) has diagrams of how these fit
together.

## Rules that break silently

Each of these has caused a real bug. The reasons, and the full list, are in
[Extension rules](docs/dev/extension-rules.md).

- Logic goes in pure modules with no pi imports; `index.ts` is wiring only.
- The `pi.extensions` order in `package.json` is load-bearing. Don't reorder
  it without reading [Load order](docs/dev/extension-rules.md#load-order).
- Never share module state between extension files. Each extension gets its
  own copy of every module; cross-extension data goes over `pi.events`.
- Steer the model through the reminder queue (`one-code:system-reminder`),
  never with ad-hoc messages.
- Keep the request prefix byte-stable. Nothing that changes mid-session goes
  in the system prompt; deferred tools never set `promptSnippet` or
  `promptGuidelines`. After touching anything that reaches the request, run
  the [cache probe](docs/dev/testing.md#the-prompt-cache-probe).
- Never truncate model-facing text. Bound it with `persistIfLarge`
  (`extensions/lib/persisted-output.ts`).
- Tool `execute()` errors fail loud and name the fix, never a plausible
  success.
- Auto mode is security-sensitive. The shell pre-gate only proves "safe" and
  never denies; a command joins the read-only fast path only with an option
  table in `extensions/auto-mode/read-only-options.ts`; don't hand-edit
  `classifier-prompt.ts`.
- `~/.claude` is read-only (except the shared memory folder). One Code's
  settings go to `~/.onecode`; pi's state is resolved with `getAgentDir()`.
- Spawn shells through `extensions/lib/shell-spawn.ts`, never `/bin/sh`,
  `$SHELL` or a bare `pwsh`.

## Testing

- Add a unit test with any new pure module.
- Interactive behavior (permission prompts, plan approval, dialogs) can't be
  tested with `-p`. Drive `pi --mode rpc`; `test/e2e/rpc-permission-test.mjs`
  is the worked example.
- Run at least one path without `--dangerously-skip-permissions`.

More in [Testing](docs/dev/testing.md).

## Commits and pull requests

- Describe what changed and why. Mention how you checked it, and the model,
  when you ran it live.
- Don't add AI attribution or `Co-Authored-By` trailers.
- Keep each pull request to one logical change, opened against `dev`.
