// Panel de opciones de la aplicacion.
//
// Es un dialogo modal sencillo en vez de un desplegable: las opciones van a
// crecer (medicion, choques, recorridos) y un menu flotante se queda corto
// enseguida.

import { useEffect, useRef } from 'react'

import {
  ETIQUETAS_NAVEGACION,
  type Ajustes,
  type Navegacion,
  type Tema,
} from '../lib/settings'

interface Props {
  ajustes: Ajustes
  onCambiar: (cambio: Partial<Ajustes>) => void
  onCerrar: () => void
}

const TEMAS: { valor: Tema; etiqueta: string }[] = [
  { valor: 'oscuro', etiqueta: 'Oscuro' },
  { valor: 'claro', etiqueta: 'Claro' },
]

export function SettingsMenu({ ajustes, onCambiar, onCerrar }: Props) {
  const dialogoRef = useRef<HTMLDivElement>(null)

  // Cerrar con Escape: en una ventana de escritorio sin barra de navegador es
  // lo que la gente intenta primero.
  useEffect(() => {
    const alPulsar = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCerrar()
    }
    window.addEventListener('keydown', alPulsar)
    dialogoRef.current?.focus()
    return () => window.removeEventListener('keydown', alPulsar)
  }, [onCerrar])

  return (
    <div className="modal-fondo" onClick={onCerrar}>
      <div
        className="modal"
        ref={dialogoRef}
        tabIndex={-1}
        role="dialog"
        aria-label="Opciones"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-cabecera">
          <h3>Opciones</h3>
          <button className="btn btn-small" onClick={onCerrar}>
            Cerrar
          </button>
        </header>

        <div className="modal-cuerpo">
          <section className="ajuste">
            <h4>Tema</h4>
            <div className="opciones-fila">
              {TEMAS.map(({ valor, etiqueta }) => (
                <button
                  key={valor}
                  className={`btn${ajustes.tema === valor ? ' btn-activo' : ''}`}
                  onClick={() => onCambiar({ tema: valor })}
                >
                  {etiqueta}
                </button>
              ))}
            </div>
            <p className="ajuste-nota">
              Cambia tambien el fondo de la vista 3D para no perder contraste
              con el modelo.
            </p>
          </section>

          <section className="ajuste">
            <h4>Navegacion</h4>
            <div className="opciones-fila">
              {(Object.keys(ETIQUETAS_NAVEGACION) as Navegacion[]).map((modo) => (
                <button
                  key={modo}
                  className={`btn${ajustes.navegacion === modo ? ' btn-activo' : ''}`}
                  onClick={() => onCambiar({ navegacion: modo })}
                >
                  {ETIQUETAS_NAVEGACION[modo]}
                </button>
              ))}
            </div>
            <p className="ajuste-nota">
              Primera persona recorre el modelo a pie; planta bloquea la camara
              mirando desde arriba.
            </p>
          </section>

          <section className="ajuste">
            <h4>Transparencia</h4>
            <label className="deslizador deslizador-ancho">
              <input
                type="range"
                min={5}
                max={95}
                step={5}
                value={Math.round(ajustes.opacidad * 100)}
                onChange={(e) =>
                  onCambiar({ opacidad: Number(e.target.value) / 100 })
                }
                aria-label="Opacidad por defecto"
              />
              <span className="deslizador-valor">
                {Math.round(ajustes.opacidad * 100)}%
              </span>
            </label>
            <p className="ajuste-nota">
              Nivel que aplica el boton Transparentar de la barra.
            </p>
          </section>

          <section className="ajuste">
            <h4>Al abrir un modelo</h4>
            <label className="casilla">
              <input
                type="checkbox"
                checked={ajustes.encuadrarAlAbrir}
                onChange={(e) =>
                  onCambiar({ encuadrarAlAbrir: e.target.checked })
                }
              />
              Encuadrar la vista automaticamente
            </label>
          </section>
        </div>
      </div>
    </div>
  )
}
