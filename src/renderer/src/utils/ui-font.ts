/** Treat a font name as one CSS string, never as a CSS family list. */
export function uiFontStack(family: string): string {
  const name = family.trim()
  if (!name) return ''
  const escaped = Array.from(name, (char) => {
    const code = char.charCodeAt(0)
    return char === '"' || char === '\\' || code < 32 || code === 127
      ? `\\${code.toString(16)} `
      : char
  }).join('')
  return `"${escaped}", 'OpenMoji Color', system-ui, sans-serif`
}

export function applyUiFont(family: string): void {
  const stack = uiFontStack(family)
  if (stack) document.documentElement.style.setProperty('--ui-font-family', stack)
  else document.documentElement.style.removeProperty('--ui-font-family')
}
