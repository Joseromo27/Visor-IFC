// Reenvia lo que ocurre dentro del WebView al log de Rust.
//
// Una ventana de Tauri no tiene consola visible, asi que sin esto un fallo en
// el frontend no deja rastro alguno. Importa especialmente para los modelos
// grandes: cuando la conversion falla en el equipo de otra persona, el archivo
// de log es lo unico con lo que se puede trabajar.

import { debug, error, info, warn } from '@tauri-apps/plugin-log'

type Sink = (message: string) => Promise<void>

function format(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function forwardConsoleToRust() {
  const routes: [keyof Console, Sink][] = [
    ['log', info],
    ['info', info],
    ['warn', warn],
    ['error', error],
    ['debug', debug],
  ]

  for (const [method, sink] of routes) {
    const original = console[method] as (...args: unknown[]) => void
    ;(console[method] as unknown) = (...args: unknown[]) => {
      original.apply(console, args)
      // Si el log falla no debe romper a quien lo llamo.
      void sink(args.map(format).join(' ')).catch(() => {})
    }
  }

  window.addEventListener('error', (e) => {
    void error(
      `error no capturado: ${e.message} en ${e.filename}:${e.lineno}:${e.colno}` +
        (e.error?.stack ? `\n${e.error.stack}` : ''),
    ).catch(() => {})
  })

  window.addEventListener('unhandledrejection', (e) => {
    void error(`promesa rechazada sin manejar: ${format(e.reason)}`).catch(() => {})
  })
}
