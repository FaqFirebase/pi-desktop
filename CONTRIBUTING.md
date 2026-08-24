# Contributing to Pi Desktop

This guide covers bug reports, feature requests, and the pull request workflow.

## Architecture reference: `AGENTS.md`

[`AGENTS.md`](AGENTS.md) is the canonical reference for the project's architecture, module layout, data-storage locations, distribution model, and delivery standards. Read it before making non-trivial changes; it is kept more current and more detailed than the summary in this guide.

### For AI coding agents

If you use an AI coding agent (Claude Code, Codex, Kilo, Cursor, etc.) to work on this repository, the agent must read and follow [`AGENTS.md`](AGENTS.md), in particular its Final Delivery Checklist, before proposing or committing changes. Most agents load a file named `AGENTS.md` automatically; if yours does not, point it at the file explicitly at the start of a session.

At minimum, an agent's work must:

- Reuse existing patterns and utilities instead of duplicating logic
- Ship complete implementations (no placeholders, dead code, or deferred work)
- Add or update the colocated `*.test.ts` tests for any changed module
- Pass `npm run typecheck`, `npm run lint`, `npm run build`, and `npx tsx --test`
- Preserve the Electron security posture (see Electron security below)

## Contributor License Agreement

**Before your first contribution can be merged, you must agree to the [Contributor License Agreement (CLA)](CLA.md).**

The CLA confirms you have the right to contribute the code, grants the project a license to use your contribution, protects against patent claims, and defines trademark boundaries.

By submitting a pull request, you acknowledge that you have read and agree to the CLA.

## How to contribute

### Reporting bugs

1. Check [existing issues](https://github.com/FaqFirebase/pi-desktop/issues) first
2. Open a new issue with:
   - Clear title and description
   - Steps to reproduce
   - Expected vs actual behavior
   - Environment (OS, Electron version, Pi version)
   - Screenshots if applicable

### Suggesting features

1. Open a [feature request](https://github.com/FaqFirebase/pi-desktop/issues/new?template=feature_request.yml)
2. Describe the use case and expected behavior
3. Explain why this would be useful to other users

### Submitting code

This repository uses two long-lived branches:

- `master` holds public-facing docs only (`README.md`, `AGENTS.md`, `LICENSE`, `CLA.md`, `CONTRIBUTING.md`, `.gitignore`). Do not target PRs here.
- `Dev` holds all application source and is where active development happens. **Target your pull requests against `Dev`.**

Steps:

1. Fork the repository
2. Check out and branch from `Dev`:
   ```bash
   git checkout Dev
   git pull
   git checkout -b feature/my-feature
   ```
3. Make your changes following the coding standards below
4. Test your changes thoroughly
5. Commit with a clear message:
   ```bash
   git commit -m "feat: add my feature"
   ```
6. Push to your fork:
   ```bash
   git push origin feature/my-feature
   ```
7. Open a pull request against `Dev` (not `master`)

### Commit message format

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>

<footer>
```

Types:

- `feat`: new feature
- `fix`: bug fix
- `docs`: documentation
- `style`: formatting (no code change)
- `refactor`: code restructuring (no behavior change)
- `test`: adding or updating tests
- `chore`: build process, dependencies, tooling
- `perf`: performance improvement

Examples:

```
feat(chat): add file attachment support

fix(pi-rpc): handle EPIPE errors gracefully

docs(readme): update installation instructions
```

## Coding standards

### TypeScript

- Full strict mode enabled
- No `any` types; use proper typing
- Named constants instead of magic numbers
- Async/await over callbacks
- Proper error handling (no empty catch blocks)

### React

- Functional components with hooks
- Zustand for state management
- Tailwind CSS for styling
- No class components

### Electron security

- `contextIsolation: true`
- `nodeIntegration: false`
- All IPC through preload bridge
- Validate all IPC payloads
- No arbitrary command execution from renderer

### Code style

- 2-space indentation
- Single quotes for strings
- Semicolons only when required
- Trailing commas in multi-line
- Max line length: 120 characters

## Testing

Before submitting a pull request:

1. Type check passes:
   ```bash
   npm run typecheck
   ```

2. Lint passes:
   ```bash
   npm run lint
   ```

3. Unit tests pass:
   ```bash
   npx tsx --test
   ```

4. Build succeeds:
   ```bash
   npm run build
   ```

5. App launches and works:
   ```bash
   npm run dev
   ```

6. No regressions in existing functionality

## Project structure

```
src/
├── shared/ipc-contracts.ts    # IPC channel definitions
├── main/                      # Electron main process
│   ├── index.ts               # App lifecycle
│   ├── ipc-handlers.ts        # Registers the handlers in ipc/
│   ├── ipc/                   # One module per handler group, plus payload validation
│   ├── pi-rpc-manager.ts      # Agent subprocess management (Pi and OMP)
│   ├── pi-binary-resolution.ts # Locating and identifying the agent executable
│   ├── pi-paths.ts            # Session stores per engine, and which engine owns a session
│   ├── workspace-manager.ts   # Workspaces and per-session runtimes
│   ├── file-service.ts        # File tree, search, git, file write
│   ├── git-worktree.ts        # Isolated worktrees for tasks
│   ├── git-conveyor.ts        # Validated commit, push, and PR commands
│   ├── terminal-service.ts    # node-pty PTY management
│   ├── session-tags.ts        # Tag persistence
│   └── archived-sessions.ts   # Archived session persistence
├── preload/index.ts           # Secure contextBridge API
└── renderer/                  # React UI
    └── src/
        ├── store.ts           # Zustand state management
        ├── hooks.ts           # Event subscriptions
        └── components/        # React components
```

This is a guide, not a full listing. `AGENTS.md` carries the complete module map.

## Getting help

Report problems on [GitHub Issues](https://github.com/FaqFirebase/pi-desktop/issues) and ask questions in [GitHub Discussions](https://github.com/FaqFirebase/pi-desktop/discussions). For documentation, read [README.md](README.md) for an overview and the source under `src/` for implementation details.

## License

By contributing to this project, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
