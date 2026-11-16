# The terminal interface

[← One Code user guide](README.md)

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
| `ctrl+q` (`alt+m` on Windows and WSL) | Cycle the permission mode. |
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

Set `ONECODE_NO_BANNER=1` to keep pi's own header.

## Prompt and transcript markers

Your input line starts with a `❯` marker and the model's replies with a `●`
bullet, as in Claude Code. Your messages in the transcript carry the same
`❯`, and a slash command you typed shows as the command line, not the prompt
it expands to. Tool calls render as `● Tool(arguments)` with
the result on an indented `⎿` line. Thinking is collapsed behind
`✻ Thinking… (ctrl+t to expand)`.

Set `ONECODE_NO_INPUT_MARKER=1` or `ONECODE_NO_ASSISTANT_MARKER=1` to remove either
marker.

When you type a slash command that takes an argument followed by a space, a
dim placeholder after the cursor shows what goes there, as in Claude Code:
`/loop ` shows `[interval] [prompt]`, and `/add-dir ` shows `<path>`. It
disappears once you start typing the argument. Skills and custom commands
get theirs from an `argument-hint` line in their frontmatter. A custom
command that lists `arguments` instead shows the names you haven't typed
yet, one space at a time.

## The working indicator

While the model works, a spinner shows a random verb, the elapsed time, and
the tokens streamed so far, for example `✳ Cogitating… (12s · ↓ 843 tokens)`.
The clock runs from the start of the turn until it settles, through retries.

After the turn, a dim `✻ Cooked for 5m 12s · done 2:33 PM` line reports the
total time and when the turn finished.
Set `ONECODE_FEATURES_OFF=turn-duration` to turn it off.

## The status line

The footer replaces pi's status line with One Code's own:

- **Left:** the working directory, the git branch, and the open pull
  request number for that branch when the GitHub CLI is installed. The pull
  request is checked again every minute while you're using the session, so
  one merged or closed mid-session drops off, and a new one appears.
- **Right:** context usage as `used/window (percent)`, the session cost,
  the cache-hit rate of the latest turn, the model, and the reasoning
  effort. When ultracode is armed, the effort reads `✦ ultracode`.

The cost is all-in: it includes the main conversation plus every model call
One Code makes on the side, such as subagents, the auto-mode classifier,
web-fetch reader calls, and recaps. pi's own footer counts only the main
conversation. When the line is too narrow, the cache-hit rate goes first,
then the pull request, then the branch.

Set `ONECODE_FEATURES_OFF=footer` to keep pi's footer.

## The panel below the editor

One panel below the editor holds the background-shell manager and the
live subagent tree. It appears when there's something to show and hides
when there isn't.

- Press **↓** from an empty editor to focus it. If background shells exist,
  the first **↓** lands on the shells chip; a second **↓** moves to the
  subagent rows. Otherwise the first **↓** lands on the first subagent.
- In the subagent rows, **↑** and **↓** select, **Enter** views the
  selected agent (or `main`), **x** stops it, **ctrl+x** then **ctrl+k**
  stops every agent, and **Esc** hands focus back to the editor. Typing
  any other key does the same, with the key included.
- While you view an agent, the editor talks to it: the border shows which
  agent, and what you send goes to that agent instead of the main
  conversation. **PgUp** and **PgDn** scroll its transcript, and **Esc** in
  an empty editor takes you back to `main`.

The panel's own footer names the keys that apply at each stage. Mouse-wheel
scrolling deliberately isn't enabled in the transcript view, because
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
| `/effort` | The reasoning-effort slider. | **←→** or **h**/**l** adjust, **Enter** confirm, **s** this session only, **Esc** cancel. |

**ctrl+c** closes any panel.

In full-screen mode, PgUp and PgDn page a panel that scrolls, such as
`/permissions`, `/plugins`, `/doctor` and the agent view. The other panels
leave those keys to the transcript behind them, so use the keys the panel's
footer names.

## Full-screen mode

The bundled app runs in pi's full-screen mode, on the terminal's alternate
screen, and restores your terminal when you exit. pi 1.0 and later start
in full-screen mode too; on an older pi it's opt-in. See
[Full-screen mode and themes](configuration.md#full-screen-mode-and-themes).

## Themes

Two themes ship: `onecode` (dark) and `onecode-light`. The bundled app
picks the one that matches your terminal's background, and switches when
your terminal does (for example, when macOS changes between light and
dark). Any other pi theme also works. See
[Full-screen mode and themes](configuration.md#full-screen-mode-and-themes)
for how to select one.

## Desktop notifications

One Code tells you when it's waiting for you, as Claude Code does. When a
permission question or another prompt has waited about six seconds without
a keypress, you get "One Code needs your permission to use Bash" (or "needs
your attention"). When a turn you started has finished and you haven't
touched a key for a minute, you get "One Code is waiting for your input".

The notification goes through your terminal: iTerm2, kitty and Ghostty show
it as a desktop notification. Other terminals, and a session inside tmux,
get nothing unless you pick a channel with `preferredNotifChannel` in
`~/.onecode/settings.json`, for example `"terminal_bell"`; inside tmux a
desktop channel also needs tmux's `allow-passthrough` option. Set it to
`"notifications_disabled"` to turn notifications off. A `Notification`
hook runs with each one, whatever the channel; see [Hooks](hooks.md).

Notifications come only from the terminal interface, never from a one-shot
or RPC run.

## Shell commands you type

Start a line with `!` to run a shell command yourself, such as `!git status`.
In the `onecode` app's terminal, when the model is idle, One Code starts a
turn as soon as the command finishes, so the model reacts to the output
without you typing anything. When you run One Code as a pi package, the
command runs the way pi runs it and the output goes out with your next
message.

Start the line with `!!` instead to run the command without putting its
output in the model's context. A `!!` command never starts a turn.

No turn starts when you cancel the command (press **Esc** while it runs), or
when you typed it while the model was working. In that case the output
travels with your next message too.

## Keyboard shortcuts

The full list of One Code and pi shortcuts is in the
[command and keyboard reference](reference.md#keyboard-shortcuts).
