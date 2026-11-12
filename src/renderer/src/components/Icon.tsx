// Iconos de trazo (16 px, color del texto) para las barras de herramientas.
const PATHS = {
  plus: <path d="M8 3v10M3 8h10" />,
  minus: <path d="M3 8h10" />,
  chevronDown: <path d="M5 6.5 8 9.5l3-3" />,
  /** Flecha que entra en una bandeja. */
  import: <path d="M8 2.5v7M5 6.5l3 3 3-3M3 10.5v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2" />,
  /** Flecha que sale de una bandeja. */
  export: <path d="M8 9.5v-7M5 5.5l3-3 3 3M3 10.5v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2" />,
  /** Lápiz: editar. */
  edit: <path d="M10.5 3 13 5.5 6 12.5H3.5V10L10.5 3ZM9 4.5 11.5 7" />,
  /** Papelera. */
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4" />,
  /** Avión de papel: enviar la petición. */
  send: <path d="M2.5 7.5 13.5 2.5 9.5 13.5 7.5 9 2.5 7.5ZM7.5 9l6-6.5" />,
  /** Candado: autenticación. */
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>
  ),
  /** Carpeta: grupo de endpoints. */
  folder: <path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-7.5Z" />,
  /** Carpeta con un más: nueva carpeta. */
  folderPlus: (
    <>
      <path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-7.5Z" />
      <path d="M8 7.25v3.5M6.25 9h3.5" />
    </>
  ),
  /** Engranaje: ajustes. */
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05" />
      <circle cx="8" cy="8" r="4.25" />
    </>
  )
}

export type IconName = keyof typeof PATHS

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="svg-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}
