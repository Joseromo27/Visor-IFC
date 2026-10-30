import { useCallback, useEffect, useRef, useState } from 'react'
import type { ItemData } from '@thatopen/fragments'
import { getCurrentWebview } from '@tauri-apps/api/webview'

import { ModelTree } from './components/ModelTree'
import { SettingsMenu } from './components/SettingsMenu'
import { Toolbar } from './components/Toolbar'
import { PropertiesPanel } from './components/PropertiesPanel'
import { collectRefs, modelRoot, type TreeNode } from './lib/tree'
import {
  STAGE_LABELS,
  loadIfc,
  pickIfcFile,
  type LoadProgress,
} from './lib/conversion'
import {
  aplicarTema,
  guardarAjustes,
  leerAjustes,
  type Ajustes,
} from './lib/settings'
import { checkForUpdate, type UpdateInfo } from './lib/updater'
import { claveRef, Viewer, type ModeloMontado, type Ref } from './viewer/Viewer'
import './App.css'

const formatSize = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`

const formatElapsed = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`

/** Duracion legible para esperas largas: "3 min 12 s". */
const formatDuration = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000))
  const min = Math.floor(total / 60)
  const sec = total % 60
  return min > 0 ? `${min} min ${sec} s` : `${sec} s`
}

const formatCount = (n: number) => n.toLocaleString('es-CL')

interface ModelMeta {
  name: string
  size: number
  fromCache: boolean
  elapsedMs: number
}

/** Resumen del ultimo archivo abierto y de cuantos hay montados. */
const resumenCabecera = (meta: ModelMeta, modelos: ModeloMontado[]) =>
  modelos.length > 1
    ? `${modelos.length} modelos montados - ${formatCount(
        modelos.reduce((t, m) => t + m.elementos, 0),
      )} elementos`
    : `${formatSize(meta.size)}${
        meta.fromCache
          ? ` - desde cache en ${formatElapsed(meta.elapsedMs)}`
          : ` - convertido en ${formatElapsed(meta.elapsedMs)}`
      }`

export default function App() {
  const canvasRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Viewer | null>(null)

  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<LoadProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [meta, setMeta] = useState<ModelMeta | null>(null)

  const [roots, setRoots] = useState<TreeNode[]>([])
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [selected, setSelected] = useState<Ref | null>(null)
  const [selectedRefs, setSelectedRefs] = useState<Ref[]>([])
  const [itemData, setItemData] = useState<ItemData | null>(null)
  const [loadingProps, setLoadingProps] = useState(false)

  const [modelos, setModelos] = useState<ModeloMontado[]>([])
  const [ocultos, setOcultos] = useState<Set<string>>(new Set())

  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [updateProgress, setUpdateProgress] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [avisoClic, setAvisoClic] = useState(false)

  const [ajustes, setAjustes] = useState<Ajustes>(() => leerAjustes())
  const [ajustesAbiertos, setAjustesAbiertos] = useState(false)

  // --- Seleccion -----------------------------------------------------------

  // Solo actualiza el panel de propiedades. Quien llama decide que entra en
  // `selectedIds`, porque no es lo mismo un clic en el modelo (un elemento)
  // que un clic en el arbol (un nodo y toda su descendencia).
  const showProperties = useCallback(async (ref: Ref | null) => {
    setSelected(ref)
    setItemData(null)
    if (ref === null) return

    setLoadingProps(true)
    try {
      setItemData((await viewerRef.current?.getItemData(ref)) ?? null)
    } finally {
      setLoadingProps(false)
    }
  }, [])

  const selectFromViewport = useCallback(
    (ref: Ref | null) => {
      setSelectedRefs(ref === null ? [] : [ref])
      void showProperties(ref)

      // Pulsar donde no hay nada no hacia absolutamente nada, y en un modelo
      // de kilometros los elementos ocupan pocos pixeles: es facil fallar y
      // concluir que la seleccion esta rota. Mejor decirlo.
      setAvisoClic(ref === null)
    },
    [showProperties],
  )

  useEffect(() => {
    if (!avisoClic) return
    const t = setTimeout(() => setAvisoClic(false), 2600)
    return () => clearTimeout(t)
  }, [avisoClic])

  // --- Arranque ------------------------------------------------------------

  useEffect(() => {
    if (!canvasRef.current) return
    const viewer = new Viewer()
    viewer.init(canvasRef.current)
    viewer.onSelect = selectFromViewport
    viewerRef.current = viewer
    return () => {
      viewer.dispose()
      viewerRef.current = null
    }
  }, [selectFromViewport])

  useEffect(() => {
    void checkForUpdate().then(setUpdate)
  }, [])

  // Los ajustes se aplican y se guardan juntos: el tema toca el documento y el
  // fondo de la escena, y la navegacion la camara.
  useEffect(() => {
    aplicarTema(ajustes.tema)
    viewerRef.current?.setTheme(ajustes.tema)
    viewerRef.current?.setNavigation(ajustes.navegacion)
    guardarAjustes(ajustes)
  }, [ajustes])

  const cambiarAjustes = useCallback((cambio: Partial<Ajustes>) => {
    setAjustes((previos) => ({ ...previos, ...cambio }))
  }, [])

  // --- Carga de archivos ---------------------------------------------------

  // El guardia va en una ref y no en el estado `busy` para que `openPath`
  // mantenga una identidad estable: la suscripcion de arrastrar y soltar
  // depende de ella y no debe rehacerse cada vez que empieza o acaba una carga.
  const busyRef = useRef(false)

  // Los ajustes se leen por ref dentro de openPath para que la identidad de la
  // funcion no cambie: de ella cuelga la suscripcion de arrastrar y soltar.
  const ajustesRef = useRef(ajustes)
  ajustesRef.current = ajustes

  /**
   * Abre un IFC. Con `anadir` lo monta junto a los que ya estan; sin el,
   * reemplaza lo abierto, que es lo que espera quien solo revisa un archivo.
   */
  const openPath = useCallback(
    async (path: string, anadir = false) => {
      const viewer = viewerRef.current
      if (!viewer || busyRef.current) return

      // Montar dos veces el mismo archivo deja dos copias superpuestas, que
      // ademas aparecen como interferencia perfecta de todo contra todo.
      if (anadir && viewer.modeloDeRuta(path)) {
        setError('Ese archivo ya esta montado.')
        return
      }

      busyRef.current = true
      setBusy(true)
      setError(null)
      setSelected(null)
      setSelectedRefs([])
      setItemData(null)
      if (!anadir) {
        await viewer.disposeAll()
        setRoots([])
        setNames(new Map())
        setModelos([])
        setOcultos(new Set())
      }
      setProgress({ stage: 'lectura', progress: null })

      try {
        const result = await loadIfc(path, setProgress)

        setProgress({ stage: 'escena', progress: null })
        const montado = await viewer.loadModel(result.fragments, {
          nombre: result.info.name,
          ruta: path,
          // Al anadir no se reencuadra: quien monta un segundo modelo suele
          // estar mirando una zona concreta y saltar a la vista general le
          // hace perder el sitio.
          encuadrar: anadir ? false : ajustesRef.current.encuadrarAlAbrir,
        })

        const tree = (await viewer.getSpatialTrees()).find(
          (t) => t.modelId === montado.modelId,
        )
        const raiz = modelRoot(
          montado.modelId,
          montado.nombre,
          tree?.tree ?? null,
        )
        setRoots((previos) => [...previos, raiz])
        setModelos(viewer.getModelos())

        // Un modelo con arbol pero sin nada que dibujar deja el visor en
        // blanco sin decir por que. Pasa cuando la conversion descarta la
        // geometria, y cuesta mucho de diagnosticar si no se avisa.
        if (montado.elementos === 0) {
          setError(
            `${montado.nombre} se abrio sin geometria: tiene estructura pero` +
              ' ningun elemento que mostrar.',
          )
        }

        setMeta({
          name: result.info.name,
          size: result.info.size,
          fromCache: result.fromCache,
          elapsedMs: result.elapsedMs,
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        if (!anadir) setMeta(null)
      } finally {
        busyRef.current = false
        setBusy(false)
        setProgress(null)
      }
    },
    [],
  )

  // Solo en modo prueba de interfaz: permite abrir un archivo sin pasar por
  // el dialogo nativo, que no se puede automatizar.
  useEffect(() => {
    if (!import.meta.env.VITE_SELFTEST_UI) return
    window.__pruebaAbrir = openPath
    window.__pruebaVisor = () => viewerRef.current
    return () => {
      delete window.__pruebaAbrir
      delete window.__pruebaVisor
    }
  }, [openPath])

  const handleOpen = useCallback(async () => {
    const path = await pickIfcFile()
    if (path) await openPath(path)
  }, [openPath])

  const handleAnadir = useCallback(async () => {
    const path = await pickIfcFile()
    if (path) await openPath(path, true)
  }, [openPath])

  const handleCerrarTodo = useCallback(async () => {
    const viewer = viewerRef.current
    if (!viewer || busyRef.current) return
    await viewer.disposeAll()
    setRoots([])
    setNames(new Map())
    setModelos([])
    setOcultos(new Set())
    setSelected(null)
    setSelectedRefs([])
    setItemData(null)
    setMeta(null)
  }, [])

  /**
   * Muestra u oculta un modelo entero desde su fila en el arbol.
   *
   * La llamada al visor va fuera del actualizador de estado a proposito: React
   * invoca los actualizadores dos veces en desarrollo, y un efecto colateral
   * ahi dentro alternaria el modelo dos veces, con lo que el boton pareceria
   * no hacer nada.
   */
  const handleAlternarModelo = useCallback(
    (modelId: string) => {
      const viewer = viewerRef.current
      if (!viewer) return
      const mostrar = ocultos.has(modelId)
      setOcultos((previos) => {
        const siguiente = new Set(previos)
        if (mostrar) siguiente.delete(modelId)
        else siguiente.add(modelId)
        return siguiente
      })
      void viewer.setModelVisible(modelId, mostrar)
    },
    [ocultos],
  )

  // Arrastrar y soltar: el WebView de Tauri entrega rutas reales del sistema
  // de archivos, no objetos File del navegador.
  useEffect(() => {
    // Fuera de Tauri no existe el puente nativo. Se degrada en vez de romper
    // el montaje: asi la interfaz se puede abrir en un navegador para
    // revisarla, que dentro de la ventana de Tauri no hay forma de hacerlo.
    let pending: Promise<() => void> | null = null
    try {
      pending = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === 'over') {
        setDragging(true)
        return
      }
      setDragging(false)
      if (event.payload.type !== 'drop') return

      // Soltar varios IFC a la vez los monta todos: el primero reemplaza lo
      // abierto y los demas se suman. Es la forma natural de pedir una
      // comparacion entre disciplinas sin pasar por el boton de anadir.
      const rutas = event.payload.paths.filter((p) =>
        p.toLowerCase().endsWith('.ifc'),
      )
      if (rutas.length > 0) {
        void (async () => {
          for (const [i, ruta] of rutas.entries()) await openPath(ruta, i > 0)
        })()
      } else if (event.payload.paths.length > 0) {
        setError('El archivo arrastrado no es un .ifc')
      }
      })
    } catch (err) {
      console.warn('Arrastrar y soltar no disponible fuera de Tauri', err)
    }
    return () => {
      void pending?.then((unlisten) => unlisten())
    }
  }, [openPath])

  // --- Acciones ------------------------------------------------------------

  // Los nombres llegan por lotes segun se abren nodos del arbol. Van por
  // modelo porque es como los pide el visor, y se guardan con la clave
  // compuesta: dos archivos distintos repiten los mismos localId.
  const loadNames = useCallback(async (refs: Ref[]) => {
    const viewer = viewerRef.current
    if (!viewer || refs.length === 0) return

    const porModelo = new Map<string, number[]>()
    for (const r of refs) {
      const lista = porModelo.get(r.modelId)
      if (lista) lista.push(r.localId)
      else porModelo.set(r.modelId, [r.localId])
    }

    const encontrados: [string, string][] = []
    for (const [modelId, localIds] of porModelo) {
      for (const [localId, name] of await viewer.getNames(modelId, localIds)) {
        encontrados.push([claveRef({ modelId, localId }), name])
      }
    }
    if (encontrados.length === 0) return

    setNames((prev) => {
      const next = new Map(prev)
      for (const [clave, name] of encontrados) next.set(clave, name)
      return next
    })
  }, [])

  const handleExpand = useCallback(
    (refs: Ref[]) => void loadNames(refs),
    [loadNames],
  )

  const handleTreeSelect = useCallback(
    async (node: TreeNode) => {
      const viewer = viewerRef.current
      if (!viewer) return

      // Aislar u ocultar un piso debe alcanzar a todo lo que cuelga de el, no
      // solo al nodo; las propiedades, en cambio, son las del nodo en si.
      setSelectedRefs(collectRefs(node))
      const ref =
        node.localId !== null
          ? { modelId: node.modelId, localId: node.localId }
          : null
      await viewer.highlight(ref)
      await showProperties(ref)
    },
    [showProperties],
  )

  const act = (fn: (v: Viewer) => Promise<void>) => () => {
    const viewer = viewerRef.current
    if (viewer) void fn(viewer)
  }

  /** Toma del visor que modelos estan ocultos, en vez de suponerlo. */
  const sincronizarOcultos = (v: Viewer) =>
    setOcultos(
      new Set(v.getModelos().filter((m) => !m.visible).map((m) => m.modelId)),
    )

  const hasModel = roots.length > 0
  const hasSelection = selectedRefs.length > 0

  return (
    <div className="app">
      <header className="toolbar">
        <Toolbar
          ocupado={busy}
          hayModelo={hasModel}
          haySeleccion={hasSelection}
          opacidad={ajustes.opacidad}
          navegacion={ajustes.navegacion}
          onAbrir={handleOpen}
          onAnadir={() => void handleAnadir()}
          onCerrarTodo={() => void handleCerrarTodo()}
          onAislar={act(async (v) => {
            await v.isolate(selectedRefs)
            sincronizarOcultos(v)
          })}
          onOcultar={act((v) => v.hide(selectedRefs))}
          onMostrarTodo={act(async (v) => {
            await v.showAll()
            setOcultos(new Set())
          })}
          onEnfocarSeleccion={act((v) => v.fitToItems(selectedRefs))}
          onVistaPanoramica={act(async (v) => {
            await v.resetView()
            setOcultos(new Set())
          })}
          onTransparentar={act((v) =>
            v.setOpacity(selectedRefs, ajustes.opacidad),
          )}
          onInvertirTransparencia={act((v) =>
            v.invertOpacity(selectedRefs, ajustes.opacidad),
          )}
          onQuitarTransparencia={act((v) => v.resetOpacity())}
          onCambiarOpacidad={(opacidad) => cambiarAjustes({ opacidad })}
          onCambiarNavegacion={(navegacion) => cambiarAjustes({ navegacion })}
          onAbrirAjustes={() => setAjustesAbiertos(true)}
        />

        {meta && (
          <div
            className="meta"
            title={modelos.map((m) => m.nombre).join('\n') || meta.name}
          >
            <strong>
              {modelos.length > 1 ? 'Varios modelos' : meta.name}
            </strong>
            <span>{resumenCabecera(meta, modelos)}</span>
          </div>
        )}
      </header>

      {update && (
        <div className="banner">
          <span>
            Hay una version nueva disponible ({update.version}).
            {updateProgress !== null
              ? ` Descargando ${Math.round(updateProgress * 100)}%`
              : ''}
          </span>
          <button
            className="btn btn-small"
            disabled={updateProgress !== null}
            onClick={() => {
              setUpdateProgress(0)
              void update.install((f) => setUpdateProgress(f ?? 0)).catch(
                (err) => {
                  setError(`No se pudo actualizar: ${err}`)
                  setUpdateProgress(null)
                },
              )
            }}
          >
            Actualizar y reiniciar
          </button>
          <button className="btn btn-small" onClick={() => setUpdate(null)}>
            Mas tarde
          </button>
        </div>
      )}

      {error && (
        <div className="banner banner-error">
          <span>{error}</span>
          <button className="btn btn-small" onClick={() => setError(null)}>
            Cerrar
          </button>
        </div>
      )}

      <main className="layout">
        <aside className="panel panel-left">
          <h3>Estructura del modelo</h3>
          <div className="panel-body">
            <ModelTree
              roots={roots}
              selected={selected}
              names={names}
              ocultos={ocultos}
              onSelect={handleTreeSelect}
              onExpand={handleExpand}
              onAlternarModelo={handleAlternarModelo}
            />
          </div>
        </aside>

        <div className={`viewport${dragging ? ' is-dragging' : ''}`}>
          <div ref={canvasRef} className="canvas-host" />

          {!hasModel && !busy && (
            <div className="placeholder">
              <p>Arrastra un archivo .ifc aqui</p>
              <p className="placeholder-sub">o usa el boton Abrir IFC</p>
            </div>
          )}

          {avisoClic && !busy && (
            <div className="aviso-flotante">
              No hay ningun elemento en ese punto. Acercate con la rueda o
              selecciona desde el arbol.
            </div>
          )}

          {busy && progress && (
            <div className="overlay">
              <div className="overlay-card">
                <div className="overlay-head">
                  <h4>{STAGE_LABELS[progress.stage] ?? 'Procesando'}</h4>
                  {progress.ifcClass && (
                    <span className="overlay-class">{progress.ifcClass}</span>
                  )}
                  {progress.progress !== null && (
                    <strong className="overlay-pct">
                      {Math.round(progress.progress * 100)}%
                    </strong>
                  )}
                </div>

                <div className="bar">
                  <div
                    className={`bar-fill${
                      progress.progress === null ? ' is-indeterminate' : ''
                    }`}
                    style={
                      progress.progress !== null
                        ? { width: `${Math.round(progress.progress * 100)}%` }
                        : undefined
                    }
                  />
                </div>

                <dl className="overlay-stats">
                  {progress.totalBytes !== undefined &&
                    progress.bytesRead !== undefined && (
                      <div>
                        <dt>Leido</dt>
                        <dd>
                          {formatSize(progress.bytesRead)} de{' '}
                          {formatSize(progress.totalBytes)}
                        </dd>
                      </div>
                    )}
                  {progress.entities !== undefined && progress.entities > 0 && (
                    <div>
                      <dt>Entidades</dt>
                      <dd>{formatCount(progress.entities)}</dd>
                    </div>
                  )}
                  {progress.elapsedMs !== undefined && (
                    <div>
                      <dt>Transcurrido</dt>
                      <dd>{formatDuration(progress.elapsedMs)}</dd>
                    </div>
                  )}
                  {progress.etaMs != null && (
                    <div>
                      <dt>Restante aprox.</dt>
                      <dd>{formatDuration(progress.etaMs)}</dd>
                    </div>
                  )}
                </dl>

                {progress.progress === null && (
                  <p className="overlay-note">
                    Esto puede tardar varios minutos en modelos grandes.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        <aside className="panel panel-right">
          <h3>Propiedades</h3>
          <div className="panel-body">
            <PropertiesPanel data={itemData} loading={loadingProps} />
          </div>
        </aside>
      </main>

      {ajustesAbiertos && (
        <SettingsMenu
          ajustes={ajustes}
          onCambiar={cambiarAjustes}
          onCerrar={() => setAjustesAbiertos(false)}
        />
      )}
    </div>
  )
}
