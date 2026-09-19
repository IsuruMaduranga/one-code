# AGENTS.md

Guidance for AI coding agents and human contributors working in this
repository. One Code recreates the Claude Code workflow as a
[pi](https://github.com/earendil-works/pi) package, so the same agent
experience runs on any model or provider. See the
[user guide](docs/guide/README.md) for product docs.

## Ground rules

- One Code is an ordinary pi package. It uses the public pi extension API only.
  Never fork or patch pi; if something seems to need a patch, it does not.
- Behaviour parity with Claude Code is a goal. When a feature mirrors Claude
  Code, keep it byte-compatible with the captured reference rather than
  inventing new behaviour.
- Keep changes focused. One logical change per pull request.

## Setup and commands

Requires Node >= 22.19.

```bash
npm install          # install dependencies

npm run typecheck    # tsc --noEmit (must pass)
npm test             # vitest run (must pass)

# Try one extension in isolation against a live model:
pi -e ./extensions/<name>/index.ts -p "…"
```

Both `npm run typecheck` and `npm test` must pass before a change is ready to
merge.

## Repository layout

- `extensions/` — the pi extensions that make up One Code. Each is a folder
  with a thin `index.ts` for wiring plus pure logic modules. `extensions/lib/`
  holds shared modules used across extensions.
- `app/` — the bundled npm app (`@one-ai/one-code`, the `onecode` binary):
  `bin.mjs` and `update-check.mjs`, plain JavaScript.
- `agents/` — bundled agent catalog (general-purpose, explore, plan).
- `skills/` — bundled skill catalog adapted from Claude Code's built-ins.
- `themes/` — bundled colour themes.
- `test/unit/` — vitest over the pure modules. `test/e2e/` — end-to-end harness
  scripts.
- `docs/guide/` — the user-facing documentation.

## Conventions

- **Logic lives in pure modules with no pi imports; `index.ts` is thin
  wiring.** Unit-test the module, drive the wiring end to end.
- **Tool names are pi-idiomatic snake_case.** Claude Code PascalCase
  counterparts are mapped in `extensions/permissions/matcher.ts`.
- **The `pi.extensions` order in `package.json` is load-bearing.** Extensions
  that emit on a channel must load after the extension that owns that channel,
  because the event bus does not replay. Do not reorder without understanding
  the dependency.
- **Never share module state between extension files.** Each file is isolated;
  pass cross-extension data over `pi.events`.
- **Steer the model through the reminder queue, not ad-hoc messages.** Emit the
  documented events rather than injecting text directly.
- **Keep the request prefix cache-stable.** The system prompt and the first
  user message must stay byte-stable across turns when nothing relevant
  changed, so the provider prompt cache keeps hitting. Do not rebuild the
  system prompt for a deferred tool.
- **Confine reads and edits to the working directory** and the harness session
  directories. Anything outside is gated by the permission system.
- **Never truncate model-facing text; persist it instead.** Bound large tool
  results, reports, and notifications through the persisted-output helper (file
  plus preview plus path), never a bare slice.
- **Tool `execute()` errors fail loud.** A malformed, ambiguous, or
  missing-required call returns an error naming the fix, never a
  plausible-but-wrong success.
- **Auto mode is safety-critical.** The permission classifier and shell gate
  decide what runs without asking. Treat any change there as security-sensitive
  and test both the allow and the block direction against a live model.

## Testing notes

- Unit tests (`npm test`) cover the pure modules. Add a unit test with any new
  pure module.
- Interactive behaviour (permission prompts, plan approval, LSP diagnostics)
  cannot be tested in one-shot `-p` mode. Drive `pi --mode rpc` and answer the
  UI request messages; `test/e2e/rpc-permission-test.mjs` is the worked
  example.
- Test at least one path without `--dangerously-skip-permissions`, or
  permission-gating bugs stay invisible.

## Commits and pull requests

- Write commit messages that describe what changed and why. Mention how the
  change was verified when behaviour was checked against a live model.
- Do not add AI attribution or `Co-Authored-By` trailers to commits.
- Open pull requests against `master`. Keep the diff focused so review stays
  sharp.
