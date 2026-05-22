# PI Desktop

A desktop GUI for the [PI coding agent](https://pi.dev). Chat, manage projects, browse files, run commands, install packages — all in one window.

Still in alpha — expect rough edges.

## What it does

- Streaming chat with thinking blocks and tool use
- Multiple workspaces, each with its own PI process and sessions
- Review rail with permissions, approvals, changed files, and session status
- File tree, diff viewer, file search
- Terminal with ANSI colors
- Package browser connected to pi.dev/packages
- Session tags, model switching, themes (Dark, Light, Nord, Gruvbox)

## Review rail

The right-side Review rail keeps safety and working-tree state visible while you chat with PI.

Changed files use readable status badges:

| Badge | Meaning |
|-------|---------|
| `NEW` | Untracked new file |
| `MOD` | Existing tracked file was modified |
| `DEL` | Tracked file was deleted |
| `ADD` | New file staged in git |
| `STG` | Modified file staged in git |
| `REN` | File was renamed |

## Getting started

You need PI installed first:

```bash
npm install -g @earendil-works/pi-coding-agent
```

On Linux, grab the AppImage from [Releases](https://github.com/FaqFirebase/pi-desktop/releases):

```bash
chmod +x PI-Desktop-linux-x64.AppImage
./PI-Desktop-linux-x64.AppImage
```

macOS and Windows aren't shipping yet.

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

## Build it yourself

```bash
git clone https://github.com/FaqFirebase/pi-desktop.git
cd pi-desktop
npm install
npm run dev
```

## License

Apache 2.0

## Links

- [pi.dev](https://pi.dev)
- [Packages](https://pi.dev/packages)
- [Issues](https://github.com/FaqFirebase/pi-desktop/issues)
