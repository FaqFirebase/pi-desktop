# PI Desktop

A production-ready Electron desktop application that provides a modern GUI frontend for the [PI coding agent](https://pi.dev).

![Version](https://img.shields.io/badge/version-0.0.1--alpha-orange)
![Status](https://img.shields.io/badge/status-alpha-orange)
![License](https://img.shields.io/badge/license-Apache--2.0-green)
![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey)

> **⚠ Alpha — repository currently private.** This project is in early alpha. The repository is private while we stabilize the build and distribution pipeline. The install methods, download links, and `git clone` URLs documented below describe the intended public release flow but will not resolve for the general public until the repo is made public and packages are published. Expect breaking changes between alpha releases.

## Features

- **Streaming Chat** — Real-time responses with thinking blocks and tool call visualization
- **Multi-Workspace** — Manage multiple projects, each with its own PI process and sessions
- **File Tree** — Browse project files with git status badges
- **Diff Viewer** — View working and staged git diffs
- **Terminal** — ANSI-colored terminal with bash execution
- **Package Browser** — Browse, search, and install PI packages and skills
- **Session Tags** — Tag sessions with `#hashtags` for easy organization
- **Model Selector** — Switch models and thinking levels from the UI
- **Context Menu** — Right-click to copy, paste, export, and more
- **Dark/Light Theme** — Full theme support with instant switching

## Installation

### Prerequisites

PI must be installed first:

```bash
curl -fsSL https://pi.dev/install.sh | sh
# or
npm install -g @earendil-works/pi-coding-agent
```

### Option 1: npm (Recommended) — _available after public release_

> Not yet published. Will become available once the project moves out of alpha and the package is published to npm.

```bash
npm install -g pi-desktop
pi-desktop
```

### Option 2: Quick Install Script

```bash
curl -fsSL https://raw.githubusercontent.com/FaqFirebase/pi-desktop-gui/master/install.sh | bash
```

### Option 3: Download Binaries

Download from [GitHub Releases](https://github.com/FaqFirebase/pi-desktop-gui/releases):

| Platform | Format | Download |
|----------|--------|----------|
| Linux | AppImage | `PI-Desktop-linux-x64.AppImage` |
| macOS | DMG | `PI-Desktop-mac-x64.dmg` (Intel) |
| macOS | DMG | `PI-Desktop-mac-arm64.dmg` (Apple Silicon) |
| Windows | Installer | `PI-Desktop-win-x64.exe` |
| Windows | Portable | `PI-Desktop-win-x64-portable.exe` |

#### AppImage (Linux)

```bash
chmod +x PI-Desktop-linux-x64.AppImage
./PI-Desktop-linux-x64.AppImage
```

#### macOS

1. Open the `.dmg` file
2. Drag "PI Desktop" to Applications
3. Open from Applications or Spotlight

#### Windows

1. Run the `.exe` installer
2. Follow the installation wizard
3. Launch from Start Menu or Desktop shortcut

### Option 4: Build from Source

```bash
git clone https://github.com/FaqFirebase/pi-desktop-gui.git
cd pi-desktop-gui
npm install
npm run package:linux   # or package:mac, package:win
```

The built files will be in the `release/` directory.

## Usage

```bash
# Launch with default workspace (home directory)
pi-desktop

# Launch with specific project
pi-desktop ~/my-project

# Launch with current directory
pi-desktop .
```

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` | Send message |
| `Shift+Enter` | New line |
| `Escape` | Stop streaming |
| `Ctrl+P` | Cycle model |
| `Ctrl+Shift+F` | File search |
| `Ctrl+N` | New session |
| `Ctrl+Shift+N` | New workspace |
| `Ctrl+O` | Open project |

## Development

```bash
npm install
npm run dev           # Build and launch (reliable)
npm run dev:hot       # Dev mode with hot reload
npm run build         # Build only
npm run typecheck     # Type check all packages
```

## Architecture

```
src/
├── shared/ipc-contracts.ts    # 70+ typed IPC channels
├── main/                      # Electron main process
│   ├── index.ts               # App lifecycle
│   ├── ipc-handlers.ts        # IPC handler registration
│   ├── pi-rpc-manager.ts      # PI subprocess management
│   ├── workspace-manager.ts   # Multi-workspace
│   ├── file-service.ts        # File tree, search, git
│   └── session-tags.ts        # Tag persistence
├── preload/index.ts           # Secure contextBridge API
└── renderer/                  # React UI
    └── src/
        ├── store.ts           # Zustand state management
        ├── hooks.ts           # Event subscriptions
        └── components/        # 16 React components
```

## Configuration

| File | Purpose |
|------|---------|
| `~/.pi-desktop-gui/workspaces.json` | Workspace list |
| `~/.pi-desktop-gui/settings.json` | App settings |
| `~/.pi-desktop-gui/session-tags.json` | Session tags |
| `~/.pi/agent/settings.json` | PI settings |

## License

Apache License 2.0 — see [LICENSE](LICENSE)

## Links

- [PI Coding Agent](https://pi.dev)
- [PI Documentation](https://pi.dev/docs/latest)
- [PI Packages](https://pi.dev/packages)
- [GitHub Issues](https://github.com/FaqFirebase/pi-desktop-gui/issues)
