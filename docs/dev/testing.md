# Testing

[← Developer docs](README.md)

One Code is tested at three levels. Unit tests cover the pure modules and run
on every pull request. End-to-end harnesses drive a real pi session, usually
against a real model. The prompt cache probe checks that requests stay
cache-friendly on the wire. This page says what each one is for and when to
run it.

## Unit tests

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npx vitest run test/unit/<name>.test.ts   # one file
```

Tests live in `test/unit/`, one file per module, named after it. They import
the pure modules directly, so they need no model, no network and no pi
session. Add a unit test with every new pure module, and a regression test
with every bug fix.

A few tests guard the repository's rules rather than one module's behavior.
When one of them fails, it's telling you about a rule, not a flaky check:

| Test | What it guards |
|---|---|
| `pi-ai-import-shape.test.ts` | Extensions import pi-ai only through the entry points that survive bundling. |
| `app-dependency-closure.test.ts` | `app/package.json` declares everything pi's unbundled build imports. |
| `notification-fidelity.test.ts` | Task and agent notifications keep their exact frames. |
| `config-mode-guard.test.ts` | Every reader of a Claude Code location is listed and accounted for. |

Write path expectations with `join` and `resolve` so the same test passes on
Windows. CI runs the unit tests on Linux, macOS and Windows, and a test that
hardcodes `/` fails on one of them.

## What CI runs

| Workflow | When | What |
|---|---|---|
| `ci.yml`, test job | Every pull request, every push to `master` | Typecheck and unit tests on Ubuntu, macOS and Windows. |
| `ci.yml`, oldest tested pi | Same | Loads the package on the oldest pi in the supported range and runs one turn against a local mock model (`test/e2e/pi-floor-smoke.mjs`). No provider key needed. |
| `live-smoke.yml` | On demand, and on `master` pushes that touch shell or permission code | A real model drives the bash and PowerShell tools on Windows and the bash tool on Linux (`test/e2e/live-smoke.mjs`). Needs a repository secret, so maintainers run it. |

The supported pi range is `TESTED_PI_MIN` and `TESTED_PI_MAX_EXCLUSIVE` in
`extensions/lib/pi-version.ts`. If your change uses a pi API that the oldest
version lacks, the pi-floor job fails. Feature-detect the API or raise the
floor in the same pull request and say why.

## Running against a live model

The commands below run in a shell set up as in
[Getting started](getting-started.md#the-whole-package-in-pi), where `pi` is
your checkout's `node_modules/.bin/pi` with the package installed.

Unit tests can't catch a prompt the model misreads, a hook that fires in the
wrong order, or a permission prompt that never appears. For any change in
behavior, run it live at least once.

```bash
pi -p "prompt"                 # one-shot answer
pi --mode json -p "prompt"     # one-shot, JSONL events, easy to grep
```

Run at least one path **without** `--dangerously-skip-permissions`. With that
flag the permission system is switched off, so a bug in it stays invisible.

### Interactive behavior over RPC

Permission prompts, plan approval, question dialogs and panels can't be
answered in `-p` mode. Run pi with `--mode rpc` instead: it speaks JSON over
stdin and stdout, and every dialog arrives as an `extension_ui_request` that
your script answers. The harnesses in `test/e2e/` are worked examples:

| Harness | Drives |
|---|---|
| `rpc-permission-test.mjs` | A permission prompt, answered yes, with a scoped grant, or no. Start here. |
| `rpc-plan-approve-test.mjs`, `rpc-plan-file-test.mjs` | Plan mode's approval dialog and plan file. |
| `rpc-ask-user-test.mjs` | The multi-question dialog. |
| `rpc-hooks-test.mjs` | Command hooks end to end. |
| `rpc-subagent-test.mjs`, `rpc-subagent-permission-test.mjs` | Subagents, and permission prompts raised inside them. |
| `rpc-workflow-permission-test.mjs` | Permission prompts inside a workflow agent. |
| `rpc-lifecycle-test.mjs` | Cancelling a permission prompt, and delivering input queued mid-turn. |
| `rpc-setup-test.mjs` | `/auto-mode setup` and its dialogs, without saving anything. |
| `rpc-external-includes-test.mjs` | The consent question for instruction files imported from outside the project. |
| `rpc-btw-test.mjs` | `/btw` answering without entering the main conversation. |
| `rpc-panels-test.mjs`, `rpc-agent-panels-test.mjs` | Every panel command produces output. No model calls. |

Each script's header gives its usage and says where it writes. Most use a
throwaway working directory, so an approved write never lands in your
checkout.

### The terminal UI

A script, CI job or AI agent's shell usually has no terminal, so pi falls back
to non-interactive output. `test/e2e/tui-capture.sh` starts pi inside tmux,
which gives it a real terminal, and prints the rendered screen as text:

```bash
test/e2e/tui-capture.sh /path/to/project 8          # wait 8 seconds, print the screen
CAPTURE_ANSI=1 test/e2e/tui-capture.sh .            # keep colors
```

Use it to check a layout, a panel or a startup notice. Any live run started
from a sandboxed shell needs tmux for the same reason.

### Seeing what the model receives

Most One Code bugs show up in the request, not in the transcript: a reminder
in the wrong place, a tool schema that changed, a block that moved. Two
helpers write requests to a JSONL file, one line per request:

```bash
WIRE_DUMP=/tmp/wire.jsonl pi -e test/e2e/dump-requests.ts --mode json -p "prompt"
CC_E2E_LOG=/tmp/raw.jsonl pi -e test/e2e/debug-capture.ts --mode json -p "prompt"
```

`dump-requests.ts` records the body exactly as the provider receives it,
after every extension has finished with it. `debug-capture.ts` records it
*before* the package's own request hooks run, which is useful when you need
to see what one of those hooks changed.

`enqueue-reminder.ts` queues a marker reminder at session start, which is a
quick way to check that bus steering reaches the request.

## The prompt cache probe

Prompt caching is what keeps long sessions affordable, and it breaks
silently: the answer stays right, only the bill goes up. The cache probe
runs a short live session, dumps every request, and checks two things. The
request prefix (system prompt, first message and eager tools) must stay
byte-identical from request to request. Each request must read what the
previous one cached.

```bash
test/e2e/cache-probe.sh anthropic/<model-id>
test/e2e/cache-probe.sh openrouter/<provider>/<model-id> --no-load
```

Use `--no-load` for a provider without native tool loading, such as
OpenRouter, where loading a deferred tool re-caches the conversation by
design. The probe also checks the auto-mode classifier's calls and the
`web_fetch` reader; its header lists the flags that skip those phases.

**Run it after touching anything that feeds the request:** the system
prompt, tool descriptions, reminders, deferral, compaction or the subagent
runner. It costs one short session, mostly cache writes.

`test/e2e/cache-probe-matrix.sh` runs the probe on one model per provider
family (Anthropic, OpenAI, OpenAI Codex, OpenRouter) and must pass before a
pull request merges or a version is bumped. You need keys for every
provider to run it. If you don't have them, say so in the pull request and a
maintainer will run it.

## Other smoke tests

- `test/e2e/live-smoke.mjs --shell bash|powershell`: the live shell smoke
  CI runs, usable locally with a provider key in the environment.
- `test/e2e/app-smoke.sh`: packs both packages, installs the app into a
  throwaway prefix, and checks that the extension set loads. Run it when you
  change `app/` or how anything is imported. Maintainers run it before every
  release.

## Before you open a pull request

- `npm run typecheck` and `npm test` pass.
- New pure logic has unit tests.
- You ran the changed behavior live at least once, with permissions on.
- If you touched the request prefix, the cache probe passes.
- If you touched permissions or auto mode, you checked that a call that
  should run runs, and a call that should be blocked is blocked.
