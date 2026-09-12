# Install One Code

[← One Code user guide](README.md)

One Code ships as two npm packages from one repository. Choose the one that
fits how you already work.

| You | Install | What you get |
|---|---|---|
| New to this, or you want the simplest setup | `npm install -g @one-ai/one-code` | The bundled app: its own `onecode` command, a pinned version of the pi coding agent inside it, and its state kept in `~/.onecode`. It coexists with any `pi` you already have. |
| Already running [pi](https://github.com/earendil-works/pi) | `pi install npm:one-code-extension` | The extensions only. They run on your existing pi. One Code's own state still goes to `~/.onecode`; pi's own files stay under your pi agent directory (`~/.pi/agent`). |

## Requirements

- Node.js 22.19 or later. The app refuses to start on older versions,
  because pi crashes at import time there.
- macOS or Linux. Windows Subsystem for Linux (WSL) works the same way.
  Native Windows is untested and unsupported.
- `git`. Optional: `rg` (ripgrep) for faster search, the GitHub CLI for the
  pull-request marker in the footer, and a language server for your
  language (see
  [Language-server diagnostics](configuration.md#language-server-diagnostics)).

## Install the app with npm

```bash
npm install -g @one-ai/one-code
cd your-project
onecode
```

On the first run there's no provider yet: the banner shows `model none`.
Run `/login` inside One Code to connect a provider, or set a provider key
in your environment before launching. For a free option, see
[Providers and models](providers-and-models.md).

The first run also seeds pi's settings under `~/.onecode/agent/` with the
`onecode` theme, quiet startup, and full-screen mode. It never overrides a
value you change later.

## Install with Homebrew

Homebrew installs Node for you, so this route has no separate Node step:

```bash
brew install isurumaduranga/one-ai/onecode
```

The formula and the command it installs are both named `onecode`.
Homebrew refuses npm packages published less than a day ago, so a release
becomes installable this way about a day after it appears on npm.

## Install the extension on your own pi

If you already run pi, add One Code as an extension:

```bash
pi install npm:one-code-extension
```

Use `pi` in place of `onecode` for every command in this guide. The
extension is tested against pi 0.83 through 0.85 and warns at startup when
your pi is outside that range. Full-screen mode is opt-in on your own pi;
see [Full-screen mode and themes](configuration.md#full-screen-mode-and-themes).

A few interface refinements are applied only by the bundled app, because
they patch pi internals the extension API can't reach: a clean exit that
erases the screen in regular mode, and suppression of pi's "Operation
aborted" line when you interrupt a reply. Everything else is identical.

## Install from source

```bash
git clone https://github.com/IsuruMaduranga/one-code
cd one-code
npm install
cd ..
pi install ./one-code
pi list
```

Run `npm install` before the path install so the dependencies are present.
`pi list` confirms the package registered.

## Check the installation

```bash
onecode --version    # prints the app version and the pi version inside it
onecode doctor       # prints the setup report; exits 1 when no provider is ready
```

Inside a session, `/doctor` runs the full checkup. See
[Check your setup with doctor](doctor.md).

## Update

The bundled app checks npm once a day when a session starts and shows a
notice with the matching upgrade command when a newer version exists:

```bash
npm install -g @one-ai/one-code      # npm installs
brew upgrade onecode                 # Homebrew installs
```

Set `ONECODE_NO_UPDATE_CHECK=1` to skip the check; `--offline` skips it too.
On your own pi, update with `pi update --extensions`.

Both packages are released together with the same version number.

## Uninstall

```bash
npm uninstall -g @one-ai/one-code    # or: brew uninstall onecode
rm -rf ~/.onecode                    # One Code's state, including pi's under the app
```

On your own pi, run `pi remove one-code-extension` (or remove the package
entry from pi's settings). Removing `~/.onecode` deletes One Code's
settings, approvals, plan files, and, under the bundled app, pi's sessions
and credentials. Memory files stay in `~/.claude/projects/`, because they
are shared with Claude Code.

## Next step

Connect a provider and choose a model in
[Providers and models](providers-and-models.md).
