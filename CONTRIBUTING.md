# Contributing to PI Desktop GUI

Thank you for your interest in contributing! This document explains how to contribute to the project.

## Contributor License Agreement

**Before your first contribution can be merged, you must agree to the [Contributor License Agreement (CLA)](CLA.md).**

The CLA protects both you and the project by:

- Ensuring you have the right to contribute the code
- Granting the project a license to use your contribution
- Protecting against patent claims
- Defining trademark boundaries

By submitting a pull request, you acknowledge that you have read and agree to the CLA.

## How to Contribute

### Reporting Bugs

1. Check [existing issues](https://github.com/FaqFirebase/pi-desktop/issues) first
2. Open a new issue with:
   - Clear title and description
   - Steps to reproduce
   - Expected vs actual behavior
   - Environment (OS, Electron version, PI version)
   - Screenshots if applicable

### Suggesting Features

1. Open a [feature request](https://github.com/FaqFirebase/pi-desktop/issues/new?template=feature_request.md)
2. Describe the use case and expected behavior
3. Explain why this would be useful to other users

### Submitting Code

**Branch policy.** This repository uses two long-lived branches:

- `master` — public-facing docs only (`README.md`, `LICENSE`, `NOTICE`, `CLA.md`, `CONTRIBUTING.md`, `.gitignore`). Do not target PRs here.
- `Dev` — all application source. This is where active development happens. **Target your pull requests against `Dev`.**

Steps:

1. **Fork** the repository
2. **Check out and branch from `Dev`:**
   ```bash
   git checkout Dev
   git pull
   git checkout -b feature/my-feature
   ```
3. **Make your changes** following the coding standards below
4. **Test** your changes thoroughly
5. **Commit** with a clear message:
   ```bash
   git commit -m "feat: add my feature"
   ```
6. **Push** to your fork:
   ```bash
   git push origin feature/my-feature
   ```
7. **Open a pull request against `Dev`** (not `master`)

### Commit Message Format

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:**
- `feat` — New feature
- `fix` — Bug fix
- `docs` — Documentation
- `style` — Formatting (no code change)
- `refactor` — Code restructuring (no behavior change)
- `test` — Adding or updating tests
- `chore` — Build process, dependencies, tooling
- `perf` — Performance improvement

**Examples:**
```
feat(chat): add file attachment support

fix(pi-rpc): handle EPIPE errors gracefully

docs(readme): update installation instructions
```

## Coding Standards

### TypeScript

- Full strict mode enabled
- No `any` types — use proper typing
- Named constants instead of magic numbers
- Async/await over callbacks
- Proper error handling (no empty catch blocks)

### React

- Functional components with hooks
- Zustand for state management
- Tailwind CSS for styling
- No class components

### Electron Security

- `contextIsolation: true`
- `nodeIntegration: false`
- All IPC through preload bridge
- Validate all IPC payloads
- No arbitrary command execution from renderer

### Code Style

- 2-space indentation
- Single quotes for strings
- Semicolons only when required
- Trailing commas in multi-line
- Max line length: 120 characters

## Testing

Before submitting a pull request:

1. **Build succeeds:**
   ```bash
   npm run build
   ```

2. **Type check passes:**
   ```bash
   npm run typecheck
   ```

3. **App launches and works:**
   ```bash
   npm run dev
   ```

4. **No regressions** in existing functionality

## Project Structure

```
src/
├── shared/ipc-contracts.ts    # IPC channel definitions
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
        └── components/        # React components
```

## Getting Help

- **Issues:** [GitHub Issues](https://github.com/FaqFirebase/pi-desktop/issues)
- **Discussions:** [GitHub Discussions](https://github.com/FaqFirebase/pi-desktop/discussions)
- **Documentation:** Read [README.md](README.md) for an overview and the source under `src/` for implementation details.

## License

By contributing to this project, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).

## Acknowledgments

Thank you to all contributors who help make PI Desktop better!
