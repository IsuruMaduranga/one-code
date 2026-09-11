# The terminal interface

This page describes what you see on screen and how to move around it: the
banner, the status line, the working indicator, the panels below the
editor, the dialogs, and the themes.

## The banner

The session opens with a One Code wordmark, the version, and a live line
showing the model, the permission mode, and the subagent model. Below it, a
hint line lists the keys worth knowing:

| Hint | Meaning |
|---|---|
| `/hotkeys` | pi's full key list. |
| `shift+tab` | Cycle reasoning effort. |
| `ctrl+q` | Cycle the permission mode. |
| `ctrl+t` | Show or hide thinking blocks. |
| `ctrl+o` | Expand a collapsed tool output. |
| `/` | List commands. |
| `!` | Run a shell command yourself. |
| `ultracode` | The keyword that turns on workflow orchestration for a turn. |

On a machine with no provider yet, the banner reads `model none` and a
notice points you at `/login`.

When pi's `quietStartup` setting is on (the bundled app turns it on), the
startup listing is compact: one line each for the instruction files in
context, the skills found, the saved workflows, and the themes.

Set `CC_NO_BANNER=1` to keep pi's own header.

## Prompt and transcript markers

Your input line starts with a `❯` marker and the model's replies with a `●`
bullet, as in Claude Code. Tool calls render as `● Tool(arguments)` with
the result on an indented `⎿` line. Thinking is collapsed behind
`✻ Thinking… (ctrl+t to expand)`.

Set `CC_NO_INPUT_MARKER=1` or `CC_NO_ASSISTANT_MARKER=1` to remove either
marker.

## The working indicator

While the model works, a spinner shows a random verb, the elapsed time, and
the tokens streamed so far, for example `✳ Cogitating… (12s · ↓ 843 tokens)`.
The clock runs from the start of the turn until it settles, through retries.

After the turn, a dim `✻ Cooked for 5m 12s` line reports the total time.
Set `CC_TURN_DURATION=0` to turn it off.

## The status line

The footer replaces pi's status line with One Code's own:

- **Left:** the working directory, the git branch, and the open pull
  request number for that branch when the GitHub CLI is installed.
- **Right:** context usage as `used/window (percent)`, the session cost,
  the cache-hit rate of the latest turn, the model, and the reasoning
  effort. When ultracode is armed, the effort reads `✦ ultracode`.

The cost is all-in: it includes the main conversation plus every model call
One Code makes on the side, such as subagents, the auto-mode classifier,
web-fetch reader calls, and recaps. pi's own footer counts only the main
conversation. When the line is too narrow, the cache-hit rate goes first,
then the pull request, then the branch.

Set `CC_FOOTER=0` to keep pi's footer.

## The panel below the editor

One panel below the editor holds the background-shell manager and the
live subagent tree. It appears when there is something to show and hides
when there is not.

- Press **↓** from an empty editor to focus it. If background shells exist,
  the first **↓** lands on the shells chip; a second **↓** moves to the
  subagent rows. Otherwise the first **↓** lands on the first subagent.
- In the subagent rows, **↑** and **↓** select, **Enter** opens the
  selected agent's live transcript, **x** stops it, **ctrl+x** then
  **ctrl+k** stops every agent, and **Esc** leaves the panel. Typing any
  other key returns to the editor.
- Inside a transcript, **↑** and **↓** scroll, **PgUp** and **PgDn** page,
  **Tab** switches to the next agent, **←** returns to the row list, and
  **Enter** closes the view.

The panel's own footer names the keys that apply at each stage. Mouse-wheel
scrolling is deliberately not enabled in the transcript view, because
turning on mouse reporting would take over the terminal's native scrolling
and text selection for the whole session.

Details of the shells section are in
[Background shells](tasks-and-background-work.md#background-shells); the
subagent view is in [Follow agents live](subagents-and-workflows.md#follow-agents-live).

## The question dialog

When the model asks structured questions with `ask_user_question`, a dialog
opens with one tab per question and a final Submit tab.

- **←**, **→**, **Tab**, and **shift+Tab** switch questions.
- **↑** and **↓** move between options. **Enter** selects one; a
  single-choice question then advances to the next tab.
- A number key selects that option directly.
- Multiple-choice questions show checkboxes and a **Next** row to move on.
- Questions without option previews have an **Other** row for a typed
  answer. Questions with previews show the preview beside the options and
  take free text through a notes field, opened with **n**.
- **Chat about this**, the last row of every question, closes the dialog
  and tells the model you want to discuss before answering.
- On the Submit tab, **Enter** submits, or jumps to the first unanswered
  question. **Esc** cancels; nothing is submitted.

## Approval dialogs

The permission prompt and the plan-approval dialog are described in
[The approval prompt](permissions-modes-and-auto-mode.md#the-approval-prompt)
and [Plan mode](permissions-modes-and-auto-mode.md#plan-mode).

## Panels opened by commands

| Command | Panel | Keys |
|---|---|---|
| `/agents` | The live subagent panel, focused on the newest agent. | See the preceding section. |
| `/workflows` | The workflow run viewer. | **↑↓** select, **Enter** open, **Tab** next run, **x** stop, **s** save the script, **Esc** back or close. |
| `/skills` | The skills panel. | **↑↓** move, **Enter** or **Space** cycle a skill's state, **/** search, **t** sort, **Esc** close. |
| `/plugins` | The plugin marketplace, with Discover, Installed, Marketplaces, and Errors tabs. | **←→** or **Tab** switch tabs, **Esc** close. Discover: type to search, **Space** install, **Enter** view. Installed (like `/skills`): **Enter**/**Space** toggle, **v** view, **e**/**d** set, **u** uninstall, **f** favorite, **/** search. In a detail view: **Enter**/**Space**/**e**/**d** toggle, **u** uninstall, **i** install, **f** favorite. On Marketplaces: **a** add, **u** update, **d** remove. |
| `/mcp` | The MCP server manager. | **↑↓** navigate, **Enter** open a server or run an action, a digit picks a numbered action, **Esc** back or close. |
| `/doctor report` | The setup report. | **↑↓** or **j**/**k** scroll, **Space**/**b** page, **g**/**G** top and end, **f** run the checkup, **Esc** or **q** close. |
| `/memory` | The instruction and memory file picker. | **↑↓** move, **Enter** open, **Esc** close. |
| `/effort` | The reasoning-effort slider. | **←→** or **h**/**l** adjust, **Enter** confirm, **Esc** cancel. |

**ctrl+c** closes any panel.

PgUp and PgDn do not reach these panels in full-screen mode, because pi uses
them for its own scrollback; use the keys the panel's footer names.

## Full-screen mode

The bundled app runs in pi's full-screen mode, on the terminal's alternate
screen, and restores your terminal when you exit. On a plain pi
installation full-screen mode is opt-in; see
[Full-screen mode and themes](configuration.md#full-screen-mode-and-themes).

## Themes

Two themes ship: `onecode` (dark, the bundled app's default) and
`onecode-light`. Any other pi theme also works. See
[Full-screen mode and themes](configuration.md#full-screen-mode-and-themes)
for how to select one.

## Keyboard shortcuts

The full list of One Code and pi shortcuts is in the
[command and keyboard reference](reference.md#keyboard-shortcuts).
