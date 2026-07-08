# Pi Desktop

An Electron desktop application that acts as a GUI frontend for the Pi coding agent. Currently in alpha; see the Version section below.

## Version

Project is currently in **Alpha**. APIs, IPC contracts, on-disk config formats, and packaged-app behavior may all change without notice. Do not rely on anything as stable.

- Never refer to alpha releases as production-ready
- Breaking changes are acceptable before 1.0.0
- Preserve forward migration paths whenever practical

## Architecture

### Stack

- **Electron** — Desktop shell with secure IPC
- **React 19** — UI framework
- **TypeScript** — Full type safety
- **Vite** — Build tooling via electron-vite
- **TailwindCSS v4** — Styling
- **Zustand** — State management
- **Pi RPC Mode** — JSONL-based subprocess communication

### Security

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- All IPC channels validated with typed contracts
- No renderer access to Node APIs

## Project Structure

Modules have colocated `*.test.ts` files (run with `npx tsx --test`).

```
src/
├── shared/                       # Code shared by main + renderer (pure, typed)
│   ├── ipc-contracts.ts          # Typed IPC channel definitions
│   ├── default-settings.ts       # Single source of truth for AppSettings defaults
│   ├── council-config.ts         # Council planning config, prompts, parsers
│   ├── models-config.ts          # Custom models.json validate/merge
│   ├── package-filter.ts         # Tokenized catalog search, shared main+renderer
│   ├── pi-command.ts             # Slash-command filtering
│   ├── fork-point.ts             # Fork/branch message helpers
│   └── session-lineage.ts        # Cross-session lineage tree
├── main/
│   ├── index.ts                  # App lifecycle, window creation, hardening
│   ├── ipc-handlers.ts           # IPC handler registration
│   ├── pi-rpc-manager.ts         # Pi subprocess management, startup readiness probe
│   ├── pi-paths.ts               # Shared Pi session-store root path
│   ├── workspace-manager.ts      # Multi-workspace management
│   ├── file-service.ts           # File tree, search, git status, read/write
│   ├── terminal-service.ts       # node-pty PTY management
│   ├── agent-detection.ts        # Detect claude/codex/pi CLIs (council)
│   ├── council-manager.ts        # Council consultant fan-out + streaming
│   ├── notes-manager.ts          # Reusable prompts/notes persistence
│   ├── session-tags.ts           # Session tag persistence
│   ├── session-paths.ts          # Session dir <-> real path (de)sanitization, Windows-safe
│   ├── session-name.ts           # Read a session's display name from its .jsonl
│   ├── activity-stats.ts         # Persisted per-day message/token/model stats store
│   ├── package-catalog.ts        # pi.dev catalog crawl, concurrent + prefetched + cached
│   ├── auto-tag.ts               # Machine-derived session tags
│   ├── archived-sessions.ts      # Archived session persistence
│   ├── app-data-paths.ts         # Resolve app data directories
│   ├── attachment-reader.ts      # Read chat attachments (image base64 / text)
│   └── fs-errors.ts              # Friendly file-system error messages
├── preload/
│   └── index.ts                  # contextBridge API
└── renderer/
    ├── index.html                # Entry HTML with CSP
    └── src/
        ├── main.tsx              # React root
        ├── app.tsx               # App shell with view routing
        ├── store.ts              # Zustand state management
        ├── hooks.ts              # Event subscriptions, lifecycle
        ├── global.d.ts           # Renderer ambient types
        ├── index.css             # Tailwind + theme overrides
        ├── utils/
        │   ├── planning-prompt.ts # Plan/read-only prompt wrapper
        │   ├── session-title.ts  # Distinguishable fallback session titles
        │   ├── heatmap-grid.ts   # Weeks/intensity layout for the stats mini-heatmap
        │   └── theme.ts          # Theme application
        └── components/
            ├── sidebar.tsx        # Workspace switcher, nav, sessions, inline rename
            ├── sidebar-session-labels.ts # Session row label helpers
            ├── home-screen.tsx    # Home/launcher screen
            ├── stats-panel.tsx    # Persistent activity-stats dashboard (Home)
            ├── chat-panel.tsx     # Main streaming chat
            ├── chat-input.tsx     # Input with #tag support
            ├── chat-code-highlight.ts # Fenced-code syntax highlighting -> HTML
            ├── chat-file-link.ts  # Detect/classify filenames mentioned in chat text
            ├── copy-button.tsx    # Shared copy-to-clipboard button
            ├── image-viewer.tsx   # Read-only image preview pane
            ├── council-panels.tsx # Council planning live cards + gate
            ├── message-bubble.tsx # Messages with edit/branch/copy
            ├── streaming-bubble.tsx # Live streaming indicator
            ├── markdown-renderer.tsx # Markdown + syntax highlight
            ├── code-editor.tsx    # CodeMirror 6 editor
            ├── code-editor-language.ts   # Language detection
            ├── code-editor-highlight.ts  # Theme-aware highlight style
            ├── status-bar.tsx     # Model selector, thinking, stats
            ├── status-popover.tsx # System status popup
            ├── settings-panel.tsx # Theme, font, behavior, council settings (live-preview draft)
            ├── custom-models-editor.tsx # Custom models/providers editor
            ├── permission-selector.tsx # Permission mode selector
            ├── permission-mode.ts # Permission mode helpers
            ├── session-panel.tsx  # Sessions grouped by project
            ├── session-menu-position.ts # Session menu placement
            ├── timeline.tsx       # Agent activity timeline
            ├── review-rail.tsx    # Permissions, approvals, changed files (toggleable)
            ├── package-browser.tsx # Package/skill browser, fetch-once + local filter
            ├── skills-panel.tsx   # Skills browser
            ├── notes-panel.tsx    # Reusable prompts/notes
            ├── note-picker.tsx    # Insert a saved note
            ├── command-palette.tsx # Ctrl/Cmd+K command palette
            ├── file-tree.tsx      # File tree + search + preview
            ├── diff-viewer.tsx    # Git diff viewer
            ├── terminal.tsx       # ANSI terminal
            ├── context-menu.tsx   # Right-click context menu, themed confirm dialog
            ├── error-boundary.tsx # Renderer error boundary
            └── extension-ui-dialog.tsx # Extension UI protocol + AppConfirmDialog
```

## Features

### Workspace Management

- Multiple workspaces (project directories)
- Each workspace has its own Pi process, sessions, and file service
- Default workspace: user's home directory
- Workspace switcher in sidebar
- Auto-creates workspace when switching to a session from a different project

### Session Management

- Sessions organized by working directory (Pi native), decoded correctly cross-platform including Windows drive-letter paths
- Sessions grouped by project in the session panel
- **Session tags**: type `#tag-name` in chat to tag the current session
- Tags persisted to `~/.pi-desktop-gui/session-tags.json`
- Tags displayed in session list, filterable
- Session names read from each session's `session_info` record; shown in the list and as fallback a distinguishable local timestamp (not a collapsing id prefix)
- Inline rename of the active session (double-click, or right-click → Rename…) via Pi's `set_session_name` RPC; live-updates on `session_info_changed`
- Delete uses an in-app themed confirmation dialog (not the native OS dialog, which stole window focus)
- Branch/fork tree, clone, and cross-session lineage in the Timeline; one-click context compaction (status bar + status popover)

### Chat

- Streaming responses with real-time updates
- Message editing (edit & resend)
- Conversation branching
- Copy/export messages (Markdown format), per-message copy button
- File attachments (text inlined into prompt; images sent as Pi image blocks)
- Markdown rendering with syntax highlighting; bundled Inter/JetBrains Mono variable fonts + OpenMoji color emoji so rendering doesn't depend on system fonts
- Fenced SVG documents render as a sandboxed `data:` image with a source/render toggle (browser "secure static mode" — no scripts, no external loads)
- Filenames mentioned in chat text become clickable links that open a code/image preview pane
- Tool-call results are collapsible (first line as header, expand for the rest); per-message model label
- `#tag` extraction from messages

### Model & Thinking

- Model selector dropdown in status bar
- `Ctrl+P` to cycle models
- Thinking level selector (off/minimal/low/medium/high/xhigh)
- Token usage and cost tracking in status bar

### Command Palette

- Open with `Ctrl/Cmd+K`, or by typing `/` at the start of the composer
- Results grouped by source: Skills, Prompts, Commands (Pi built-ins), Extensions
- Skills/prompts/extensions insert their token (`/skill:name`, `/template`, `/cmd`) for Pi to expand; built-ins (`/compact`, `/clone`, `/new`, `/resume`, `/fork`, `/settings`) run the GUI action directly

### File & Project

- File tree with git status badges (M/A/D/R/U)
- File search by name and content
- Git branch indicator
- Git diff viewer (working and staged)

### Code Editor

- CodeMirror 6-backed editor for opening and editing project files
- Theme-aware syntax highlighting via a custom `HighlightStyle` (in `code-editor-highlight.ts`) whose token colors are CSS variables. Each app theme (see Settings) defines its own `--cm-*` palette in `index.css`, so the editor restyles when the user switches themes — no editor logic needed.
- 15+ languages: JS/TS/JSX/TSX, JSON, Markdown, HTML, CSS/SCSS/Less, Python, Rust, Go, Java, PHP, XML/SVG, SQL, YAML, C/C++/C#
- Save/Revert/Close controls with dirty-state tracking and 2s "saved" feedback
- Debounced onChange (150ms) and race-safe file switching
- Saves validated in the main process via `path.relative()` to enforce workspace boundaries

### Terminal

- Real PTY via `node-pty` in the main process, `@xterm/xterm` in the renderer
- Full ANSI/VT100 support including 256-color and true-color
- Runs the user's shell directly — independent of the Pi process
- PTY managed by `terminal-service.ts`; IPC channels relay input/output/resize

### Home / Activity Dashboard

- Range-selectable (7d–1y) stats: sessions, messages, tokens, active days, current/longest streak, peak hour, per-model input/output token usage
- Persisted per-day aggregate store (`activity-stats.ts`) survives session deletion (captured before the file is removed); only aggregate numbers are stored, never prompt/response text
- Baseline-scanned on launch (non-blocking) so stats are accurate even if Home is never opened that run
- Resuming the last session or switching workspace now loads full chat history (not just session metadata)

### File Preview Panes

- Click a workspace file link (chat or file tree) to open it in a side pane: code (CodeMirror), image, or HTML (via a sandboxed `<webview>` — no Node access, isolated partition, `file://` source only)
- Independent from the review rail; chat toolbar toggles for sidebar, review panel, and file tree

### Packages & Skills

- Browse installed packages from Pi settings
- Package catalog from pi.dev — fetched once and filtered locally per keystroke (no per-keystroke re-crawl); concurrent paged crawl with a shared in-flight promise, prefetched at launch so the tab opens instantly
- Install/remove packages via `pi install`/`pi remove`
- Skills list with source (global/project)
- Extension commands display

### System Status Popover

Click the status icon in the sidebar header to see:
- Pi Agent status, PID, model, provider, thinking level
- Context usage with progress bar
- Token count and cost
- Workspace info
- Extensions
- Skills
- MCP Servers
- Prompt Templates

### Settings

- Pi executable path
- Theme: Dark, Light, System, Nord, Gruvbox, Breeze Dark, Breeze Light, Breeze Claudius (Breeze Dark base + deep chat surface, contributed by @sumit-m) — applies immediately. **Default is `dark`** — Breeze Claudius is opt-in only, never auto-selected for new installs
- Independent UI / Terminal / Code Editor font size sliders
- Show thinking blocks, auto-scroll
- Every field (theme, permission mode, toggles, font sizes) live-previews before Save via a unified settings draft (`store.ts` `settingsDraft`); survives view switches; Save persists, Reset restores `DEFAULT_SETTINGS`
- Custom models & providers editor — edits `~/.pi/agent/models.json` (applied on Pi restart)
- All settings persisted to `~/.pi-desktop-gui/settings.json`; defaults come from the single shared `src/shared/default-settings.ts` (used to seed the file AND for the renderer's initial/Reset values)

### Context Menu

Right-click anywhere for:
- Copy, Cut, Paste, Select All
- Message-specific: Copy Message, Export
- Code blocks: Copy Code Block, Search Selection
- Links: Open Link, Copy Link

## IPC Architecture

All communication between renderer and main goes through a typed preload bridge:

```
Renderer → preload (contextBridge) → IPC → main handlers → Pi RPC / File system
```

- 100 IPC channels, all validated (count drifts as features land — check `IPC_CHANNELS` in `src/shared/ipc-contracts.ts` for the current number rather than trusting this doc)
- Pi events forwarded from main to renderer via `webContents.send`
- Extension UI protocol supported (select, confirm, input, editor dialogs)

## Data Storage

| Path | Purpose |
|------|---------|
| `~/.pi-desktop-gui/workspaces.json` | Workspace list and active workspace |
| `~/.pi-desktop-gui/settings.json` | App settings |
| `~/.pi-desktop-gui/session-tags.json` | Session tags |
| `~/.pi-desktop-gui/activity-stats.json` | Persisted per-day activity stats (aggregates only, survives session deletion) |
| `~/.pi/agent/sessions/` | Pi session files (organized by cwd) |
| `~/.pi/agent/settings.json` | Pi global settings |
| `.pi/settings.json` | Pi project settings |

## Distribution

Pi Desktop is shipped as pre-built binaries — not via npm. Agents must not attempt `npm publish`.

| Platform | Format | Notes |
|----------|--------|-------|
| Linux | AppImage | Primary supported target |
| Windows | Installer (`-setup.exe`) + portable `.exe` | Community-tested |
| macOS | `.dmg` + `.zip` (arm64) | Built via `package:mac`; unsigned/un-notarized |

Artifacts are built with `electron-builder` and published to GitHub Releases. Artifact naming: `Pi-Desktop-{version}-{os}-{arch}.{ext}`.

Cross-builds from Linux require Wine (Windows portable only). macOS builds require a Mac.

Distribution is via pre-built binaries only — never `npm publish`. The `bin/pi-desktop.js` entry and `install.sh` are launch/install helpers, not an npm package surface.

## Development

```bash
npm install           # Install dependencies
npm run dev           # Build and launch (reliable)
npm run dev:hot       # Dev mode with hot reload (may have race condition)
npm run build         # Build only
npm run preview       # Launch built app
npm run package       # Create installer
```

## Pi Integration

Pi runs in RPC mode as a subprocess:

```
pi --mode rpc [--provider <name>] [--model <id>] [--no-session]
```

Communication via JSONL over stdin/stdout:
- Commands sent to stdin (one JSON object per line)
- Events streamed from stdout (one JSON object per line)
- Request/response correlation via `id` field
- Extension UI protocol for interactive dialogs

## Versioning

Starting at `0.0.1-alpha`. Follow semantic versioning with prerelease tags:
- `0.0.x-alpha` — Alpha (current). Expect breakage in any release.
- `0.0.x-beta` — Beta. Feature-complete for the release scope; bugs expected.
- `0.0.x` — Stable patch on the 0.x track.
- `0.x.0` — Feature additions.
- `x.0.0` — Stable major release.

## Final Delivery Checklist

Before delivering a change:

1. Read the relevant existing code first
2. Reuse existing patterns and utilities
3. Implement the full solution (no placeholders or partial work)
4. Add or update tests (`npx tsx --test`)
5. Remove dead code
6. Ensure consistency (naming, API shape, structure)
7. Run `npm run typecheck`, `npm run lint`, and `npm run build`
8. Update `MEMORY.md` when the work introduces decisions or known issues worth recording (it is a long-lived log, not a per-change requirement)
