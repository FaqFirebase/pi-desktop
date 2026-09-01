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
- Main-window navigation pinned to the packaged renderer; privileged IPC verifies the sender frame is the app renderer
- Per-workspace trust gate: an untrusted workspace's own `.pi-desktop/permission-rules.json` allow rules are ignored, and its HTML preview runs without scripts/network, until the user trusts the workspace
- Attachment reads limited to picked or in-workspace paths; session deletion confined to the Pi sessions dir; package specs validated before the Pi CLI runs

## Project Structure

Modules have colocated `*.test.ts` files; `resources/` has tests too. CI runs `npx tsx --test $(find src resources -name '*.test.ts')`.

```
src/
├── shared/                       # Code shared by main + renderer (pure, typed)
│   ├── ipc-contracts.ts          # Typed IPC channel definitions
│   ├── default-settings.ts       # Single source of truth for AppSettings defaults
│   ├── council-config.ts         # Council planning config, prompts, parsers
│   ├── models-config.ts          # Custom models.json validate/merge
│   ├── package-filter.ts         # Tokenized catalog search, shared main+renderer
│   ├── package-spec.ts           # Validate package specs before the Pi CLI runs
│   ├── path-compare.ts           # Platform-aware path equality (win32 case-fold); main+renderer
│   ├── folder-drop.ts            # Pure helpers for drag-drop folder → workspace
│   ├── untrusted-data.ts         # Wrap file/agent text as a labeled untrusted-data block
│   ├── agent-engine-label.ts     # Display names for the Pi/OMP engines (every surface reads this one map)
│   ├── pi-command.ts             # Slash-command filtering
│   ├── fork-point.ts             # Fork/branch message helpers
│   ├── session-lineage.ts        # Cross-session lineage tree
│   ├── session-preview.ts        # First user message -> one-line row label
│   ├── sidebar-width.ts          # Bounds/resolution for the user-adjustable sidebar width
│   ├── workflow-control.ts       # Control eligibility for persisted workflow runs
│   └── theme/                    # Theme-file format, resolver, syntax defaults, tokens
├── main/
│   ├── index.ts                  # App lifecycle, window creation, hardening
│   ├── ipc-handlers.ts           # IPC composition root (creates context, calls ipc/ modules)
│   ├── ipc/                      # Domain-specific IPC handler modules (pi, session, files, ...)
│   ├── app-log.ts                # Main-process log: ring buffer + JSONL file in the GUI data dir
│   ├── workspace-activity.ts     # Per-workspace activity state machine (working/approval/completed/failed)
│   ├── notify-decision.ts        # Pure should-we-notify decision (focus/active-workspace aware)
│   ├── diagnostics.ts            # Assembles the Diagnostics view's report
│   ├── diagnostics-report.ts     # Pure report helpers (provider key classification etc.)
│   ├── pi-rpc-manager.ts         # Agent subprocess management (pi or omp), startup readiness probe, descendant-tree kill
│   ├── pi-binary-resolution.ts   # Locate and identify installed pi/omp executables
│   ├── pi-paths.ts               # Per-engine session-store roots; which engine owns a session file
│   ├── session-trash.ts          # Deleted sessions go to the desktop trash (trash-cli, then gio)
│   ├── path-authorization.ts     # Path containment checks (attachment/session IPC)
│   ├── renderer-origin.ts        # Trusted-renderer URL check (navigation + IPC sender)
│   ├── workspace-trust.ts        # Per-workspace trust registry (gates allow rules + preview)
│   ├── workspace-manager.ts      # Multi-workspace management
│   ├── git-conveyor.ts           # Validated commit, push, and GitHub PR commands
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
│   ├── fs-errors.ts              # Friendly file-system error messages
│   ├── models-file.ts            # Per-engine models file (Pi models.json / OMP models.yml) resolve + parse
│   ├── omp-fork-points.ts        # Fork candidates read from an OMP session file (no get_fork_messages RPC)
│   ├── omp-plugin-list.ts        # Parse `omp plugin list --json` for the installed-packages panel
│   ├── skills-discovery.ts       # Per-engine skill roots scan + catalog merge
│   ├── session-metadata.ts       # Bounded reader: session name, header, first-message preview
│   ├── session-lineage-reader.ts # Parent links and labels across the session store
│   ├── get-messages-trim.ts      # Shrink a get_messages response before IPC
│   ├── map-concurrent.ts         # Bounded-concurrency mapper
│   ├── extension-ui-ipc.ts       # Extension-UI half of the IPC surface
│   ├── pi-event-router.ts        # Routes every runtime's Pi events to the renderer
│   ├── git-worktree.ts           # Isolated Git worktrees for New Task
│   ├── theme-store.ts            # User theme files: list, save, delete
│   ├── workflow-monitor.ts       # ~/.pi/workflows run and project discovery
│   ├── tray-manager.ts           # System-tray lifecycle (minimize to tray on close)
│   ├── tray-decision.ts          # Pure tray-availability decision
│   ├── startup-launch.ts         # Cross-platform "Run on startup"
│   ├── autostart-linux.ts        # Linux freedesktop autostart entry helpers
│   ├── editor-guard.ts           # Unsaved-editor guard for quit/close/reload
│   └── cmd-escape.ts             # cmd.exe escaping for Windows shell:true spawns
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
        ├── message-parsing.ts    # Pi messages -> display messages
        ├── message-grouping.ts   # Tool-name labels and message grouping
        ├── theme/engine.ts       # Apply a resolved theme to the document
        ├── themes/               # Built-in theme JSON files
        ├── index.css             # Tailwind + theme overrides
        ├── utils/
        │   ├── planning-prompt.ts # Plan/read-only prompt wrapper
        │   ├── ipc-error.ts      # Strip Electron's remote-method prefix from IPC errors
        │   ├── quick-switcher.ts # Token filters for the palette's workspace/session/file sections
        │   ├── rank-file-results.ts # Basename-tiered ranking for file search hits
        │   ├── session-title.ts  # Distinguishable fallback session titles
        │   ├── heatmap-grid.ts   # Weeks/intensity layout for the stats mini-heatmap
        │   ├── model-search.ts   # Tokenized model-picker search (treats -_./: as spaces)
        │   ├── theme.ts          # Theme application
        │   ├── debounced-buffer.ts # Debounced editor text buffer
        │   ├── format-relative-time.ts # Relative-time labels capped at days
        │   ├── relative-time.tsx # Shared ticking "now" for relative labels
        │   ├── stale-guard.ts    # Last-write-wins guard for overlapping loads
        │   └── workflow-runs.ts  # Session id used to scope workflow runs
        └── components/
            ├── sidebar.tsx        # Workspace switcher, nav, sessions grouped by folder, inline rename
            ├── sidebar-session-labels.ts # Session row label helpers
            ├── home-screen.tsx    # Full Home launcher (stats, recents, open folder / new session)
            ├── task-launcher.tsx  # New-task modal that starts a real background session
            ├── mission-control.tsx # Global live-session and workflow inbox
            ├── git-conveyor-actions.tsx # Explicit commit/push/PR controls for reviewed diffs
            ├── stats-panel.tsx    # Activity stats dashboard on Home
            ├── chat-panel.tsx     # Main streaming chat; empty session = center prompt + project picker
            ├── chat-project-picker.tsx # Empty-chat project / no-project picker under the composer
            ├── chat-input.tsx     # Input with #tag support
            ├── model-selector.tsx # Status-bar model picker (searchable)
            ├── subagent-progress.tsx # Compact live subagent strip on the composer
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
            ├── permission-rules-editor.tsx # Permission rules editor (Settings -> Behavior)
            ├── permission-rules-editor-helpers.ts # Permission rules editor parse/validate helpers
            ├── session-panel.tsx  # Sessions grouped by project
            ├── session-menu-position.ts # Session menu placement
            ├── timeline.tsx       # Agent activity timeline
            ├── review-rail.tsx    # Permissions, approvals, changed files (toggleable)
            ├── package-browser.tsx # Package/skill browser, fetch-once + local filter
            ├── skills-panel.tsx   # Skills browser
            ├── notes-panel.tsx    # Reusable prompts/notes
            ├── note-picker.tsx    # Insert a saved note
            ├── command-palette.tsx # Ctrl/Cmd+K quick switcher (commands, workspaces, sessions, files)
            ├── sidebar-activity.ts # Workspace activity dot mapping for the sidebar
            ├── diagnostics-panel.tsx # Diagnostics view (Pi binary, providers, permissions, log)
            ├── file-tree.tsx      # File tree + search + preview
            ├── diff-viewer.tsx    # Git diff viewer
            ├── terminal.tsx       # ANSI terminal
            ├── context-menu.tsx   # Right-click context menu, themed confirm dialog
            ├── error-boundary.tsx # Renderer error boundary
            ├── extension-ui-dialog.tsx # Extension UI protocol + AppConfirmDialog
            ├── chat-search.tsx    # Ctrl/Cmd+F find in conversation
            ├── chat-panel-widths.ts # Width math for the chat side panel
            ├── command-results.tsx # Grouped command rows (palette + inline slash popup)
            ├── composer-permission-menu.tsx # Permission-mode picker on the composer
            ├── line-numbered-code.tsx # Line-numbered highlighted code rows
            ├── resize-handle.tsx  # Drag handle reporting horizontal deltas
            ├── session-runtime-indicator.tsx # Per-session engine/status indicator
            ├── theme-editor.tsx   # Custom theme editor
            ├── theme-editor-helpers.ts # Pure theme-editor helpers
            ├── theme-gallery.tsx  # Theme gallery browser
            ├── thinking-level-selector.tsx # Thinking level picker
            ├── tool-call-icon.ts  # Icon per tool-call operation
            ├── workflow-navigator.tsx # Workflow runs navigator
            └── workspace-tabs.tsx # Live session runtime tabs
```

## Features

### Engines (Pi and OMP)

- The app runs either the standard `pi` CLI or the compatible `omp` binary from oh-my-pi. Settings → Agent Configuration picks one (auto-detect, detected install, or custom executable); `pi-binary-resolution.ts` locates and identifies installs.
- The two engines keep separate session stores: Pi under `~/.pi/agent/sessions`, OMP under `~/.omp/agent/sessions`. OMP ignores `--session-dir` for new sessions, so no shared store is forced; the session index reads both roots.
- Each session list row carries the engine that owns it (`SessionListItem.engine`, stamped from the store it was found in). Opening, forking, or resuming a session starts the engine that wrote it, not the configured default (`engineForBoundSession` in `pi-paths.ts` is the single rule).
- Tool names differ per engine (Pi ships `find`/`ls`, OMP ships `glob`), so Plan/Read-only mode derives its tool list from the session's engine, never from the configured one.
- Every surface that names the running agent (status bar, empty chat, permission prompts, Diagnostics, session tags) reads `shared/agent-engine-label.ts`; the permission extension gets the label via `PI_DESKTOP_AGENT_LABEL`. Session rows show the Pi/OMP tag only when both engines appear in one list.
- OMP specifics: protocol-v2 chunked frames are decoded with the limits the engine advertises in its ready frame; OMP starts subagents in a new process group, so shutdown walks the descendant tree before signalling; OMP's plugin verbs back the package actions.
- OMP RPC gaps the GUI bridges: OMP has no `fork`/`clone`/`get_fork_messages`/`get_commands`. Fork maps to OMP's `branch` (same entryId argument), fork candidates are read from the session file (`omp-fork-points.ts`), the Clone action is hidden under OMP, and the command catalog uses `get_available_commands` (`skills-mcp-handlers.ts`).
- Per-engine config files: Pi keeps `~/.pi/agent/models.json` (JSON); OMP 18 keeps `~/.omp/agent/models.yml` (YAML) — `models-file.ts` resolves and (de)serializes both, and keeps reading a not-yet-migrated OMP `models.json`. OMP's installed-package list comes from `omp plugin list --json` (`omp-plugin-list.ts`), not from a settings.json `packages` array. Per-engine IPC decisions read `ipc/active-engine.ts` so the active session's engine wins over the configured default.
- Session names: Pi appends `session_info` records; OMP rewrites a fixed first-line `{"type":"title"}` slot. `session-name.ts`/`session-metadata.ts` read both (session_info outranks the title slot).
- Skills are listed per engine (`skills-discovery.ts`): Pi scans `~/.pi/agent/skills`, `~/.agents/skills` and project `.pi/skills`/`.agents/skills` recursively; OMP scans `.omp`, `.claude` and `.agents` roots one level deep. Skills only the other engine can load are never shown. When the engine is running, plugin-shipped skills from its command catalog are merged in (`rpc:`-prefixed pseudo-paths render from the description).

### Workspace Management

- Mission Control summarizes all live session runtimes and workflow runs across projects; New Task launches a prompt into a dedicated background runtime
- New Task can create or reuse an isolated Git worktree (matching task metadata, explicit branches, and GitHub PR URLs are detected), and Diff Review exposes explicit Commit → Push → PR actions with upstream-aware GitHub CLI routing
- Multiple workspaces (project directories)
- Each workspace owns a file service; every live session in that project owns an independent Pi process bound to that workspace cwd and its own `--session` file
- Session navigation is immediate; Pi startup and history hydration continue in the background
- Default workspace: user's home directory
- Workspace switcher in sidebar
- Auto-creates workspace when switching to a session from a different project
- **Drag-and-drop a folder** onto the window to open it as a project (create workspace if needed, switch, show Chat) — same path as File → Open Project

### Session Management

- Sessions organized by working directory (Pi native), decoded correctly cross-platform including Windows drive-letter paths
- One independent Pi runtime per live session, including multiple sessions sharing one project directory
- Switching sessions never sends a destructive `switch_session` to the previous process; the previous turn continues in the background
- Session tabs and sidebar rows show working, approval, completed, and failed indicators
- Sessions grouped by project in the session panel
- **Session tags**: type `#tag-name` in chat to tag the current session
- Tags persisted to `~/.pi-desktop-gui/session-tags.json`
- Tags displayed in session list, filterable
- Session names read from each session's `session_info` record (Pi) or first-line `title` slot (OMP); shown in the list and as fallback a distinguishable local timestamp (not a collapsing id prefix)
- Inline rename of the active session (double-click, or right-click → Rename…) via Pi's `set_session_name` RPC; live-updates on `session_info_changed`
- Delete uses an in-app themed confirmation dialog (not the native OS dialog, which stole window focus)
- Branch/fork tree, clone, and cross-session lineage in the Timeline; one-click context compaction (status bar + status popover)

### Chat

- Streaming responses with real-time updates
- Message editing (edit & resend)
- Conversation branching
- Copy/export messages (Markdown format), per-message copy button
- File attachments (text inlined into prompt; images sent as Pi image blocks); images can also be pasted directly into the composer
- Markdown rendering with syntax highlighting; bundled Inter/JetBrains Mono variable fonts + OpenMoji color emoji so rendering doesn't depend on system fonts
- Fenced SVG documents render as a sandboxed `data:` image with a source/render toggle (browser "secure static mode" — no scripts, no external loads)
- Filenames mentioned in chat text become clickable links that open a code/image preview pane
- Tool-call results are collapsible (first line as header, expand for the rest); edit/write results fold into the call badge with an inline diff instead of a separate pill; per-message model label
- `#tag` extraction from messages

### Model & Thinking

- Model selector dropdown in status bar, with tokenized search ("sonnet 4" matches `claude-sonnet-4`)
- `Ctrl+P` to cycle models
- Thinking level selector (off/minimal/low/medium/high/xhigh, plus max when the engine offers it)
- Token usage and cost tracking in status bar

### Command Palette / Quick Switcher

- Open with `Ctrl/Cmd+K` (works with Pi stopped), or by typing `/` at the start of the composer
- One searchable list: commands plus Workspaces, Sessions, and Files sections; a leading `/` narrows to commands only
- Results grouped by source: Skills, Prompts, Commands (Pi built-ins), Extensions
- Skills/prompts/extensions insert their token (`/skill:name`, `/template`, `/cmd`) for Pi to expand; built-ins (`/compact`, `/clone`, `/new`, `/resume`, `/fork`, `/settings`) run the GUI action directly; `/clone` is offered under Pi only
- Workspace/session/file picks route through the store's guarded actions, so the streaming and dirty-editor confirms still apply

### Issue-to-PR Conveyor

- Task Launcher accepts an issue description or URL, optionally creates or reuses a local Git worktree, and sends the task to a dedicated Pi runtime. PR URLs are resolved with `gh pr view`; unrelated or ambiguous worktrees are never guessed.
- Diff Review exposes explicit Commit, Push, and PR actions; mutating Git operations never happen implicitly.
- PR creation uses GitHub CLI when available, targets the configured `upstream` remote when present, and opens the returned PR URL.

### Workspace Activity & Desktop Notifications

- Main derives aggregate per-workspace activity (working / needs approval / completed / failed) from every session runtime's Pi events — the renderer's stream state only follows the active runtime, so this ships as its own map (`workspace-activity.ts`, broadcast on `event:workspace-activity`)
- A separate session-runtime snapshot stream exposes each live session's process status, PID, activity, and active binding for per-session indicators
- Sidebar shows per-workspace dots (pulsing while working; success/error until the workspace is next viewed) alongside the existing held-prompt badges
- OS notifications (toggleable in Settings → Behavior) fire when a turn finishes, fails, or waits for approval outside the focused view; clicking one focuses the window and switches to that workspace via the renderer's guarded switch

### Diagnostics

- Sidebar → Diagnostics: Pi binary resolution (path, source, node binary, PATH), `pi --version`, per-workspace path/trust/process status, provider key classification from the engine's models file (never evaluates secrets), permission mode + rule counts, storage paths, and recent warnings/errors from the app log
- App log: `app-log.jsonl` in the GUI data dir (ring-buffered in memory, size-capped rotation) so packaged-build errors survive for the Diagnostics view

### File & Project

- File tree with git status badges (M/A/D/R/U)
- File search by name and content
- Git branch indicator
- Git diff viewer (working and staged)

### Code Editor

- CodeMirror 6-backed editor for opening and editing project files
- Theme-aware syntax highlighting via a custom `HighlightStyle` (in `code-editor-highlight.ts`) whose token colors are CSS variables. The theme resolver (`shared/theme/resolve.ts`) emits each theme's `--cm-*` palette from the theme file's `syntax` block (or `syntax-defaults.ts`), so the editor restyles when the user switches themes — no editor logic needed.
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

- **Open to Home on Launch** (Settings → Behavior): when on, boot lands on the full Home launcher (stats, changed files, recent workspaces/sessions, Open Folder / New Session). When off, boot opens Chat; an empty session uses a Codex-style **center prompt** with a **project picker** under the composer (sidebar + status chrome stay)
- Home is a single info/launcher surface — there is no separate Minimal Home layout or `homeLayout` setting
- Suggested prompt chips on empty chat **fill the composer** (ready for Enter); they do not auto-send a turn
- Recent sidebar groups sessions by project folder (platform-aware path equality)
- Compact live **subagent strip** seats on the composer while subagents run
- Range-selectable (7d–1y) stats: sessions, messages, tokens, active days, current/longest streak, peak hour, per-model input/output token usage
- Persisted per-day aggregate store (`activity-stats.ts`) survives session deletion (captured before the file is removed); only aggregate numbers are stored, never prompt/response text
- Baseline-scanned on launch (non-blocking) so stats are accurate even if Home is never opened that run
- Resuming the last session or switching workspace now loads full chat history (not just session metadata)

### File Preview Panes

- Click a workspace file link (chat or file tree) to open it in a side pane: code (CodeMirror), image, or HTML (via a sandboxed `<webview>` — no Node access, isolated partition, `file://` source only). HTML preview runs scripts and network only when the workspace is trusted; an untrusted workspace gets a static preview with a "Trust workspace" banner
- Independent from the review rail; chat toolbar toggles for sidebar, review panel, and file tree

### Packages & Skills

- Browse installed packages: Pi from `settings.json` `packages[]`; OMP from `omp plugin list --json`
- Package catalog from pi.dev — fetched once and filtered locally per keystroke (no per-keystroke re-crawl); concurrent paged crawl with a shared in-flight promise, prefetched at launch so the tab opens instantly
- Install/remove/update packages via `pi install`/`pi remove`/`pi update`; under OMP the remove and update verbs map to `omp plugin uninstall`/`omp plugin upgrade` (`run-pi-cli.ts`). Package actions run the active session's engine CLI
- Skills list with source (project/global/package/cli); see Engines for the per-engine roots
- Extension commands display

### System Status Popover

Click the status icon in the sidebar header to see:
- Pi Agent status, PID, model, provider, thinking level
- Context usage with progress bar
- Token count and cost
- Workspace info

### Settings

- Agent Configuration: engine (auto-detect / Pi / OMP) and executable path
- Theme: Dark, Light, System, Nord, Gruvbox, Breeze Dark, Breeze Light, Breeze Claudius (Breeze Dark base + deep chat surface, contributed by @sumit-m) — applies immediately. **Default is `dark`** — Breeze Claudius is opt-in only, never auto-selected for new installs
- Independent UI / Terminal / Code Editor font size sliders
- Show thinking blocks, auto-scroll
- Run on startup, Minimize to tray on close (Windows/Linux), Resume last session, desktop notifications
- Custom theme editor: create, edit, import/export, install from URL (theme files live in the GUI data dir `themes/`)
- Every field (theme, permission mode, toggles, font sizes) live-previews before Save via a unified settings draft (`store.ts` `settingsDraft`); survives view switches; Save persists, Reset restores `DEFAULT_SETTINGS`
- Permission rules: user-defined allow/deny rules (glob per Pi tool) that overlay the permission modes. Deny beats allow beats mode default; deny applies in every mode. Global rules live in `<GUI data dir>/permission-rules.json`. A workspace `.pi-desktop/permission-rules.json` is gated by workspace trust: when the workspace is trusted it fully replaces the global rules; when untrusted (the default) only its deny rules apply, layered on top of the global rules, and its allow rules are ignored (a repo can tighten, never grant). Opening a workspace whose rules file contains allow rules shows a trust prompt; the editor's Global tab notes the override and the This workspace tab carries a Trust/Revoke control. Settings → Behavior edits BOTH scopes via Global | This workspace tabs: create, edit, and remove workspace rules (in-app danger confirm), Copy from global (seeds an unsaved draft from the current global list), and per-scope JSON import/export. Manual editing of either file on disk remains fully supported — switching scope tabs re-reads that file when the scope has no unsaved draft, so hand-edited rules show up without a restart. Engine: `resources/permission-rules.ts`, shared by the Pi extension (jiti relative import, mtime-cached live re-read) and the main process. The permissions extension always loads alongside Pi when present on disk, regardless of mode or whether rules currently exist, so a rules file created mid-session is enforced immediately rather than after a restart.
  - Trust posture: a workspace's `.pi-desktop/permission-rules.json` is repo content, so its allow rules take effect only after the user explicitly trusts the workspace (persisted in `trusted-workspaces.json`; surfaced as a trust prompt on open and a control in Settings). Until trusted, the repo can only add deny rules — it cannot suppress ask-mode prompts. Rule globs match raw tool input strings only (no path canonicalization, no command parsing), so rules are a guardrail against accidents, not a security sandbox.
- Custom models & providers editor — edits the active engine's models file: `~/.pi/agent/models.json` (Pi) or `~/.omp/agent/models.yml` (OMP; a not-yet-migrated `models.json` is kept until OMP migrates it). Main reports the resolved file so the editor labels always match; applied on engine restart
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

- 139 IPC channels, all validated (count drifts as features land — check `IPC_CHANNELS` in `src/shared/ipc-contracts.ts` for the current number rather than trusting this doc)
- Pi events forwarded from main to renderer via `webContents.send`
- Extension UI protocol supported (select, confirm, input, editor dialogs)

## Data Storage

Paths below show the legacy home-dir location for brevity; since the canonical
data-dir migration the GUI's files live under the OS app-data dir
(`<appData>/pi-desktop`, overridable via `PI_DESKTOP_USER_DATA_DIR`), with
`~/.pi-desktop-gui` kept as the legacy fallback.

| Path | Purpose |
|------|---------|
| `~/.pi-desktop-gui/workspaces.json` | Workspace list and active workspace |
| `~/.pi-desktop-gui/settings.json` | App settings |
| `~/.pi-desktop-gui/session-tags.json` | Session tags |
| `~/.pi-desktop-gui/trusted-workspaces.json` | Workspaces the user has trusted (enables their allow rules + interactive HTML preview) |
| `~/.pi-desktop-gui/activity-stats.json` | Persisted per-day activity stats (aggregates only, survives session deletion) |
| `~/.pi-desktop-gui/app-log.jsonl` | Main-process app log (warnings/errors for the Diagnostics view) |
| `~/.pi-desktop-gui/notes.json` | Reusable prompts/notes |
| `~/.pi-desktop-gui/archived-sessions.json` | Archived sessions |
| `~/.pi-desktop-gui/session-auto-tags.json` | Machine-derived session tags |
| `~/.pi-desktop-gui/permission-rules.json` | Global permission rules |
| `~/.pi-desktop-gui/themes/` | User theme files |
| `~/.pi/agent/sessions/` | Pi session files (organized by cwd) |
| `~/.omp/agent/sessions/` | OMP session files (same layout; OMP writes here regardless of flags) |
| `~/.pi/agent/settings.json` | Pi global settings (installed `packages[]`) |
| `.pi/settings.json` | Pi project settings |
| `~/.pi/agent/models.json` | Pi custom models/providers |
| `~/.omp/agent/models.yml` | OMP custom models/providers (OMP has no settings.json; its settings live in `config.yml`, which the GUI does not read) |
| `~/.omp/plugins/` | OMP plugin store (listed via `omp plugin list --json`) |
| `~/.omp/agent/mcp.json` | OMP MCP servers (read for the status popover) |
| `~/.pi/workflows/` | Workflow runs and projects (Mission Control) |

## Distribution

Pi Desktop is shipped as pre-built binaries — not via npm. Agents must not attempt `npm publish`.

| Platform | Format | Notes |
|----------|--------|-------|
| Linux | AppImage | Primary supported target |
| Windows | Installer (`-setup.exe`) + portable `.exe` | Community-tested |
| macOS | `.dmg` + `.zip` (arm64) | Built via `package:mac`; unsigned/un-notarized |

Artifacts are built with `electron-builder` and published to GitHub Releases. Artifact naming: `Pi-Desktop-{version}-{os}-{arch}.{ext}`.

Release artifacts are built per OS in GitHub Actions. Local cross-builds from Linux require Wine (Windows portable only); a local macOS build requires a Mac.

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

The agent runs in RPC mode as a subprocess; one `PiRpcManager` is retained for each live session runtime. The binary is `pi` or `omp` depending on the session's engine (see Engines above):

```
pi --mode rpc [--session <session-file>] [--provider <name>] [--model <id>] [--no-session]
```

No `--session-dir` is injected; each engine uses its own default store. A caller-supplied `--session-dir` in extra args still wins.

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
