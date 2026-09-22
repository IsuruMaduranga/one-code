# One Code demo tape — records a terminal session to a GIF for the README.
#
# Regenerate from the repo root with:   vhs demo/onecode.tape
#
# Requirements:
#   - VHS installed:  https://github.com/charmbracelet/vhs
#   - One Code installed:  npm i -g @one-ai/one-code
#   - A provider already configured (so the run does not stop to ask for a key
#     on camera). Configure one once with `onecode` then `/login`.
#   - git and network access (the demo clones One Code and works on its own source).
#
# Tuning note: VHS records whatever is on screen during each `Sleep`, so the
# Sleep durations below must be long enough for your model to respond. A slower
# model needs longer Sleeps; a fast model gives a snappier clip. In the `/model`
# step, the filter text picks the model — the same model name can appear under
# several providers, so qualify it with the provider (the picker matches
# `provider/model`, e.g. `Type "openai luna"`) to land on your funded one.
#
# The /model choice is persisted into pi's settings by the app. To record
# without changing your own default, point PI_CODING_AGENT_DIR at a copy of
# ~/.onecode/agent (auth.json + settings.json) before running vhs.
#
# What the clip shows, in order: launch, the permission modes (auto is the
# default), a mid-session model switch, an agentic edit approved by auto
# mode, a /btw side question, /doctor report, and a subagent in the live panel.

Output demo/onecode.gif
# For a higher-quality player instead of a GIF, comment the line above and use:
# Output demo/onecode.mp4

Set Shell "bash"
Set FontSize 18
Set Width 1560
Set Height 860
Set Padding 24
Set Framerate 15
# Waits are real model latency; play the clip a little faster than it was recorded.
Set PlaybackSpeed 1.3
Set TypingSpeed 55ms
# Warm palette matching One Code's own theme (so the whole clip is on-brand).
Set Theme { "name": "onecode", "background": "#1c1917", "foreground": "#e8e2d8", "cursor": "#d97757", "selection": "#3a352f", "black": "#2a2725", "red": "#e05a52", "green": "#87b070", "yellow": "#e0a458", "blue": "#7ba2c8", "magenta": "#b48ead", "cyan": "#8bb5b7", "white": "#d8d2c8", "brightBlack": "#6b645c", "brightRed": "#e8726a", "brightGreen": "#9cc487", "brightYellow": "#ecb977", "brightBlue": "#93b4d6", "brightMagenta": "#c4a0bd", "brightCyan": "#9fc7c9", "brightWhite": "#f2ece2" }

# --- Set up: clone One Code so the demo works on its own source (dogfooding) ---
# Hidden so the GIF opens straight on the launch, not on shell setup.
Hide
Type `cd $(mktemp -d) && git clone -q --depth 1 https://github.com/IsuruMaduranga/one-code && cd one-code && clear`
Enter
Show
Sleep 800ms

# --- Launch One Code ---
Type "onecode"
Enter
Sleep 7s          # let the UI come up (keys pressed before that are lost)

# --- The permission modes: auto is the default; ctrl+q cycles through them ---
# auto -> manual -> accept edits -> plan -> auto (watch the badge)
Ctrl+q
Sleep 900ms
Ctrl+q
Sleep 900ms
Ctrl+q
Sleep 900ms
Ctrl+q
Sleep 1500ms

# --- Switch model mid-session: the catalog spans every configured provider ---
Type "/model"
Enter
Sleep 2000ms
Type "luna"       # type to filter — prefix your provider ("openai luna") when the name is not unique
Sleep 1500ms
Enter
Sleep 2000ms

# --- A real task on One Code's own source; auto mode approves the safe edit ---
Type "Add a short Troubleshooting section to app/README.md: if the onecode command isn't found after installing, make sure your npm global bin directory is on your PATH."
Enter
Sleep 45s         # let the agent read, edit, and verify — tune to your model

# --- /btw: a side question answered from the live context, never in the transcript ---
Type "/btw In one sentence, what did you change and why?"
Enter
Sleep 10s
Escape
Sleep 1000ms

# --- /doctor report: the measured setup checkup, no model needed ---
Type "/doctor report"
Sleep 600ms
Enter             # the first Enter accepts the subcommand completion…
Sleep 500ms
Enter             # …the second submits it
Sleep 5s
Escape
Sleep 1200ms

# --- A subagent: watch it appear in the live panel below the editor ---
Type "Use a subagent with the default model to check whether docs/guide/troubleshooting.md already covers a missing onecode command, and report back in two sentences."
Enter
Sleep 70s         # the subagent reads and reports; auto mode approves its shell — tune to your model

# --- Exit cleanly ---
Type "/exit"
Enter
Sleep 1500ms
