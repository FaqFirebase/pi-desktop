# Pi Desktop

An Electron desktop application that is a GUI for the Pi coding agent. It also runs OMP (oh-my-pi). The project is in alpha; see Version below.

## Version

The project is in **alpha**. APIs, IPC contracts, on-disk config formats, and packaged-app behavior can change without notice. Do not treat anything as stable.

- Never call an alpha release production-ready
- Breaking changes are acceptable before 1.0.0
- Keep forward migration paths when practical

## Architecture

### Stack

- **Electron 43**: desktop shell with secure IPC
- **React 19**: UI framework
- **TypeScript**: strict typing throughout
- **Vite**: build tooling through electron-vite
- **Tailwind CSS v4**: styling
- **Zustand**: state management
- **Pi RPC mode**: JSONL over the agent subprocess's stdin/stdout

### Security

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- All IPC channels use typed contracts and validate their payloads
- The renderer has no access to Node APIs
- Main-window navigation is pinned to the packaged renderer; privileged IPC checks that the sender frame is the app renderer
- Per-workspace trust gate: until the user trusts a workspace, the allow rules in its own `.pi-desktop/permission-rules.json` are ignored and its HTML preview runs without scripts or network
- Attachment reads are limited to picked or in-workspace paths; session deletion is confined to the session stores; package specs are validated before the Pi CLI runs

### Interface text

- One i18next default instance per process (`src/shared/i18n`), starting in English; language files live in `resources/locales/<code>/translation.json`
- Components call `useTranslation()` from `react-i18next`; other code imports `t` from `src/shared/i18n`. Text is built when called, never stored translated at module load
- Logs, `appLog.*`, and the diagnostics report use `tEnglish` (also from `src/shared/i18n`) instead of `t`, so they stay in English whatever the interface language
- Product names ("Pi Desktop", "Pi", "OMP") are never translation keys. They come from `agentEngineLabel()`, `councilAgentLabel()`, or a named constant
- `npm run lint` runs `i18next-cli lint` and `i18next-cli extract --ci --dry-run`, so hard-coded text and stale keys fail CI
- Code never decides behavior from a translated display string. It reads the underlying values (failure codes, `kind`/`ToolKind` enums, error types) instead
- `t` from `useTranslation()` changes identity on every language switch. List it in the deps of a `useMemo`/`useCallback` that builds text, but never in the deps of a `useEffect` that does I/O or resets state (a re-run once discarded unsaved editor edits). Keep the outcome as data and translate it at render (`utils/preview-load-error.ts`)
- `i18next-cli extract` finds keys only in `t('literal.key')` calls on an identifier named `t`, or through a key map declared in the same file. A translator passed to a helper must be a parameter named `t`. A key map imported from another file is invisible to the extractor, and `removeUnusedKeys` deletes its keys. Share labels through a helper that calls `t` directly (`utils/process-status-label.ts`)

## Project structure

Modules have colocated `*.test.ts` files, and `resources/` has tests too. CI runs `npx tsx --test $(find src resources -name '*.test.ts')`.

```
src/
├── shared/                       # Code shared by main + renderer (pure, typed)
│   ├── ipc-contracts.ts          # Typed IPC channel definitions
│   ├── default-settings.ts       # Single source of truth for AppSettings defaults
│   ├── app-settings.ts           # Merge a settings file over the defaults; replace unknown enum values
│   ├── keyboard-shortcuts.ts     # Configurable shortcut actions, defaults, matching, conflict checks
│   ├── permission-mode.ts        # Permission modes in UI order
│   ├── council-config.ts         # Council planning config, prompts, parsers
│   ├── models-config.ts          # Custom models.json validate/merge
│   ├── package-filter.ts         # Tokenized catalog search, shared main+renderer
│   ├── package-spec.ts           # Validate package specs before the Pi CLI runs
│   ├── version-compare.ts        # x.y.z-prerelease ordering (app and package update checks)
│   ├── path-compare.ts           # Platform-aware path equality (win32 case-fold); main+renderer
│   ├── folder-drop.ts            # Pure helpers for drag-drop folder -> workspace
│   ├── attachment-rules.ts       # Rules for picked and dropped chat attachments
│   ├── git-diff.ts               # Diff splitting and repository-root -> workspace path helpers
│   ├── untrusted-data.ts         # Wrap file/agent text as a labeled untrusted-data block
│   ├── agent-engine-label.ts     # Display names for the Pi/OMP engines (every surface reads this one map)
│   ├── product-name.ts           # "Pi Desktop" display name (a named constant, never a translation key)
│   ├── i18n/                     # i18next instance, t/tEnglish, bundled languages, OS-language resolver, pseudo-language, locale checks
│   ├── pi-command.ts             # Slash-command filtering
│   ├── fork-point.ts             # Fork/branch message helpers
│   ├── session-lineage.ts        # Cross-session lineage tree
│   ├── session-preview.ts        # First user message -> one-line row label
│   ├── stopped-answer.ts         # The one rule for an answer the user stopped (stopReason "aborted")
│   ├── sidebar-width.ts          # Bounds/resolution for the user-adjustable sidebar width
│   ├── chat-width.ts             # Chat column width setting values (normal / full)
│   ├── terminal-height.ts        # Default and bounds for the resizable terminal
│   ├── typesafe.ts               # TypeSafe (Jev) values shared by both processes
│   ├── voice-models.ts           # On-device speech-to-text model catalog (other voice-*.ts hold dictation helpers)
│   ├── workflow-control.ts       # Control eligibility for persisted workflow runs
│   └── theme/                    # Theme-file format, resolver, syntax defaults, tokens
├── main/
│   ├── index.ts                  # App lifecycle, window creation, hardening
│   ├── i18n.ts                   # Main-process language: OS language list, pseudo-language gate, apply the setting
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
│   ├── pi-dotenv.ts              # Read ~/.pi/.env for agent processes, the terminal, and Diagnostics
│   ├── latest-project-session.ts # Per-engine session directories of a project; its latest session
│   ├── streaming-text-tracker.ts # Offsets of streamed text, so a view that returns mid-message stays in sync
│   ├── session-trash.ts          # Deleted sessions go to the desktop trash (trash-cli, then gio)
│   ├── path-authorization.ts     # Path containment checks (attachment/session IPC)
│   ├── renderer-origin.ts        # Trusted-renderer URL check (navigation + IPC sender)
│   ├── window-background.ts      # Native window background that follows the theme
│   ├── workspace-trust.ts        # Per-workspace trust registry (gates allow rules + preview)
│   ├── workspace-manager.ts      # Multi-workspace management
│   ├── git-conveyor.ts           # Validated commit, push, branch, and GitHub PR commands
│   ├── commit-message-generator.ts # One-shot engine run that suggests a commit subject
│   ├── commit-message-service.ts # Commit message suggestions cached per workspace and diff
│   ├── file-service.ts           # File tree, search, git status, read/write
│   ├── terminal-service.ts       # node-pty PTY management
│   ├── workspace-terminals.ts    # One PTY per workspace, independent of the visible panel
│   ├── agent-detection.ts        # Detect claude/codex/pi CLIs (council)
│   ├── council-manager.ts        # Council consultant fan-out + streaming
│   ├── notes-manager.ts          # Reusable prompts/notes persistence
│   ├── session-tags.ts           # Session tag persistence
│   ├── session-paths.ts          # Session dir <-> real path (de)sanitization, Windows-safe
│   ├── session-name.ts           # Read a session's display name from its .jsonl
│   ├── activity-stats.ts         # Persisted per-day message/token/model stats store
│   ├── package-catalog.ts        # pi.dev catalog crawl, concurrent + prefetched + cached
│   ├── package-updates.ts        # npm-registry update check + OMP npm-plugin update spec
│   ├── auto-tag.ts               # Machine-derived session tags
│   ├── archived-sessions.ts      # Archived session persistence
│   ├── app-data-paths.ts         # Resolve app data directories
│   ├── attachment-reader.ts      # Read chat attachments (image base64 / text)
│   ├── fs-errors.ts              # Friendly file-system error messages
│   ├── models-file.ts            # Per-engine models file (Pi models.json / OMP models.yml) resolve + parse
│   ├── omp-fork-points.ts        # Fork candidates read from an OMP session file (no get_fork_messages RPC)
│   ├── omp-stopped-answers.ts    # Stopped answers a reloaded OMP session leaves out of get_messages, read back from its file
│   ├── omp-plugin-list.ts        # Parse `omp plugin list --json` for the installed-packages panel
│   ├── skills-discovery.ts       # Per-engine skill roots scan + catalog merge
│   ├── session-metadata.ts       # Bounded reader: session name, header, first-message preview
│   ├── session-lineage-reader.ts # Parent links and labels across the session store
│   ├── get-messages-trim.ts      # Shrink a get_messages response before IPC
│   ├── map-concurrent.ts         # Bounded-concurrency mapper
│   ├── extension-ui-ipc.ts       # Extension-UI half of the IPC surface
│   ├── pi-event-router.ts        # Routes every runtime's Pi events to the renderer
│   ├── git-worktree.ts           # Isolated Git worktrees for New Task
│   ├── git-head-watcher.ts       # Reports a HEAD or local branch change made outside the app; always on for the active workspace
│   ├── theme-store.ts            # User theme files: list, save, delete, install from URL, gallery
│   ├── typesafe-key-store.ts     # TypeSafe API key in an owner-only file in the GUI data dir
│   ├── typesafe-skill.ts         # Install the TypeSafe agent skill from a pinned release, digest-checked
│   ├── voice-model-store.ts      # Downloaded speech models under the GUI data dir
│   ├── voice-model-download.ts   # Pick and download one speech model's files
│   ├── voice-protocol.ts         # `pi-voice` scheme that serves model files to the renderer
│   ├── voice-gpu-switches.ts     # Chromium GPU switches for the saved voice device, read before app ready
│   ├── global-dictation-shortcut.ts # System-wide dictation key (Electron globalShortcut), toggles the composer mic
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
    ├── public/theme-boot.js      # Paints the last theme's colors before the first frame
    └── src/
        ├── main.tsx              # React root
        ├── app.tsx               # App shell with view routing
        ├── store.ts              # Zustand state management
        ├── hooks.ts              # Event subscriptions, lifecycle, command catalog
        ├── hooks/use-folder-drop.ts # Drop a folder onto the window to open it as a workspace
        ├── global.d.ts           # Renderer ambient types
        ├── i18n.ts               # Boot language, language picker options, apply the language setting
        ├── message-parsing.ts    # Pi messages -> display messages
        ├── message-grouping.ts   # Tool-name labels and message grouping
        ├── reattached-tool-calls.ts # Mark unfinished tool calls as running when a view returns mid-turn
        ├── claude-cli-markers.ts # Parse pi-claude-cli tool markers into tool cards
        ├── theme/engine.ts       # Apply a resolved theme to the document
        ├── themes/               # Built-in theme JSON files
        ├── index.css             # Tailwind + theme overrides
        ├── voice/                # Mic capture, speech-model Web Worker, live dictation hook
        ├── utils/
        │   ├── app-shortcuts.ts  # Dispatch configurable shortcuts to app actions
        │   ├── commit-push-shortcut.ts # Review / Commit and push shortcut flow
        │   ├── tab-navigation.ts # Project/session tab order and next/previous tab
        │   ├── planning-prompt.ts # Plan/read-only prompt wrapper
        │   ├── ipc-error.ts      # Strip Electron's remote-method prefix from IPC errors
        │   ├── quick-switcher.ts # Token filters for the palette's workspace/session/file sections
        │   ├── rank-file-results.ts # Basename-tiered ranking for file search hits
        │   ├── session-title.ts  # Distinguishable fallback session titles
        │   ├── session-diff.ts   # Filter diff files to those the session's edit/write calls touched
        │   ├── heatmap-grid.ts   # Weeks/intensity layout for the stats mini-heatmap
        │   ├── model-search.ts   # Tokenized model-picker search (treats -_./: as spaces)
        │   ├── model-recency.ts  # Last-picked time per model, for picker ordering
        │   ├── thinking-levels.ts # Thinking levels a model offers
        │   ├── theme.ts          # Theme application
        │   ├── ui-font.ts        # Apply the UI font setting
        │   ├── debounced-buffer.ts # Debounced editor text buffer
        │   ├── format-relative-time.ts # Relative-time labels capped at days
        │   ├── relative-time.tsx # Shared ticking "now" for relative labels
        │   ├── stale-guard.ts    # Last-write-wins guard for overlapping loads
        │   ├── preview-load-error.ts # Preview load/save failure kept as data, translated at render
        │   ├── chat-width.ts     # Chat column width setting -> message/composer max-width classes
        │   ├── process-status-label.ts # Translated agent process status (status popover, Diagnostics)
        │   └── workflow-runs.ts  # Session id used to scope workflow runs
        └── components/
            ├── sidebar.tsx        # Workspace switcher, nav, sessions grouped by folder, inline rename
            ├── sidebar-session-labels.ts # Session row label helpers
            ├── home-screen.tsx    # Full Home launcher (stats, recents, open folder / new session)
            ├── task-launcher.tsx  # New-task modal that starts a real background session
            ├── mission-control.tsx # Global live-session and workflow inbox
            ├── git-conveyor-actions.tsx # Git bar: Commit, Commit + Push, Push, PR / Open PR #N, commit dialog
            ├── project-branch-selector.tsx # Status-bar branch menu: switch branch, New branch
            ├── stats-panel.tsx    # Activity stats dashboard on Home
            ├── chat-panel.tsx     # Main streaming chat; empty session = center prompt + project picker
            ├── chat-project-picker.tsx # Empty-chat project / no-project picker under the composer
            ├── chat-input.tsx     # Composer: mentions, attachments, model/thinking/permission pickers, mic, #tags
            ├── composer-draft.ts  # Composer draft kept apart from recalled prompts
            ├── model-selector.tsx # Composer model picker (searchable, keyboard-driven)
            ├── subagent-progress.tsx # Compact live subagent strip on the composer
            ├── voice-mic-button.tsx # Composer mic button for voice dictation
            ├── chat-code-highlight.ts # Fenced-code syntax highlighting -> HTML
            ├── chat-file-link.ts  # Detect/classify filenames mentioned in chat text
            ├── copy-button.tsx    # Shared copy-to-clipboard button
            ├── image-viewer.tsx   # Read-only image preview pane
            ├── council-panels.tsx # Council planning live cards + gate
            ├── message-bubble.tsx # Messages with edit/branch/copy/export
            ├── streaming-bubble.tsx # Live streaming indicator
            ├── markdown-renderer.tsx # Markdown + syntax highlight
            ├── code-editor.tsx    # CodeMirror 6 editor
            ├── code-editor-language.ts   # Language detection
            ├── code-editor-highlight.ts  # Theme-aware highlight style
            ├── code-editor-git.ts # Git change markers in the editor gutter
            ├── status-bar.tsx     # Agent status, branch menu, workflows, context, compact, cost, panel toggles
            ├── status-popover.tsx # System status popup
            ├── settings-panel.tsx # Language, theme, font, behavior, shortcuts, council settings (live-preview draft)
            ├── shortcut-settings.tsx # Settings > Keyboard shortcuts recorder
            ├── voice-settings.tsx # Settings > Voice dictation
            ├── typesafe-settings.tsx # Settings > TypeSafe Jev
            ├── custom-models-editor.tsx # Custom models/providers editor
            ├── permission-selector.tsx # Permission mode selector
            ├── permission-mode.ts # Permission mode helpers
            ├── permission-rules-editor.tsx # Permission rules editor (Settings > Behavior)
            ├── permission-rules-editor-helpers.ts # Permission rules editor parse/validate helpers
            ├── session-panel.tsx  # Sessions grouped by project
            ├── session-menu-position.ts # Session menu placement
            ├── timeline.tsx       # Agent activity timeline
            ├── review-rail.tsx    # Review panel: permissions, approvals, changed files, session status
            ├── chat-tool-rail.tsx # Right-edge icon rail: review, files, diff, and terminal toggles
            ├── package-browser.tsx # Package/skill browser, fetch-once + local filter, update check
            ├── skills-panel.tsx   # Skills browser
            ├── notes-panel.tsx    # Reusable prompts/notes
            ├── note-picker.tsx    # Insert a saved note
            ├── command-palette.tsx # Ctrl/Cmd+K quick switcher (commands, workspaces, sessions, files)
            ├── sidebar-activity.ts # Workspace activity dot mapping for the sidebar
            ├── diagnostics-panel.tsx # Diagnostics view (Pi binary, providers, permissions, log)
            ├── file-tree.tsx      # File tree + search + preview
            ├── diff-viewer.tsx    # Git diff viewer: session filter, discard, open file
            ├── terminal.tsx       # ANSI terminal, resizable
            ├── terminal-clipboard.ts # Ctrl+C / Ctrl+V copy and paste rules per OS
            ├── context-menu.tsx   # Right-click context menu, themed confirm dialog
            ├── error-boundary.tsx # Renderer error boundary
            ├── extension-ui-dialog.tsx # Extension UI protocol + AppConfirmDialog
            ├── chat-search.tsx    # Ctrl/Cmd+F find in conversation
            ├── chat-panel-widths.ts # Width math for the chat side panel
            ├── command-results.tsx # Grouped command rows (palette + inline slash popup)
            ├── composer-permission-menu.tsx # Permission-mode picker on the composer
            ├── line-numbered-code.tsx # Line-numbered highlighted code rows
            ├── resize-handle.tsx  # Drag handle reporting deltas along one axis
            ├── session-runtime-indicator.tsx # Per-session engine/status indicator
            ├── theme-editor.tsx   # Custom theme editor
            ├── theme-editor-helpers.ts # Pure theme-editor helpers
            ├── theme-gallery.tsx  # Theme gallery browser
            ├── thinking-level-selector.tsx # Thinking level picker
            ├── tool-call-icon.ts  # Icon per tool-call operation
            ├── workflow-navigator.tsx # Workflow runs navigator
            └── workspace-tabs.tsx # Project tabs (drag to reorder) and the project's session tabs
resources/
├── pi-desktop-permissions.ts     # Pi extension that enforces permission modes and rules
├── permission-rules.ts           # Rules engine shared by the extension and the main process
├── permission-prompt-text.ts     # Approval prompt text read from the language files
└── locales/                      # Interface language files
```

## Features

### Engines (Pi and OMP)

- The app runs either the standard `pi` CLI or the compatible `omp` binary from oh-my-pi. Settings > Agent Configuration picks one (auto-detect, a detected install, or a custom executable); `pi-binary-resolution.ts` finds and identifies installs.
- The two engines keep separate session stores: Pi under `~/.pi/agent/sessions`, OMP under `~/.omp/agent/sessions`. OMP ignores `--session-dir` for new sessions, so no shared store is forced; the session index reads both roots.
- Each session list row carries the engine that owns it (`SessionListItem.engine`, set from the store it was found in). Opening, forking, or resuming a session starts the engine that wrote it, not the configured default (`engineForBoundSession` in `pi-paths.ts` is the single rule).
- Tool names differ per engine (Pi ships `find`/`ls`, OMP ships `glob`), so Plan/Read-only mode derives its tool list from the session's engine, never from the configured one.
- Every surface that names the running agent (status bar, empty chat, permission prompts, Diagnostics, session tags) reads `shared/agent-engine-label.ts`; the permission extension gets the label through `PI_DESKTOP_AGENT_LABEL`. Session rows show the Pi/OMP tag only when both engines appear in one list.
- OMP specifics: protocol-v2 chunked frames are decoded with the limits the engine advertises in its ready frame. OMP starts subagents in a new process group, so shutdown walks the descendant tree before it sends signals. OMP's plugin verbs back the package actions.
- OMP RPC gaps the GUI bridges: OMP has no `fork`/`clone`/`get_fork_messages`/`get_commands`. Fork maps to OMP's `branch` (same entryId argument), fork candidates are read from the session file (`omp-fork-points.ts`), the Clone action is hidden under OMP, and the command catalog uses `get_available_commands` (`skills-mcp-handlers.ts`). OMP reports its own commands with source `builtin`; a GUI action of the same name replaces it, and the rest are sent as typed text, which OMP runs. A session OMP loads from disk leaves stopped answers out of `get_messages`; they are read back from the file (`omp-stopped-answers.ts`).
- OMP names the session directory of a project under the home or temporary directory `-<relative path>` / `-tmp-<relative path>` (`ompSessionDirName`). Resume Last Session reads only the selected engine's store. Session tabs are live runtimes and are not restored after a restart: only the resume target starts.
- Per-engine config files: Pi keeps `~/.pi/agent/models.json` (JSON); OMP 18 keeps `~/.omp/agent/models.yml` (YAML). `models-file.ts` resolves and (de)serializes both, and keeps reading a not-yet-migrated OMP `models.json`. OMP's installed-package list comes from `omp plugin list --json` (`omp-plugin-list.ts`), not from a settings.json `packages` array. `omp plugin upgrade` covers marketplace plugins only, so an npm plugin updates by reinstalling from its dist-tag with its feature selection and disabled state carried over (`package-updates.ts`). Per-engine IPC decisions read `ipc/active-engine.ts`, so the active session's engine wins over the configured default.
- Session names: Pi appends `session_info` records; OMP rewrites a fixed first-line `{"type":"title"}` slot. `session-name.ts`/`session-metadata.ts` read both (session_info outranks the title slot).
- Skills are listed per engine (`skills-discovery.ts`): Pi scans `~/.pi/agent/skills`, `~/.agents/skills` and project `.pi/skills`/`.agents/skills` recursively; OMP scans `.omp`, `.claude` and `.agents` roots one level deep. Skills only the other engine can load are never shown. When the engine is running, plugin-shipped skills from its command catalog are merged in (`rpc:`-prefixed pseudo-paths render from the description).
- `~/.pi/.env` (`pi-dotenv.ts`) adds its variables to every Pi or OMP process, the council's Pi run, commit message suggestions, package CLI runs, and the terminal, and Diagnostics uses it for the provider key check. A variable already in the app's environment wins.

### Workspace management

- Multiple workspaces (project directories). No workspace is created automatically: a fresh install opens to Home, and opening a folder or resuming a session creates and activates one
- Each workspace owns a file service; every live session in that project owns an independent Pi process bound to the workspace cwd and its own `--session` file
- Session navigation is immediate; Pi startup and history loading continue in the background
- Workspace switcher in the sidebar
- Project tabs keep creation order until the user drags one to a new place; the custom order is saved (`utils/tab-navigation.ts`), and the project-tab shortcuts follow it
- Switching to a session from a different project creates that project's workspace if needed
- **Drag and drop a folder** onto the window to open it as a project (create the workspace if needed, switch, show Chat); this is the same path as File > Open Project
- Mission Control summarizes all live session runtimes and workflow runs across projects; New Task sends a prompt to a dedicated background runtime

### Session management

- Sessions are organized by working directory (Pi native) and decoded correctly on every platform, including Windows drive-letter paths
- One independent Pi runtime per live session, including several sessions that share one project directory
- Switching sessions never sends a destructive `switch_session` to the previous process; the previous turn continues in the background
- Session tabs and sidebar rows show working, approval, completed, and failed indicators
- Sessions grouped by project in the session panel
- **Session tags**: type `#tag-name` in chat to tag the current session. Tags are saved to `<GUI data dir>/session-tags.json`, shown in the session list, and filterable
- Session names come from each session's `session_info` record (Pi) or first-line `title` slot (OMP). The fallback title is a distinguishable local timestamp, not a shared id prefix
- Inline rename of the active session (double-click, or right-click > Rename…) through Pi's `set_session_name` RPC; it updates live on `session_info_changed`
- Delete asks in an in-app themed dialog, not the native OS dialog
- Branch/fork tree, clone, and cross-session lineage in the Timeline; one-click context compaction (status bar and status popover)
- An answer the user stopped keeps a "Stopped" mark (`shared/stopped-answer.ts`)

### Chat

- Streaming responses with live updates
- Message editing (edit and resend)
- Conversation branching
- Per-message copy and export (Markdown file)
- File attachments, picked (several at once), pasted, or dropped anywhere on the chat pane (`shared/attachment-rules.ts`, `utils/attachment-batch.ts`): text is inlined into the prompt; images are sent as Pi image blocks. A dropped folder still opens as a workspace
- Markdown rendering with syntax highlighting; bundled Inter/JetBrains Mono variable fonts and OpenMoji color emoji, so rendering does not depend on system fonts
- Fenced SVG documents render as a sandboxed `data:` image with a source/render toggle (no scripts, no external loads)
- File names mentioned in chat text become links that open a code/image preview pane
- Tool-call results are collapsible (first line as header, expand for the rest); edit/write results fold into the call badge with an inline diff; each message shows its model
- `#tag` extraction from messages

### Model and thinking

- Model picker on the composer, with tokenized search ("sonnet 4" matches `claude-sonnet-4`), arrow-key navigation, and recently used models first (`utils/model-recency.ts`)
- `Mod+Shift+M` (configurable) opens the picker; `Ctrl+P` in the composer cycles models
- Thinking level selector: the efforts the model advertises, or off/minimal/low/medium/high/xhigh/max when it advertises none (`utils/thinking-levels.ts`)
- Context usage and cost in the status bar

### Command palette / quick switcher

- Open with `Ctrl/Cmd+K` (configurable; works with Pi stopped), or type `/` at the start of the composer for the inline command popup
- One searchable list: commands plus Workspaces, Sessions, and Files sections; a leading `/` narrows it to commands only
- Results grouped by source: Skills, Prompts, Commands (Pi built-ins), Extensions
- Skills, prompts, and extensions insert their token (`/skill:name`, `/template`, `/cmd`) for Pi to expand. Built-ins (`/compact`, `/model`, `/clone`, `/new`, `/task`, `/resume`, `/fork`, `/settings`) run the GUI action directly; `/clone` is offered under Pi only (`useCommandCatalog` in `hooks.ts`)
- Workspace, session, and file picks go through the store's guarded actions, so the streaming and dirty-editor confirmations still apply

### Keyboard shortcuts

- Settings > Keyboard shortcuts records a new combination per action or disables it. `src/shared/keyboard-shortcuts.ts` holds the actions, the defaults, matching, and the conflict checks; `utils/app-shortcuts.ts` dispatches them
- Bindings are stored with `Mod` (Cmd on macOS, Ctrl elsewhere). A binding needs Cmd or Ctrl plus a letter, digit, punctuation key, or F1 to F12
- Default bindings: diff `Mod+G`, terminal `Ctrl+Backquote`, settings `Mod+Comma`, command palette `Mod+K`, model selector `Mod+Shift+M`, note picker `Ctrl+Shift+P`, Review / Commit and push `Mod+Shift+H`, sidebar `Mod+B`, file tree `Mod+Shift+E`, Review panel `Mod+Shift+U`, new session `Mod+N`, previous/next project `Mod+Shift+BracketLeft`/`Mod+Shift+BracketRight`, previous/next open session `Mod+BracketLeft`/`Mod+BracketRight`, push to talk `Mod+Shift+T`; the system-wide dictation key is off by default
- Voice keys: hold push to talk to record into the composer and let go to stop (silence does not end it while held; losing window focus does). The system-wide dictation key works while other apps are in front: the main process binds it with Electron `globalShortcut` (`global-dictation-shortcut.ts`), which reports presses only, so each press starts or stops dictation like a mic click. It is bound at startup and on Save; a key another app holds is logged to the app log. On Linux Wayland the desktop's global-shortcuts portal must accept the bind
- Native menu and editing shortcuts are reserved and cannot be assigned (`RESERVED_SHORTCUTS`), for example `Mod+Shift+N` (New Workspace), `Mod+O` (Open Project), `Mod+F`, and `Ctrl+P`. A duplicate or reserved binding blocks dispatch until it is fixed
- Fixed keys outside the configurable set: `Enter` sends, `Shift+Enter` adds a line, `Esc` stops the running turn, `Up`/`Down` recall prompts, `Ctrl/Cmd+F` finds in the conversation, `Ctrl/Cmd+Shift+F` searches workspace files

### Chat tool rail and side panels

- The right-edge tool rail (`chat-tool-rail.tsx`) toggles the Review panel, file tree, diff viewer, and terminal. It has no workflow button
- The Review panel (`review-rail.tsx`) shows the permission mode, pending approvals, changed files, and session status. It is hidden by default
- Click a workspace file link (chat or file tree) to open it in a side pane: code (CodeMirror), image, PDF, or HTML. HTML runs in a sandboxed `<webview>` (no Node access, isolated partition, `file://` source only). HTML preview runs scripts and network only when the workspace is trusted; an untrusted workspace gets a static preview with a "Trust workspace" banner

### Workflow runs

- `workflow-monitor.ts` reads runs of the pi-dynamic-workflows extension from `~/.pi/workflows`
- Workflow runs open from the sidebar (Workflows for the project, All Workflows for every project), the status bar, and the session context menu (Workflow Runs). Project and session scope open a floating panel; All Workflows fills the main pane
- Abort and Resume follow the extension's own state matrix (`shared/workflow-control.ts`)

### Issue-to-PR conveyor

- Task Launcher accepts an issue description or URL, optionally creates or reuses a local Git worktree, and sends the task to a dedicated Pi runtime. PR URLs are resolved with `gh pr view`; unrelated or ambiguous worktrees are never guessed.
- The diff viewer's Git bar has Commit, Commit + Push, Push, and PR (Open PR #N when the branch has an open pull request). Mutating Git operations never happen implicitly.
- The diff viewer can filter to the files the session's edit/write calls touched (`utils/session-diff.ts`), discard shown unstaged changes, and open a file in the editor.
- **Suggest message** in the Commit dialog runs only on click. It sends the selected changes to a one-shot run of the session's engine and model with tools off (`commit-message-generator.ts`); results are cached per workspace and diff (`commit-message-service.ts`).
- Untracked files reach a commit only when the user checks them in the Commit dialog (listed unchecked; ignored files and directories are refused). An upstream whose remote-tracking branch is missing counts as not published, so Push publishes it with `--set-upstream`.
- The status-bar branch menu (`project-branch-selector.tsx`) switches only a clean worktree, and its New branch… item creates a branch from HEAD (`git switch --create`), which is allowed with uncommitted changes because they move with it.
- PR creation uses GitHub CLI when available, targets the configured `upstream` remote when present, and opens the returned PR URL. An open pull request of the branch (`gh pr list`, cached for a minute with the status poll) turns the button into Open PR #N.

### Workspace activity and desktop notifications

- Main derives per-workspace activity (working / needs approval / completed / failed) from every session runtime's Pi events. The renderer's stream state follows only the active runtime, so this ships as its own map (`workspace-activity.ts`, broadcast on `event:workspace-activity`)
- A separate session-runtime snapshot stream exposes each live session's process status, PID, activity, and active binding for per-session indicators
- The sidebar shows per-workspace dots (pulsing while working; success/error until the workspace is next viewed) next to the held-prompt badges
- OS notifications (toggle in Settings > Behavior, on by default) fire when a turn finishes, fails, or waits for approval outside the focused view; clicking one focuses the window and switches to that workspace through the renderer's guarded switch

### Diagnostics

- Sidebar > Diagnostics: Pi binary resolution (path, source, node binary, PATH), `pi --version`, per-workspace path/trust/process status, provider key classification from the engine's models file (never evaluates secrets), permission mode and rule counts, storage paths, and recent warnings/errors from the app log
- App log: `app-log.jsonl` in the GUI data dir (ring-buffered in memory, size-capped rotation), so packaged-build errors survive for the Diagnostics view

### File and project

- File tree with git status badges (M/A/D/R/U)
- File search by name and content
- Git branch indicator and branch menu in the status bar
- Git diff viewer (working and staged)

### Code editor

- CodeMirror 6 editor for opening and editing project files
- Theme-aware syntax highlighting through a custom `HighlightStyle` (in `code-editor-highlight.ts`) whose token colors are CSS variables. The theme resolver (`shared/theme/resolve.ts`) emits each theme's `--cm-*` palette from the theme file's `syntax` block (or `syntax-defaults.ts`), so the editor restyles on a theme switch without editor logic.
- Git change markers in the gutter (`code-editor-git.ts`)
- 15+ languages: JS/TS/JSX/TSX, JSON, Markdown, HTML, CSS/SCSS/Less, Python, Rust, Go, Java, PHP, XML/SVG, SQL, YAML, C/C++/C#
- Save/Revert/Close controls with dirty-state tracking and 2s "saved" feedback
- Debounced onChange (150ms) and race-safe file switching
- Saves are validated in the main process with `path.relative()` to enforce workspace boundaries

### Terminal

- Real PTY through `node-pty` in the main process, `@xterm/xterm` in the renderer
- Full ANSI/VT100 support, including 256-color and true-color
- Runs the user's shell directly, independent of the Pi process
- One PTY per workspace (`workspace-terminals.ts`); hiding the panel keeps the shell running
- The panel resizes by dragging its top edge (`shared/terminal-height.ts` sets the bounds) and can be maximized
- PTY managed by `terminal-service.ts`; IPC channels relay input/output/resize

### Home / activity dashboard

- **Open to Home Screen on Launch** (Settings > Behavior, on by default): when on, the app starts on the full Home launcher (stats, changed files, recent workspaces/sessions, Open Folder / New Session / New Task). When off, it starts in Chat; an empty session shows a **center prompt** with a **project picker** under the composer (sidebar and status bar stay)
- Suggested prompt chips on an empty chat **fill the composer** (ready for Enter); they do not send a turn
- Recent sidebar groups sessions by project folder (platform-aware path equality)
- A compact live **subagent strip** sits on the composer while subagents run
- Range-selectable (7d to 1y) stats: sessions, messages, tokens, active days, current/longest streak, peak hour, favorite model, per-model input/output token usage
- Persisted per-day aggregate store (`activity-stats.ts`) survives session deletion (captured before the file is removed); it stores only aggregate numbers, never prompt or response text
- A baseline scan runs on launch (non-blocking), so stats are accurate even if Home is never opened that run
- Resuming the last session or switching workspace loads the full chat history

### Packages and skills

- Browse installed packages: Pi from `settings.json` `packages[]`; OMP from `omp plugin list --json`
- Package catalog from pi.dev, fetched once and filtered locally per keystroke; concurrent paged crawl with a shared in-flight promise, prefetched at launch so the tab opens at once
- Install/remove/update packages through `pi install`/`pi remove`/`pi update`; under OMP the remove and update verbs map to `omp plugin uninstall`/`omp plugin upgrade` (`run-pi-cli.ts`). Package actions run the active session's engine CLI
- Skills list with source (project/global/package/cli); see Engines for the per-engine roots
- Extension commands display

### System status popover

Click the status icon in the sidebar header to see:
- Agent status, PID, model, provider, thinking level, session
- Context usage with a progress bar
- Message count, tokens, and cost, with a compact button
- Workspace info
- Extensions, skills, MCP servers, prompt templates, and skill commands

### Settings

- Agent Configuration: engine (auto-detect / Pi / OMP) and executable path
- Theme: Dark, Light, System, Nord, Gruvbox, Breeze Dark, Breeze Light, Breeze Claudius (Breeze Dark base with a deep chat surface, contributed by @sumit-m). It applies immediately. **The default is `system`**, which maps light mode to `light` and dark mode to `dark`; Breeze Claudius is opt-in only
- UI font (a font list; empty uses the bundled defaults) and independent UI / Terminal / Code Editor font size sliders
- Chat width: Normal (readable middle column) or Full width (messages and composer fill the chat area)
- Show thinking blocks, auto-scroll
- Run on startup, Minimize to tray on close (Windows/Linux), Resume last session, desktop notifications
- Keyboard shortcuts (see Keyboard shortcuts above)
- Custom theme editor: create, edit, import/export, install from URL, browse the community gallery (theme files live in the GUI data dir `themes/`)
- Voice dictation: speech model, precision, and device; models download into `<GUI data dir>/speech-models/`
- TypeSafe Jev: API key and Jev skill install
- Every field live-previews before Save through a unified settings draft (`store.ts` `settingsDraft`); the draft survives view switches; Save persists it, and Reset restores `DEFAULT_SETTINGS`
- Permission rules: user-defined allow/deny rules (a glob per Pi tool) on top of the permission modes. Deny beats allow, and allow beats the mode default; deny applies in every mode. Global rules live in `<GUI data dir>/permission-rules.json`. A workspace `.pi-desktop/permission-rules.json` depends on workspace trust: when the workspace is trusted, it replaces the global rules; when it is untrusted (the default), only its deny rules apply, on top of the global rules, and its allow rules are ignored (a repo can tighten, never grant). Opening a workspace whose rules file has allow rules shows a trust prompt; the editor's Global tab notes the override, and the This workspace tab has a Trust/Revoke control. Settings > Behavior edits BOTH scopes through Global | This workspace tabs: create, edit, and remove workspace rules (in-app danger confirmation), Copy from global (seeds an unsaved draft from the current global list), and per-scope JSON import/export. Hand edits to either file on disk are supported: switching scope tabs re-reads that file when the scope has no unsaved draft. Engine: `resources/permission-rules.ts`, shared by the Pi extension (jiti relative import, mtime-cached live re-read) and the main process. The permissions extension always loads alongside Pi when it is present on disk, whatever the mode and whether or not rules exist, so a rules file created mid-session is enforced at once.
  - Trust posture: a workspace's `.pi-desktop/permission-rules.json` is repo content, so its allow rules take effect only after the user explicitly trusts the workspace (saved in `trusted-workspaces.json`; shown as a trust prompt on open and a control in Settings). Until then, the repo can only add deny rules; it cannot suppress ask-mode prompts. Rule globs match raw tool input strings only (no path canonicalization, no command parsing), so rules guard against accidents and are not a security sandbox.
- Custom models and providers editor: edits the active engine's models file, `~/.pi/agent/models.json` (Pi) or `~/.omp/agent/models.yml` (OMP; a not-yet-migrated `models.json` is kept until OMP migrates it). Main reports the resolved file, so the editor labels always match; changes apply on engine restart
- All settings are saved to `<GUI data dir>/settings.json`; defaults come from the single shared `src/shared/default-settings.ts` (used to seed the file AND for the renderer's initial/Reset values)
- Language (`language`, default `system`; resolved by `src/shared/i18n/resolve.ts` against `app.getPreferredSystemLanguages()`; applies on Save; `PI_DESKTOP_PSEUDO_LANGUAGE=1` offers the `en-XA` test language)

### Context menu

Right-click for:
- Copy, Cut, Paste, Select All, Copy All Visible Text
- Messages: Copy Message, Copy Selection, Add Message (or Selection) to Notes
- Code blocks: Copy Code Block, Search Selection
- Links: Open Link, Copy Link
- Session rows: Open Session, Workflow Runs, Archive/Unarchive, Rename…, Delete…
- Terminal: Copy, Paste, Select All, Clear

## IPC architecture

All communication between the renderer and main goes through a typed preload bridge:

```
Renderer → preload (contextBridge) → IPC → main handlers → Pi RPC / File system
```

- `IPC_CHANNELS` in `src/shared/ipc-contracts.ts` lists every channel; all handlers validate their payloads
- Pi events go from main to the renderer through `webContents.send`
- Extension UI protocol supported (select, confirm, input, editor dialogs)

## Data storage

The GUI data dir is `<appData>/pi-desktop` (on Linux, `~/.config/pi-desktop`). `PI_DESKTOP_USER_DATA_DIR` overrides it. Without the override, startup migrates files still in the legacy `~/.pi-desktop-gui` directory (`migrateLegacyGuiData` in `app-data-paths.ts`).

| Path | Purpose |
|------|---------|
| `<GUI data dir>/workspaces.json` | Workspace list and active workspace |
| `<GUI data dir>/settings.json` | App settings |
| `<GUI data dir>/session-tags.json` | Session tags |
| `<GUI data dir>/trusted-workspaces.json` | Workspaces the user has trusted (enables their allow rules + interactive HTML preview) |
| `<GUI data dir>/activity-stats.json` | Persisted per-day activity stats (aggregates only, survives session deletion) |
| `<GUI data dir>/app-log.jsonl` | Main-process app log (warnings/errors for the Diagnostics view) |
| `<GUI data dir>/notes.json` | Reusable prompts/notes |
| `<GUI data dir>/archived-sessions.json` | Archived sessions |
| `<GUI data dir>/session-auto-tags.json` | Machine-derived session tags |
| `<GUI data dir>/permission-rules.json` | Global permission rules |
| `<GUI data dir>/themes/` | User theme files |
| `<GUI data dir>/typesafe-api-key` | TypeSafe API key (owner-only file) |
| `<GUI data dir>/speech-models/` | Downloaded voice dictation models |
| `<workspace>/.pi-desktop/permission-rules.json` | Workspace permission rules |
| `~/.pi/agent/sessions/` | Pi session files (organized by cwd) |
| `~/.omp/agent/sessions/` | OMP session files (same layout; OMP writes here regardless of flags) |
| `~/.pi/agent/settings.json` | Pi global settings (installed `packages[]`) |
| `.pi/settings.json` | Pi project settings |
| `~/.pi/agent/models.json` | Pi custom models/providers |
| `~/.pi/.env` | Environment variables for agent processes and the terminal |
| `~/.omp/agent/models.yml` | OMP custom models/providers (OMP has no settings.json; its settings live in `config.yml`, which the GUI does not read) |
| `~/.omp/plugins/` | OMP plugin store (listed through `omp plugin list --json`) |
| `~/.omp/agent/mcp.json` | OMP MCP servers (read for the status popover) |
| `~/.agents/skills/` | Shared skills root; the TypeSafe Jev skill installs here |
| `~/.pi/workflows/` | Workflow runs and projects (Mission Control, workflow views) |
| `pi-desktop.boot-theme` (renderer `localStorage`) | Last-applied theme colors, painted before the first frame to avoid a flash of the default theme |
| `pi-desktop.boot-language` (renderer `localStorage`) | Last-resolved interface language, shown before Settings loads for the same reason |
| `pi-desktop.project-tab-order` (renderer `localStorage`) | Project tab order the user set by dragging tabs |
| `pi-desktop.model-recency` (renderer `localStorage`) | Last time each model was picked, for model picker order |

## Distribution

Pi Desktop ships as pre-built binaries only, never through npm. Agents must not run `npm publish`. The `bin/pi-desktop.js` entry and `install.sh` are launch/install helpers, not an npm package surface.

| Platform | Format | Notes |
|----------|--------|-------|
| Linux | AppImage | Primary supported target |
| Windows | Installer (`-setup.exe`) + portable `.exe` | Community-tested |
| macOS | `.dmg` + `.zip` (arm64) | Built with `package:mac`; not signed or notarized |

`electron-builder` builds the artifacts, named `Pi-Desktop-{version}-{os}-{arch}.{ext}` (the Windows installer adds `-setup`).

GitHub Actions (`.github/workflows/build.yml`) builds each OS on its own runner. A manual workflow run builds all three and uploads the installers as artifacts, with no release. Pushing a `v*` tag builds all three and publishes a GitHub prerelease. Local cross-builds from Linux require Wine (Windows portable only); a local macOS build requires a Mac.

## Development

```bash
npm install --ignore-scripts=false  # Install dependencies (runs the postinstall native rebuild)
npm run dev           # Build and launch (reliable)
npm run dev:hot       # Dev mode with hot reload (may have race condition)
npm run build         # Build only
npm run preview       # Launch built app
npm run typecheck     # TypeScript project check
npm run lint          # ESLint, semantic colors, i18n checks
npm run package       # Create installer
```

## Pi integration

The agent runs in RPC mode as a subprocess; one `PiRpcManager` is kept for each live session runtime. The binary is `pi` or `omp`, depending on the session's engine (see Engines above):

```
pi --mode rpc [--no-session] [--provider <name>] [--model <id>] [--thinking <level>] [--fork <session-file> | --session <session-file> | --continue] [--tools <list>] [-e <pi-desktop-permissions.ts>]
```

- `buildPiArgs` in `pi-rpc-manager.ts` builds the argv. `--thinking` carries the default thinking level for a new session only. `--continue` resumes the latest session when Resume Last Session is on
- `--tools` is added in Plan / Read-only mode with the engine's read-only tools. `-e` loads the bundled permissions extension whenever it exists on disk (`ipc/pi-start-options.ts`)
- The extension reads its settings from `PI_DESKTOP_*` environment variables (mode, agent label, language, rules path, workspace trust)
- No `--session-dir` is added; each engine uses its own default store. A caller-supplied `--session-dir` in extra args still wins

Communication is JSONL over stdin/stdout:
- Commands go to stdin (one JSON object per line)
- Events stream from stdout (one JSON object per line)
- Requests and responses are correlated by the `id` field
- Extension UI protocol for interactive dialogs

## Versioning

Versions follow semantic versioning with prerelease tags. The current version is in `package.json`.
- `0.x.y-alpha`: alpha (current). Expect breakage in any release.
- `0.x.y-beta`: beta. Feature-complete for the release scope; bugs expected.
- `0.x.y`: stable release on the 0.x track.
- `0.x.0`: feature additions.
- `x.0.0`: stable major release.

## Final delivery checklist

Before delivering a change:

1. Read the relevant existing code first
2. Reuse existing patterns and utilities
3. Implement the full solution (no placeholders or partial work)
4. Add or update tests (`npx tsx --test`)
5. Remove dead code
6. Ensure consistency (naming, API shape, structure)
7. Run `npm run typecheck`, `npm run lint`, and `npm run build`
8. Update `MEMORY.md` when the work introduces decisions or known issues worth recording (it is a long-lived log, not a per-change requirement)
