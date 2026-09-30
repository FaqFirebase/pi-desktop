/**
 * Text without terminal color (CSI `m`) and hyperlink (OSC 8) sequences, for
 * engine output written for a terminal but shown in the GUI.
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- strip CSI color / OSC hyperlink sequences
  return text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;[^\x1b]*\x1b\\/g, '')
}
