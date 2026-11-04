// Revision y exportacion del entregable depurado.
//
// Se revisa antes de exportar a proposito: lo que se va a quitar del archivo
// que se le manda a un cliente no puede depender de recordar que estaba
// seleccionado hace diez minutos. La lista va agrupada por archivo, porque
// cada IFC es su propio entregable y se exporta por separado.

import type { ModeloMontado, Ref } from '../viewer/Viewer'
import { claveRef } from '../viewer/Viewer'

export interface Excluido {
  ref: Ref
  nombre: string | null
  guid: string | null
}

interface Props {
  excluidos: Excluido[]
  modelos: ModeloMontado[]
  /** Archivo que se esta exportando ahora mismo, si hay alguno. */
  exportando: string | null
  onQuitar: (ref: Ref) => void
  onVaciar: () => void
  onVer: (refs: Ref[]) => void
  onExportar: (modelo: ModeloMontado, excluidos: Excluido[]) => void
  onCerrar: () => void
}

export function PanelEntregable({
  excluidos,
  modelos,
  exportando,
  onQuitar,
  onVaciar,
  onVer,
  onExportar,
  onCerrar,
}: Props) {
  const porModelo = modelos
    .map((m) => ({
      modelo: m,
      lista: excluidos.filter((e) => e.ref.modelId === m.modelId),
    }))
    .filter((g) => g.lista.length > 0)

  return (
    <div className="modal-fondo" onClick={onCerrar}>
      <div
        className="modal modal-ancho"
        role="dialog"
        aria-label="Entregable depurado"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-cabecera">
          <h3>Entregable depurado</h3>
          <button className="btn btn-small" onClick={onCerrar}>
            Cerrar
          </button>
        </header>

        <div className="modal-cuerpo">
          {porModelo.length === 0 ? (
            <p className="modal-sub">
              No hay nada marcado. Selecciona en el modelo o en el arbol —
              "Similares" sirve para atrapar una familia entera— y pulsa
              "Excluir seleccion".
            </p>
          ) : (
            porModelo.map(({ modelo, lista }) => (
              <section className="grupo-entregable" key={modelo.modelId}>
                <header className="entregable-cabecera">
                  <div>
                    <strong>{modelo.nombre}</strong>
                    <span className="entregable-cuenta">
                      {lista.length} de {modelo.elementos.toLocaleString('es-CL')}{' '}
                      elementos fuera
                    </span>
                  </div>
                  <div className="entregable-acciones">
                    <button
                      className="btn btn-small"
                      onClick={() => onVer(lista.map((e) => e.ref))}
                      title="Deja a la vista solo lo que se va a quitar"
                    >
                      Ver
                    </button>
                    <button
                      className="btn btn-small btn-primary"
                      disabled={exportando !== null}
                      onClick={() => onExportar(modelo, lista)}
                    >
                      {exportando === modelo.modelId
                        ? 'Exportando...'
                        : 'Exportar IFC...'}
                    </button>
                  </div>
                </header>

                <ul className="lista-excluidos">
                  {lista.map((e) => (
                    <li key={claveRef(e.ref)}>
                      <span className="excluido-nombre">
                        {e.nombre ?? `Elemento ${e.ref.localId}`}
                      </span>
                      <span
                        className="excluido-guid"
                        title={e.guid ?? 'sin GlobalId'}
                      >
                        {e.guid ?? 'sin GlobalId'}
                      </span>
                      <button
                        className="btn btn-small"
                        onClick={() => onQuitar(e.ref)}
                        title="Sacar de la lista: se conservara en el entregable"
                        aria-label="Sacar de la lista"
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}

          <p className="menu-nota">
            El archivo original no se toca: se escribe una copia nueva sin esos
            elementos. Esto acelera el entregable, pero el modelo de origen
            sigue teniendo el error y hay que corregirlo alli.
          </p>

          {excluidos.length > 0 && (
            <div className="modal-acciones">
              <button className="btn" onClick={onVaciar}>
                Vaciar la lista
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
