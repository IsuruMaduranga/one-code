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
# step, adjust the `Down` count to land on your funded provider's entry — the
# same model name can appear under several providers, so the position varies.

Output demo/onecode.gif
# For a higher-quality player instead of a GIF, comment the line above and use:
# Output demo/onecode.mp4

Set Shell "bash"
Set FontSize 18
Set Width 1560
Set Height 860
Set Padding 24
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
Sleep 4s          # let the banner and UI render

# --- Cycle to auto mode: One Code approves safe, git-recoverable work itself ---
# manual -> accept edits -> plan -> auto
Ctrl+q
Sleep 500ms
Ctrl+q
Sleep 500ms
Ctrl+q
Sleep 1500ms

# --- Show the model catalog: any provider, switched mid-session ---
Type "/model"
Enter
Sleep 2500ms
Type "luna"       # type to filter — the catalog spans every configured provider
Sleep 1800ms
Down              # arrow to your funded provider's entry (tune the count)
Sleep 600ms
Enter
Sleep 2500ms

# --- Give it a real task on One Code's own source ---
Type "Add a short Troubleshooting section to app/README.md: if the onecode command isn't found after installing, make sure your npm global bin directory is on your PATH."
Enter
Sleep 24s         # let the agent read, edit, and verify — tune to your model

# --- Hold on the result ---
Sleep 3s

# --- Exit cleanly ---
Type "/exit"
Enter
Sleep 1500ms
