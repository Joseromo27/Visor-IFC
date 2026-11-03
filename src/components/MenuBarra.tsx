// Menu desplegable de la barra.
//
// Es la forma en que la barra se repliega cuando la ventana se queda estrecha:
// los mismos grupos de la cinta, pero dentro de un panel que se abre desde su
// boton. Con la ventana ancha no se usa.

import { useEffect, useRef, useState, type ReactNode } from 'react'

interface Props {
  etiqueta: string
  /** Marca el boton como activo; lo usa Medicion mientras se esta midiendo. */
  activo?: boolean
  disabled?: boolean
  titulo?: string
  children: ReactNode
}

export function MenuBarra({
  etiqueta,
  activo = false,
  disabled = false,
  titulo,
  children,
}: Props) {
  const [pedido, setPedido] = useState(false)
  const caja = useRef<HTMLDivElement>(null)

  // Un menu deshabilitado no se abre aunque lo estuviera: si se descarga el
  // modelo con el panel desplegado, lo que queda son controles muertos.
  const abierto = pedido && !disabled

  // Cerrar al pulsar fuera o con Escape. Sin esto, abrir un menu y pulsar en
  // el modelo deja el panel tapando justo la zona donde se acaba de pulsar.
  useEffect(() => {
    if (!abierto) return

    const fuera = (e: PointerEvent) => {
      if (!caja.current?.contains(e.target as Node)) setPedido(false)
    }
    const tecla = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Se queda con la tecla: Escape lo recoge tambien la medicion, para
      // abandonar la medida en curso. Lo que esta abierto por encima es este
      // panel, asi que es el que debe cerrarse, y una sola pulsacion no puede
      // ademas apagar la herramienta en uso.
      e.stopPropagation()
      setPedido(false)
    }

    // En la fase de captura: el lienzo detiene algunos eventos por su cuenta.
    document.addEventListener('pointerdown', fuera, true)
    document.addEventListener('keydown', tecla)
    return () => {
      document.removeEventListener('pointerdown', fuera, true)
      document.removeEventListener('keydown', tecla)
    }
  }, [abierto])

  /**
   * Pulsar una herramienta cierra el panel.
   *
   * En una ventana estrecha el panel tapa justo el modelo sobre el que se
   * acaba de actuar, asi que dejarlo abierto obliga a cerrarlo a mano cada
   * vez. Se exceptuan los controles marcados para quedarse, como el borrado
   * de medidas una por una, donde lo normal es encadenar varias.
   */
  const alPulsar = (e: React.MouseEvent<HTMLDivElement>) => {
    const boton = (e.target as HTMLElement).closest('button')
    if (boton && !boton.dataset.mantener) setPedido(false)
  }

  return (
    <div className="menu" ref={caja}>
      <button
        className={`btn btn-menu${activo ? ' is-activo' : ''}${abierto ? ' is-abierto' : ''}`}
        onClick={() => setPedido((previo) => !previo)}
        disabled={disabled}
        title={titulo}
        aria-expanded={abierto}
        aria-haspopup="true"
      >
        {etiqueta}
        <span className="menu-flecha" aria-hidden="true">
          ▾
        </span>
      </button>

      {abierto && (
        <div className="menu-panel" role="menu" onClick={alPulsar}>
          {children}
        </div>
      )}
    </div>
  )
}
