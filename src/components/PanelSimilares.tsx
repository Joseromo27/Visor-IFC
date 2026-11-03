// Eleccion de que cuenta como "parecido" antes de aplicar nada.
//
// Se muestran las tres cuentas juntas a proposito. En estos modelos de Istram
// casi todo es IfcBuildingElementProxy, asi que "misma categoria" puede
// significar medio modelo mientras "mismo nombre" son cuarenta elementos; sin
// ver el numero antes, ocultar por categoria parece que borra el proyecto.

import { useState } from 'react'

import type { CriterioSimilar, Ref, ResumenSimilares } from '../viewer/Viewer'

interface Props {
  resumen: ResumenSimilares
  onAplicar: (refs: Ref[], accion: 'seleccionar' | 'aislar' | 'ocultar') => void
  onCerrar: () => void
}

const formatear = (n: number) => n.toLocaleString('es-CL')

export function PanelSimilares({ resumen, onAplicar, onCerrar }: Props) {
  const opciones: {
    criterio: CriterioSimilar
    etiqueta: string
    detalle: string
    refs: Ref[]
    disponible: boolean
  }[] = [
    {
      criterio: 'nombre',
      etiqueta: 'Mismo nombre',
      detalle: resumen.nombre ?? 'el elemento no tiene nombre',
      refs: resumen.porNombre,
      disponible: !!resumen.nombre,
    },
    {
      criterio: 'categoria',
      etiqueta: 'Misma categoria',
      detalle: resumen.categoria ?? 'sin categoria',
      refs: resumen.porCategoria,
      disponible: !!resumen.categoria,
    },
  ]

  const primera = opciones.find((o) => o.disponible)?.criterio ?? 'nombre'
  const [criterio, setCriterio] = useState<CriterioSimilar>(primera)
  const elegida = opciones.find((o) => o.criterio === criterio)
  const refs = elegida?.refs ?? []

  return (
    <div className="modal-fondo" onClick={onCerrar}>
      <div
        className="modal"
        role="dialog"
        aria-label="Seleccionar elementos similares"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-cabecera">
          <h3>Elementos similares</h3>
          <button className="btn btn-small" onClick={onCerrar}>
            Cerrar
          </button>
        </header>

        <div className="modal-cuerpo">
          <p className="modal-sub">
            A partir de{' '}
            <strong>{resumen.nombre ?? 'elemento sin nombre'}</strong>
            {resumen.categoria ? ` (${resumen.categoria})` : ''}
          </p>

          <ul className="opciones-similares">
          {opciones.map((o) => (
            <li key={o.criterio}>
              <label className={o.disponible ? '' : 'is-deshabilitado'}>
                <input
                  type="radio"
                  name="criterio-similar"
                  value={o.criterio}
                  checked={criterio === o.criterio}
                  disabled={!o.disponible}
                  onChange={() => setCriterio(o.criterio)}
                />
                <span className="opcion-texto">
                  <strong>{o.etiqueta}</strong>
                  <span className="opcion-detalle">{o.detalle}</span>
                </span>
                <span className="opcion-cuenta">
                  {formatear(o.refs.length)}
                </span>
              </label>
            </li>
          ))}
          </ul>

          <div className="modal-acciones">
            <button
              className="btn btn-primary"
              disabled={refs.length === 0}
              onClick={() => onAplicar(refs, 'seleccionar')}
            >
              Seleccionar
            </button>
            <button
              className="btn"
              disabled={refs.length === 0}
              onClick={() => onAplicar(refs, 'aislar')}
              title="Deja visibles solo estos"
            >
              Aislar
            </button>
            <button
              className="btn"
              disabled={refs.length === 0}
              onClick={() => onAplicar(refs, 'ocultar')}
            >
              Ocultar
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
