<!--
Thanks for contributing to Pi Desktop!

Before you open this PR, read CONTRIBUTING.md:
https://github.com/FaqFirebase/pi-desktop/blob/master/CONTRIBUTING.md

The two rules people miss most often:
1. PRs must target the `Dev` branch, not `master`.
2. Commit messages follow Conventional Commits: <type>(<scope>): <subject>
-->

## Summary

<!-- What does this PR do, and why? A few sentences are enough. -->

## Related issues

<!-- Link the issues this PR addresses, for example "Closes #123". Write "None" if there are none. -->

## Type of change

<!-- Check all that apply. -->

- [ ] `feat`: New feature
- [ ] `fix`: Bug fix
- [ ] `docs`: Documentation
- [ ] `refactor`: Code restructuring (no behavior change)
- [ ] `test`: Adding or updating tests
- [ ] `chore`: Build process, dependencies, tooling
- [ ] `perf`: Performance improvement
- [ ] `style`: Formatting (no code change)

## How was this tested?

<!--
Describe how you verified the change: manual steps in the app,
new or updated tests, and the platforms you tested (Linux, macOS, Windows).
-->

## Screenshots

<!-- For UI changes, add before and after screenshots. Otherwise, delete this section. -->

## Checklist

- [ ] This PR targets the `Dev` branch (not `master`)
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npx tsx --test` passes
- [ ] `npm run build` succeeds
- [ ] The app launches and works (`npm run dev`) with no regressions
- [ ] Tests added or updated for changed modules (colocated `*.test.ts`)
- [ ] Electron security posture preserved (context isolation, IPC through preload bridge, validated payloads)
- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
- [ ] If AI-assisted, the agent was pointed at [`AGENTS.md`](https://github.com/FaqFirebase/pi-desktop/blob/master/AGENTS.md) and its Final Delivery Checklist
- [ ] I have read and agree to the [CLA](https://github.com/FaqFirebase/pi-desktop/blob/master/CLA.md)
