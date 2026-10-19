# One Code developer docs

These pages are for people who want to change One Code itself: fix a bug,
add a tool, or understand why something works the way it does. If you only
want to use One Code, the [user guide](../guide/README.md) is the place to
start.

Read them in this order:

1. [Getting started](getting-started.md): set up the repository, run your
   checkout against a real model, and open a pull request.
2. [Architecture](architecture.md): diagrams of how the extensions, pi, the
   permission system, the reminder queue and the subagents fit together.
3. [Extension rules](extension-rules.md): the rules every extension follows,
   each with the reason it exists. Most review comments point at one of these.
4. [Testing](testing.md): unit tests, the end-to-end harnesses, the prompt
   cache probe, and what CI runs.

[`AGENTS.md`](../../AGENTS.md) at the repository root is the short version
for AI coding agents. It points back here for detail.

## Where else the knowledge lives

The code is the source of truth, and most of the "why" sits in comments next
to it. Module headers explain contracts (for example, the reminder queue in
`extensions/lib/reminders.ts` or the deferred-tool registry in
`extensions/lib/deferred.ts`), and the comment above a tricky line usually
says what broke before it was written that way. When these pages and a
comment disagree, trust the comment and tell us about the page.
