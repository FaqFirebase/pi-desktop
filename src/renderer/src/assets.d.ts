// Ambient declarations for Vite asset imports (this file is a script, not a
// module, so the wildcard module declaration applies globally). Vite resolves
// an asset import to its served URL (a string).
declare module '*.svg' {
  const src: string
  export default src
}

// `?worker&url` bundles the file as a standalone script and resolves to its URL.
declare module '*?worker&url' {
  const src: string
  export default src
}
