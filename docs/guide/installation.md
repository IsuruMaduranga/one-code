# Install One Code

One Code ships as two npm packages from one repository. Choose the one that fits
how you already work.

| You | Install | What you get |
|---|---|---|
| New to this, or you want the simplest setup | `npm install -g @one-ai/one-code` | The bundled app: its own `onecode` command, a pinned version of the pi coding agent inside it, and its state kept in `~/.onecode`. It coexists with any `pi` you already have. |
| Already running [pi](https://github.com/earendil-works/pi) | `pi install npm:one-code-extension` | The extensions only. They run on your existing pi. One Code's own state (settings, plans, trust stores) still goes to `~/.onecode`; pi's own files and plugin state stay under your pi agent directory (`~/.pi/agent`). |

## Requirements

- Node.js 22.19 or later for the npm install.
- macOS or Linux. Windows Subsystem for Linux (WSL) works the same way. Native
  Windows is untested; do not rely on it yet.

## Install the app with npm

```bash
npm install -g @one-ai/one-code
cd your-project
onecode
```

On the first run there is no provider yet: the banner shows `model none`. Run
`/login` inside One Code to connect a provider and paste (or OAuth) a key, or
set a provider key in your environment before launching. For a free option, see
[Providers and models](providers-and-models.md).

## Install with Homebrew

Homebrew installs Node for you, so this route has no separate Node step:

```bash
brew install isurumaduranga/one-ai/one-code
```

To tap once and then install (the formula is `one-code`; the command it installs is `onecode`):

```bash
brew tap isurumaduranga/one-ai
brew install one-code
```

## Install the extension on your own pi

If you already run pi, add One Code as an extension:

```bash
pi install npm:one-code-extension
```

The extension is tested against pi 0.83, 0.84 and 0.85. It warns if your pi
falls outside that range.

## Install from source

```bash
git clone https://github.com/IsuruMaduranga/one-code
cd onecode
npm install
cd ..
pi install ./one-code
pi list
```

Run `npm install` before the path install so the dependencies are present.
`pi list` confirms the package registered.

## Full-screen mode

The `onecode` app opens in a full-screen terminal interface by default. It uses
the alternate screen and restores your terminal when you exit.

On your own pi, full-screen mode is opt-in. Turn it on in one of two ways:

- Set `"tuiMode": "fullscreen"` in `~/.pi/agent/settings.json`.
- Launch with `pi --tui-mode fullscreen`.

## Next step

Connect a provider and choose a model in
[Providers and models](providers-and-models.md).
