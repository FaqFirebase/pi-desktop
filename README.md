# PI Desktop

A desktop app for the [PI coding agent](https://pi.dev). Chat with PI, manage multiple projects, browse files, run commands, and install packages — all without touching the terminal.

> **Alpha — repo is private for now.** Things will break between releases. Install links won't work until the repo goes public.

## What's in it

- Streaming chat with thinking blocks and tool call visualization
- Multiple workspaces — each project gets its own PI process and session history
- File tree with git status, diff viewer, and file search
- Built-in terminal with ANSI color support
- Package browser — search and install PI packages from pi.dev/packages
- Session tags with `#hashtags`
- Model and thinking level switching from the UI
- Themes: Dark, Light, Nord, Gruvbox, System

## Install

First, make sure PI is installed:

```bash
npm install -g @earendil-works/pi-coding-agent
```

Then grab PI Desktop. On Linux, download the AppImage from [Releases](https://github.com/FaqFirebase/pi-desktop-gui/releases), make it executable, and run it:

```bash
chmod +x PI-Desktop-linux-x64.AppImage
./PI-Desktop-linux-x64.AppImage
```

macOS and Windows builds are coming — not shipping yet.

## Build from source

```bash
git clone https://github.com/FaqFirebase/pi-desktop-gui.git
cd pi-desktop-gui
npm install
npm run dev
```

To build a distributable:

```bash
npm run package:linux   # AppImage
```

## Development

```bash
npm run dev           # Build and launch
npm run dev:hot       # Hot reload (may have a race condition on first load)
npm run typecheck     # Type check
```

## Keyboard shortcuts

| Shortcut | What it does |
|----------|-------------|
| `Enter` | Send message |
| `Shift+Enter` | New line |
| `Escape` | Stop streaming |
| `Ctrl+P` | Cycle model |
| `Ctrl+Shift+F` | File search |
| `Ctrl+N` | New session |
| `Ctrl+Shift+N` | New workspace |
| `Ctrl+O` | Open project |

## Config files

Everything lives in `~/.pi-desktop-gui/`:

- `workspaces.json` — your workspace list
- `settings.json` — theme, font size, etc.
- `session-tags.json` — session tags

PI's own config stays in `~/.pi/agent/settings.json`.

## License

Apache 2.0 — see [LICENSE](LICENSE)

## Links

- [PI Coding Agent](https://pi.dev)
- [PI Docs](https://pi.dev/docs/latest)
- [PI Packages](https://pi.dev/packages)
- [Issues](https://github.com/FaqFirebase/pi-desktop-gui/issues)
