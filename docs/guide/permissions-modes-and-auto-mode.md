# Permissions, modes, and auto mode

One Code gates every tool action through a permission system. This page explains
the permission modes, how to cycle them, how to write rules, and how plan mode
and auto mode change what needs approval.

## Permission rules

One Code reads `allow`, `deny`, and `ask` rules from `.claude/settings.json`:

- `allow` runs the matching action without a prompt.
- `ask` prompts you before the action runs.
- `deny` blocks the action. A `deny` rule always wins over an `allow` rule.

Rules match tools by name and by argument. Claude Code's PascalCase tool names
work in these rules, so a setup you wrote for Claude Code applies as it is.

To add a rule during a session, run `/allow`. To review the current rules, run
`/permissions`. Rules One Code adds for you are saved to `~/.onecode`, not to
`~/.claude`.

## Permission modes

A mode sets the default answer for actions no rule covers. Cycle through the
modes with **ctrl+q**. The cycle is:

1. **Manual** (the default): prompts for anything not already allowed.
2. **Accept edits**: file edits run without a prompt; other actions still
   prompt.
3. **Plan**: read-only planning. See the next section.
4. **Auto**: a classifier approves routine actions and stops risky ones. See
   [Auto mode](#auto-mode).

Two more modes exist outside the cycle. **Bypass permissions** runs everything
without prompts; reach it deliberately, not by cycling. **Don't ask** suppresses
prompts for the current session.

> **shift+tab** is a different control: it moves the reasoning-effort dial, not
> the permission mode. See [Reasoning effort](reference.md#reasoning-effort).

## Plan mode

Plan mode lets the model investigate and write a plan without changing your
code. In this mode the model can only write to a dedicated plan file under
`~/.onecode/plans`; every other write is blocked.

When the model finishes planning, an approval dialog shows the plan. Nothing
runs until you approve it. The plan file survives context compaction, and you
can edit it yourself while the model works.

Enter plan mode by cycling to it with **ctrl+q**, or start a session in it with
`pi --permission-mode plan`.

## Auto mode

Auto mode removes routine approval prompts without removing the boundary. A
classifier screens each action:

- Read-only actions pass freely.
- Risky actions are stopped unless a rule you wrote allows them. Examples
  include writing outside your project, touching credential paths, force
  pushes, and piping a download straight into a shell.

A deterministic safety floor protects One Code's own configuration regardless of
what the model decides, so auto mode cannot be talked into changing its own
guardrails.

Run `/auto-mode` to see and adjust auto-mode settings. Run `/auto-mode setup` to
walk through configuring the rule lists that shape what auto mode allows and
denies.

## A boundary, not a promise

One Code's security model is the permission system plus auto mode, not an
assumption that the model behaves. Every action is gated, `deny` rules always
win, and risky operations are stopped. For an operating-system-level wall on top,
run One Code inside a container; the permission gate and the container work
together.
