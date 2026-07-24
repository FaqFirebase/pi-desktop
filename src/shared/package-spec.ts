/**
 * Validation for Pi package specifications typed by the user or supplied by the
 * remote catalog. The spec is forwarded to `pi install/remove <spec>`, which on
 * Windows can run through a `.cmd/.bat/.ps1` shim with `shell:true`. Rejecting
 * shell metacharacters here prevents an install/remove spec from injecting
 * additional commands in that configuration.
 */

const MAX_PACKAGE_SPEC_LENGTH = 200

// First character must be alphanumeric or `@` (scope) — never `-`, so a spec
// can't be parsed as a CLI flag. Remaining characters are limited to those that
// appear in concrete specs: scopes/paths (@ /), exact versions (. - +), protocol
// (:), and word characters. Excludes whitespace and every shell metacharacter
// (including cmd.exe's `^` escape and semver-range chars `~`/`^` we don't need).
const PACKAGE_SPEC_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9@/._:+-]*$/

/** True when `spec` is a safe package specification to hand to the Pi CLI. */
export function isValidPackageSpec(spec: string): boolean {
  return (
    spec.length > 0 &&
    spec.length <= MAX_PACKAGE_SPEC_LENGTH &&
    PACKAGE_SPEC_PATTERN.test(spec)
  )
}
