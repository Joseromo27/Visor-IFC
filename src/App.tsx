import { useCallback, useEffect, useRef, useState } from 'react'
import type { ItemData } from '@thatopen/fragments'
import { getCurrentWebview } from '@tauri-apps/api/webview'

import { ModelTree } from './components/ModelTree'
import { SettingsMenu } from './components/SettingsMenu'
import { Toolbar } from './components/Toolbar'
import { PropertiesPanel } from './components/PropertiesPanel'
import { buildDisplayTree, collectIds, type TreeNode } from './lib/tree'
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
import { Viewer } from './viewer/Viewer'
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

export default function App() {
  const canvasRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Viewer | null>(null)

  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<LoadProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [meta, setMeta] = useState<ModelMeta | null>(null)

  const [roots, setRoots] = useState<TreeNode[]>([])
  const [names, setNames] = useState<Map<number, string>>(new Map())
  const [selected, setSelected] = useState<number | null>(null)
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [itemData, setItemData] = useState<ItemData | null>(null)
  const [loadingProps, setLoadingProps] = useState(false)

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
  const showProperties = useCallback(async (localId: number | null) => {
    setSelected(localId)
    setItemData(null)
    if (localId === null) return

    setLoadingProps(true)
    try {
      setItemData((await viewerRef.current?.getItemData(localId)) ?? null)
    } finally {
      setLoadingProps(false)
    }
  }, [])

  const selectFromViewport = useCallback(
    (localId: number | null) => {
      setSelectedIds(localId === null ? [] : [localId])
      void showProperties(localId)

      // Pulsar donde no hay nada no hacia absolutamente nada, y en un modelo
      // de kilometros los elementos ocupan pocos pixeles: es facil fallar y
      // concluir que la seleccion esta rota. Mejor decirlo.
      setAvisoClic(localId === null)
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

  const openPath = useCallback(
    async (path: string) => {
      const viewer = viewerRef.current
      if (!viewer || busyRef.current) return

      busyRef.current = true
      setBusy(true)
      setError(null)
      setRoots([])
      setNames(new Map())
      setSelected(null)
      setSelectedIds([])
      setItemData(null)
      setProgress({ stage: 'lectura', progress: null })

      try {
        const result = await loadIfc(path, setProgress)

        setProgress({ stage: 'escena', progress: null })
        await viewer.loadModel(result.fragments, {
          encuadrar: ajustesRef.current.encuadrarAlAbrir,
        })
        setRoots(buildDisplayTree(await viewer.getSpatialTree()))

        setMeta({
          name: result.info.name,
          size: result.info.size,
          fromCache: result.fromCache,
          elapsedMs: result.elapsedMs,
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setMeta(null)
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

      const path = event.payload.paths.find((p) =>
        p.toLowerCase().endsWith('.ifc'),
      )
      if (path) void openPath(path)
      else if (event.payload.paths.length > 0) {
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

  // Los nombres llegan por lotes segun se abren nodos del arbol.
  const loadNames = useCallback(async (ids: number[]) => {
    const found = await viewerRef.current?.getNames(ids)
    if (!found || found.size === 0) return
    setNames((prev) => {
      const next = new Map(prev)
      for (const [id, name] of found) next.set(id, name)
      return next
    })
  }, [])

  const handleExpand = useCallback(
    (ids: number[]) => void loadNames(ids),
    [loadNames],
  )

  const handleTreeSelect = useCallback(
    async (node: TreeNode) => {
      const viewer = viewerRef.current
      if (!viewer) return

      // Aislar u ocultar un piso debe alcanzar a todo lo que cuelga de el, no
      // solo al nodo; las propiedades, en cambio, son las del nodo en si.
      setSelectedIds(collectIds(node))
      await viewer.highlight(node.localId)
      await showProperties(node.localId)
    },
    [showProperties],
  )

  const act = (fn: (v: Viewer) => Promise<void>) => () => {
    const viewer = viewerRef.current
    if (viewer) void fn(viewer)
  }

  const hasModel = roots.length > 0
  const hasSelection = selectedIds.length > 0

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
          onAislar={act((v) => v.isolate(selectedIds))}
          onOcultar={act((v) => v.hide(selectedIds))}
          onMostrarTodo={act((v) => v.showAll())}
          onEnfocarSeleccion={act((v) => v.fitToItems(selectedIds))}
          onVistaPanoramica={act((v) => v.resetView())}
          onTransparentar={act((v) => v.setOpacity(selectedIds, ajustes.opacidad))}
          onInvertirTransparencia={act((v) =>
            v.invertOpacity(selectedIds, ajustes.opacidad),
          )}
          onQuitarTransparencia={act((v) => v.resetOpacity())}
          onCambiarOpacidad={(opacidad) => cambiarAjustes({ opacidad })}
          onCambiarNavegacion={(navegacion) => cambiarAjustes({ navegacion })}
          onAbrirAjustes={() => setAjustesAbiertos(true)}
        />

        {meta && (
          <div className="meta" title={meta.name}>
            <strong>{meta.name}</strong>
            <span>
              {formatSize(meta.size)}
              {meta.fromCache
                ? ` - desde cache en ${formatElapsed(meta.elapsedMs)}`
                : ` - convertido en ${formatElapsed(meta.elapsedMs)}`}
            </span>
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
              onSelect={handleTreeSelect}
              onExpand={handleExpand}
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
