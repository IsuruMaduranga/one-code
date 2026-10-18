# Extension rules

[← Developer docs](README.md)

These are the rules every One Code extension follows. Each one exists
because breaking it caused a real bug, and most of those bugs were silent:
nothing failed, the prompt cache stopped hitting, or a permission check
quietly stopped applying. Each section states the rule and then the reason.
The files named are where to look for the details.

- [Shape of an extension](#shape-of-an-extension)
- [Load order](#load-order)
- [Extensions talk over the event bus](#extensions-talk-over-the-event-bus)
- [Steering the model](#steering-the-model)
- [Keep the prompt cache hitting](#keep-the-prompt-cache-hitting)
- [Tool behavior](#tool-behavior)
- [Sessions, children and lifecycle](#sessions-children-and-lifecycle)
- [Safety and permissions](#safety-and-permissions)
- [Paths, state and shells](#paths-state-and-shells)
- [Terminal UI](#terminal-ui)
- [Packaging](#packaging)

## Shape of an extension

**Logic lives in pure modules with no pi imports. `index.ts` is thin
wiring.** A pure module can be unit-tested with plain inputs; pi's runtime
can't be stood up cheaply in a unit test. So `index.ts` translates pi events
into calls on the module and the module's answers back into pi calls, and
nothing else. Test the module in `test/unit/`, and drive the wiring end to
end (see [Testing](testing.md)).

**One Code never forks or patches pi.** Everything uses pi's public
extension API. If a change seems to need a patch to pi, find another way or
raise it with pi upstream.

**Tool names are snake_case.** That's pi's convention. Users write Claude
Code's PascalCase names (`Bash`, `Edit`, `Task`) in permission rules and hook
matchers, and `extensions/permissions/matcher.ts` maps between the two.
`Agent` and `SendMessage` keep their PascalCase names.

**When a feature mirrors Claude Code, match its behavior.** Users bring
their Claude Code habits and configuration, so a mirrored command or tool
should behave the same way, with no extras. Deliberate differences are
listed in the user guide's
[differences page](../guide/differences-from-claude-code.md).

## Load order

**The order of `pi.extensions` in `package.json` is load-bearing.** It
decides two things:

- **Which handler runs first.** When several extensions handle the same pi
  event, pi runs them in load order. A handler sees whatever the earlier
  ones did to the event.
- **Whether a message on the bus is heard.** `pi.events` doesn't replay. An
  extension that emits while loading must load *after* the extension that
  listens on that channel, or the message is lost.

The fixed points:

| Extension | Must load | Why |
|---|---|---|
| `kept-thinking` | First to handle `context` | Every later copy of the request's messages must already have old signed thinking stripped. |
| `system-reminder`, `tool-search` | Before anything that emits on their channels while loading | They own the reminder queue and the deferred-tool registry. |
| `context-budget` | Immediately before `system-reminder` | Its token-countdown line has to be queued when `system-reminder`'s `tool_result` handler writes one-shots into the result. |
| `system-prompt` | Last | It builds the system prompt from what every other extension registered. |

The curated list that child sessions load
(`extensions/lib/child-extensions.ts`) follows the same order.

Don't reorder the list without reading the header of the extension you're
moving.

## Extensions talk over the event bus

**Never share module state between extension files.** pi loads extensions
through jiti, which gives each extension its own copy of every module it
imports. A `const queue = new Queue()` exported from `extensions/lib/` is
a *different* queue in every extension that imports it, so writing to it
from one extension steers nothing.

**Cross-extension data goes over `pi.events`.** Channels are named
`one-code:<topic>`, and the module that defines a channel exports its name
as a constant. Look for an existing channel before adding one.

The rare piece of state that really must be one per process (a parser that
takes seconds to load, for example) lives on `globalThis`, as
`extensions/lib/bash-parser.ts` does.

## Steering the model

**Steer through the reminder queue, never with a bare message.** To tell the
model something, emit on `one-code:system-reminder` (the constant is
`REMINDER_CHANNEL` in `extensions/lib/reminders.ts`). The
`system-reminder` extension places the block in the request. Pick the
placement by the kind of fact; `last-append` is the default. The
[reminder queue](architecture.md#steering-the-model-the-reminder-queue)
table lists the four placements, what each is for, and where each one
lands. A local slash command that should leave a
breadcrumb registers through `registerLocalCommand` in
`extensions/lib/local-command.ts`.

**Harness notifications go through `createTaskNotifier`** in
`extensions/lib/notifications.ts`, never a bare `pi.sendMessage`. It frames
task and agent messages the same way everywhere and serializes them across
extensions. `test/unit/notification-fidelity.test.ts` locks the frames.

**Project instructions, memory and skills ride the first user message, not
the system prompt.** `claude-context`, `memory` and `skill` queue them as
`first-prepend` blocks.

## Keep the prompt cache hitting

Providers cache the prefix of a request. A byte that changes early in the
request makes everything after it a cache miss, which costs real money on
every turn of every session. A cache miss is a bug, not an accepted cost.

- **The system prompt stays byte-stable across turns.** Don't put anything
  in it that changes during a session: the time, a counter, the current
  mode. Those belong in reminders.
- **A `first-prepend` block is frozen after the first request.** A fact that
  changes later goes out as a one-shot.
- **Deferred tools never set `promptSnippet` or `promptGuidelines`.** Those
  would put the tool into the system prompt, and loading the tool later
  would rewrite it. Defer a tool by emitting on `one-code:defer-tool`
  (`DEFER_CHANNEL` in `extensions/lib/deferred.ts`) while extensions load.
- **Side calls reuse the session's cache.** A fork, a side question or a
  compaction that inherits the conversation is built from the session's last
  request (`extensions/lib/request-replay.ts`), never from a fresh prompt.
  Every side call passes a stable per-session cache key and puts its cache
  breakpoint on the reusable prefix.
- **Check it.** After touching anything that feeds the request, run the
  cache probe. [Testing](testing.md#the-prompt-cache-probe) lists what counts.

## Tool behavior

**Never truncate model-facing text.** A tool result, a report or a
notification that might be large goes through `persistIfLarge` in
`extensions/lib/persisted-output.ts`. It saves the full text to a file and
gives the model a preview plus the path, so nothing is lost and the model can
read the rest. A bare `.slice()` drops information the model doesn't know is
missing. The one exception is a clip Claude Code itself makes on the same
text; then match that clip exactly.

**Tool errors fail loud and name the fix.** A malformed, ambiguous or
incomplete call returns an error that says what to do differently. Never
return a plausible-looking success. A model that gets a wrong success
carries on confidently in the wrong direction.

**Telling the model a file changed doesn't mark it as read.** `file-tracker`
refuses an edit to a file the model hasn't read, or that changed since it
last read it. A reminder that says "this file changed" must not count as a
read, or that guard stops working.

## Sessions, children and lifecycle

**Nothing outlives its session.** Anything that can fire after
`session_shutdown` (a timer, a watcher, a late callback) checks that its
session is still live and does nothing if it isn't.

**A tool that detaches work blocks in one-shot runs.** In `-p` and
`--mode json` the process exits as soon as the turn settles, so a background
task would be killed half done. Check `sessionOutlivesTurn(ctx.mode)` in
`extensions/lib/notifications.ts` and wait for the work when it's false.

**Anything a tool call awaits in a one-shot run holds a ref'd handle.**
Some helpers unref their child processes so an idle run can exit. If an
await on such a helper is the only pending work, Node's event loop drains
and the process exits mid-call with code 0. Wrap the outermost await in
`withKeepAlive` (`extensions/lsp/keep-alive.ts`).

**Never await slow work in `session_start`.** It holds up the first prompt.
Start the work and let it finish in the background.

**In-process child sessions go through `openChildSession`** in
`extensions/lib/agent-loader.ts`. It builds one resource loader per session
and binds the curated child extensions. Subagents and workflow agents both
use it.

**A child reattaches the permission gate through the parent's bridge, and
that bridge fails closed.** If the bridge is missing, the child's tool calls
are refused, never allowed. The hook bridge loads first and fails open,
because a missing hook must not stop the agent.

## Safety and permissions

Auto mode decides, without asking, what a model may run on someone's
machine. Treat every change in `extensions/permissions/` and
`extensions/auto-mode/` as security-sensitive, and test both the allowed
and the blocked direction live.

- **The shell pre-gate only ever proves "safe".** Never add a deny path to
  it. It exists to skip the classifier for commands it can prove harmless;
  anything it can't prove goes to the classifier.
- **A command joins the read-only fast path only with an option table.** Add
  it to `extensions/auto-mode/read-only-options.ts` with every option it
  accepts, never by name alone. A "read-only" command with one writing flag
  (`sort -o`, `find -delete`) is not read-only.
- **`extensions/auto-mode/classifier-prompt.ts` is generated.** Don't edit it
  by hand. Open an issue if the ruleset needs to change.
- **Project settings can't turn on auto or bypass mode.** `autoMode`,
  `defaultMode: "auto"` and `bypassPermissions` are only read from the
  user's own settings. A repository you cloned must not be able to switch
  off your prompts.
- **A settings file that grants permissions joins the safety floor.** If you
  add a file that can grant permissions, add it to
  `extensions/auto-mode/safety-floor.ts`, so the model can't write itself a
  permission and then use it.
- **Never trust a side channel through tool input.** The model writes the
  tool input. A field that looks like it came from the harness may not have.
- **Rule semantics differ by kind.** Bash deny and ask rules match every
  form of a command line. Allow rules match only the literal spelling, and
  must cover every subcommand of a compound line. Session grants are scoped
  and never apply in auto mode.
- **A tool that other tools sit behind is auto-allowed.** `tool_search`,
  `skill`, `Agent`, `workflow` and `structured_output` only lead to other
  tool calls, which are gated themselves.
- **Reads and edits stay in the working space.** That means the working
  directory, the harness's session directories, and directories the user
  added. Anything outside is gated.

## Paths, state and shells

- **`~/.claude` is read-only.** Claude Code paths go through
  `extensions/lib/paths.ts` (`claudeUserDir`, `claudeJsonPath`,
  `claudeConfigDir`, `expandTilde`). The one place One Code writes under
  `~/.claude` is the per-repository auto-memory folder, which both tools
  share.
- **One Code's own settings go to `~/.onecode`** through
  `extensions/lib/one-code-settings.ts`.
- **Never hardcode `~/.pi`.** Resolve pi's state through pi's
  `getAgentDir()`, since the app moves it to `~/.onecode/agent`.
- **Never spawn `/bin/sh`, `$SHELL` or a bare `pwsh`.** Go through
  `extensions/lib/shell-spawn.ts`, which knows about Git Bash and PowerShell
  on Windows. A user-named command (a language server, `$EDITOR`) goes
  through `extensions/lib/command-launch.ts`.
- **Wait for and stop processes with `extensions/lib/process-tree.ts`.**
  Use `waitForChildExit` and `killProcessTree`, which handle process groups
  and Windows.
- **Write paths that work on Windows.** Use `path.isAbsolute`, match path
  rules against forward-slashed paths, and display paths through
  `tildify` in `extensions/lib/paths.ts`. Tests build absolute
  expectations with `join` and `resolve`, never a hardcoded `/`.
- **PowerShell permission rules go through
  `extensions/permissions/powershell-rules.ts`.**

## Terminal UI

- **Memoize `render(width)`.** pi re-renders often. A custom component
  should cache its lines per width, as `linesComponent` in
  `extensions/lib/tui-render.ts` does.
- **Measure terminal columns, never `.length`.** Wide characters and ANSI
  codes make string length lie. Use pi-tui's `visibleWidth`.
- **Every panel key ships with an on-screen hint.** Users can't discover a
  key nobody shows them.

## Packaging

- **Import `@earendil-works/pi-ai` only by its bare name, `/compat`,
  `/oauth` or `/providers/all`.** Deeper subpaths work in development and
  break in the bundled app. `test/unit/pi-ai-import-shape.test.ts` checks
  this; vendor anything else you need.
- **`app/` declares every package pi's unbundled build imports.**
  `test/unit/app-dependency-closure.test.ts` checks the list.
- **Releases are lockstep.** Both packages get the same version, and the
  app pins pi exactly. Maintainers cut releases; a pull request doesn't
  bump versions.
