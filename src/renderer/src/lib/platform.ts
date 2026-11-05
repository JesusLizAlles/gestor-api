// Diferencias de teclado entre macOS y Windows/Linux.

export const isMac = navigator.userAgent.includes('Mac')

const MAC_KEYS: [RegExp, string][] = [
  [/Ctrl\+/g, '⌘'],
  [/Ctrl\b/g, '⌘'],
  [/Alt\+/g, '⌥'],
  [/(Shift|Mayús)\+/g, '⇧'],
  [/Supr/g, '⌫']
]

/** Atajo escrito como en Windows («Ctrl+Enter») tal como se pulsa en esta plataforma. */
export function keys(text: string): string {
  return isMac ? MAC_KEYS.reduce((s, [re, mac]) => s.replace(re, mac), text) : text
}
