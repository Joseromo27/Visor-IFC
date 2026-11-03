// Fila superior de la barra: los archivos y las opciones.
//
// Todo lo que se hace sobre un modelo ya abierto vive en la cinta de debajo
// (`Cinta.tsx`). Aqui quedan el punto de partida y el punto de salida, que son
// los que no cambian segun lo que haya montado.

import type { ReactNode } from 'react'

interface Props {
  ocupado: boolean
  hayModelo: boolean

  onAbrir: () => void
  onAnadir: () => void
  onCerrarTodo: () => void
  onAbrirAjustes: () => void

  /** Resumen de lo cargado. Va a la derecha, antes de las opciones. */
  children?: ReactNode
}

export function Toolbar({
  ocupado,
  hayModelo,
  onAbrir,
  onAnadir,
  onCerrarTodo,
  onAbrirAjustes,
  children,
}: Props) {
  return (
    <>
      <button className="btn btn-primary" onClick={onAbrir} disabled={ocupado}>
        Abrir IFC...
      </button>
      <button
        className="btn"
        onClick={onAnadir}
        disabled={!hayModelo || ocupado}
        title="Monta otro IFC junto a los ya abiertos, en su posicion real"
      >
        Anadir IFC...
      </button>
      <button
        className="btn"
        onClick={onCerrarTodo}
        disabled={!hayModelo || ocupado}
        title="Quita todos los modelos montados"
      >
        Cerrar todo
      </button>

      <span className="toolbar-spacer" />

      {children}

      <button className="btn" onClick={onAbrirAjustes} title="Opciones">
        Opciones
      </button>
    </>
  )
}
