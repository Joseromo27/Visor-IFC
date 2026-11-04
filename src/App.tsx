import { useCallback, useEffect, useRef, useState } from 'react'
import type { ItemData } from '@thatopen/fragments'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'

import { CapaMediciones } from './components/CapaMediciones'
import { PanelEntregable, type Excluido } from './components/PanelEntregable'
import { Cinta } from './components/Cinta'
import { ModelTree } from './components/ModelTree'
import { PanelSimilares } from './components/PanelSimilares'
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
import {
  claveRef,
  mismaRef,
  Viewer,
  type Medicion,
  type ModeloMontado,
  type ModoVisor,
  type Ref,
  type ResumenSimilares,
  type Vista,
} from './viewer/Viewer'
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

/** Lo que devuelve `depurar_ifc`. */
interface InformeDepuracion {
  eliminados: number
  no_encontrados: string[]
  relaciones_eliminadas: number
  relaciones_reparadas: number
  lineas_borradas: number
  bytes_entrada: number
  bytes_salida: number
  bloqueos: string[]
}

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

  // El mismo visor que la ref, pero en estado: la capa de medidas lo necesita
  // durante el pintado, y una ref no provoca el repintado en que aparece.
  const [visor, setVisor] = useState<Viewer | null>(null)
  const [modo, setModo] = useState<ModoVisor>('seleccion')
  const [mediciones, setMediciones] = useState<Medicion[]>([])
  const [similares, setSimilares] = useState<ResumenSimilares | null>(null)
  const [buscandoSimilares, setBuscandoSimilares] = useState(false)

  // Entregable depurado: lo que se va a quitar del IFC de origen.
  const [excluidos, setExcluidos] = useState<Excluido[]>([])
  const [panelEntregable, setPanelEntregable] = useState(false)
  const [exportando, setExportando] = useState<string | null>(null)
  const [mensaje, setMensaje] = useState<string | null>(null)

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
    // El visor es quien sabe cuando se cierra una medida o se descarga todo;
    // la interfaz solo refleja su lista.
    viewer.onMediciones = (lista) => setMediciones(lista)
    viewer.onSeleccionMultiple = (refs) => {
      setSelectedRefs(refs)
      setSelected(null)
      setItemData(null)
      setAvisoClic(refs.length === 0)
    }
    viewerRef.current = viewer
    setVisor(viewer)
    return () => {
      viewer.dispose()
      viewerRef.current = null
      setVisor(null)
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

  /**
   * Archivos que llegan desde el escritorio: doble clic sobre un .ifc o
   * "Abrir con".
   *
   * Hacen falta los dos caminos. En el arranque en frio el proceso conoce la
   * ruta antes de que la ventana exista, asi que el evento se perderia: esa
   * se pide una vez al montar. Con la aplicacion ya abierta, la segunda
   * instancia reenvia la ruta a esta y llega por evento.
   */
  useEffect(() => {
    const desdeElSistema = (ruta: string, via: string) => {
      // Queda en el log a proposito: si el doble clic no abre nada en el
      // equipo de otra persona, esta linea distingue entre "no llego la ruta"
      // y "llego y la carga fallo", que se arreglan en sitios distintos.
      console.info(`Abriendo desde el sistema (${via}): ${ruta}`)
      void openPath(ruta)
    }

    void invoke<string | null>('archivo_pendiente')
      .then((ruta) => {
        if (ruta) desdeElSistema(ruta, 'arranque')
      })
      .catch((err) => console.warn('No se pudo consultar el archivo inicial', err))

    const suscripcion = listen<string>('abrir-ifc', (evento) => {
      if (evento.payload) desdeElSistema(evento.payload, 'ventana ya abierta')
    })
    return () => {
      void suscripcion.then((cancelar) => cancelar())
    }
  }, [openPath])

  // Solo en modo prueba: permite abrir un archivo sin pasar por el dialogo
  // nativo, que no se puede automatizar. Lo usan tanto la prueba de interfaz
  // como la de capacidad.
  useEffect(() => {
    if (
      !import.meta.env.VITE_SELFTEST_UI &&
      !import.meta.env.VITE_SELFTEST_CARGA
    ) {
      return
    }
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

  // Cerrar tambien toma el guardia de ocupado: sin el, pulsar "Abrir IFC"
  // mientras se descarga un modelo grande arrancaba una carga en paralelo que
  // volvia a descargarlo todo por debajo. Y el estado se limpia en el
  // `finally`, para que un fallo al descargar no deje la barra apagada.
  const handleCerrarTodo = useCallback(async () => {
    const viewer = viewerRef.current
    if (!viewer || busyRef.current) return

    busyRef.current = true
    setBusy(true)
    try {
      await viewer.disposeAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRoots([])
      setNames(new Map())
      setModelos([])
      setOcultos(new Set())
      setSelected(null)
      setSelectedRefs([])
      setItemData(null)
      setMeta(null)
      busyRef.current = false
      setBusy(false)
    }
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

  // La marca roja de lo que queda fuera del entregable la pinta el visor;
  // aqui solo se le pasa la lista cada vez que cambia.
  useEffect(() => {
    void viewerRef.current?.setExcluidos(excluidos.map((e) => e.ref))
  }, [excluidos])

  // --- Vistas, similares y medicion ----------------------------------------

  const handleVista = useCallback(
    (vista: Vista) => {
      // Sin seleccion se encuadra todo lo montado, que es lo util cuando se
      // quiere ver la obra entera en planta.
      void viewerRef.current?.vistaPredeterminada(vista, selectedRefs)
    },
    [selectedRefs],
  )

  const handleBuscarSimilares = useCallback(async () => {
    const viewer = viewerRef.current
    if (!viewer || !selected || buscandoSimilares) return

    setBuscandoSimilares(true)
    try {
      const resumen = await viewer.buscarSimilares(selected)
      if (resumen) setSimilares(resumen)
      else setError('No se pudo analizar ese elemento.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBuscandoSimilares(false)
    }
  }, [selected, buscandoSimilares])

  const handleAplicarSimilares = useCallback(
    (refs: Ref[], accion: 'seleccionar' | 'aislar' | 'ocultar') => {
      const viewer = viewerRef.current
      setSimilares(null)
      if (!viewer) return

      setSelectedRefs(refs)
      void (async () => {
        if (accion === 'aislar') {
          await viewer.isolate(refs)
        } else if (accion === 'ocultar') {
          await viewer.hide(refs)
        }
        setOcultos(
          new Set(
            viewer
              .getModelos()
              .filter((m) => !m.visible)
              .map((m) => m.modelId),
          ),
        )
      })()
    },
    [],
  )

  // --- Entregable depurado -------------------------------------------------

  /** Carpeta del archivo, para proponer el destino al lado del original. */
  const carpetaDe = (ruta: string) => ruta.replace(/[^\\/]+$/, '')

  const handleExcluirSeleccion = useCallback(async () => {
    const viewer = viewerRef.current
    if (!viewer || selectedRefs.length === 0) return

    const guids = await viewer.getGuids(selectedRefs)
    setExcluidos((previos) => {
      const vistos = new Set(previos.map((e) => claveRef(e.ref)))
      const nuevos = selectedRefs
        .filter((r) => !vistos.has(claveRef(r)))
        .map((r) => ({
          ref: r,
          nombre: viewer.getNombre(r),
          guid: guids.get(claveRef(r)) ?? null,
        }))
      return [...previos, ...nuevos]
    })
    // Se abre la revision en el acto: marcar algo para que no llegue al
    // cliente no deberia ser una accion silenciosa.
    setPanelEntregable(true)
  }, [selectedRefs])

  const handleExportarEntregable = useCallback(
    async (modelo: ModeloMontado, lista: Excluido[]) => {
      const sinGuid = lista.filter((e) => !e.guid)
      if (sinGuid.length > 0) {
        setError(
          `${sinGuid.length} de los elementos marcados no tienen GlobalId y no` +
            ' se pueden localizar en el archivo. Quitalos de la lista.',
        )
        return
      }

      const base = modelo.nombre.replace(/\.ifc$/i, '')
      const destino = await save({
        title: 'Guardar entregable depurado',
        defaultPath: `${carpetaDe(modelo.ruta)}${base}_depurado.ifc`,
        filters: [{ name: 'Archivos IFC', extensions: ['ifc'] }],
      })
      if (!destino) return

      setExportando(modelo.modelId)
      setError(null)
      setMensaje(null)
      try {
        const fecha = new Date().toLocaleDateString('es-CL')
        const guids = lista.map((e) => e.guid!)
        const informe = await invoke<InformeDepuracion>('depurar_ifc', {
          origen: modelo.ruta,
          destino,
          guids,
          // Trazabilidad dentro del propio archivo: quien lo reciba tiene que
          // poder ver que es una copia filtrada y de que.
          nota:
            `Generado con Visor IFC el ${fecha} a partir de ${modelo.nombre}.` +
            ` Se quitaron ${guids.length} elementos; el modelo de origen no fue` +
            ` modificado. GlobalId retirados: ${guids.join(' ')}`,
        })

        const noEstaban = informe.no_encontrados.length
        setMensaje(
          `Entregable escrito: ${informe.eliminados} elementos fuera,` +
            ` ${informe.relaciones_reparadas} relaciones ajustadas,` +
            ` ${informe.relaciones_eliminadas} relaciones retiradas.` +
            ` ${formatSize(informe.bytes_salida)} frente a ${formatSize(informe.bytes_entrada)}.` +
            (noEstaban > 0
              ? ` ${noEstaban} de los marcados no estaban en este archivo.`
              : ''),
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setExportando(null)
      }
    },
    [],
  )

  const handleCambiarModo = useCallback((nuevo: ModoVisor) => {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.setModo(nuevo)
    setModo(nuevo)
  }, [])

  // Escape primero abandona la medida a medias y solo despues sale del modo:
  // equivocarse en el segundo punto es mucho mas frecuente que querer salir,
  // y perder la herramienta a la primera obliga a volver al menu cada vez.
  useEffect(() => {
    if (modo !== 'medir') return
    const tecla = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const viewer = viewerRef.current
      if (!viewer) return
      if (viewer.hayMedicionEnCurso()) {
        viewer.cancelarMedicion()
      } else {
        viewer.setModo('seleccion')
        setModo('seleccion')
      }
    }
    window.addEventListener('keydown', tecla)
    return () => window.removeEventListener('keydown', tecla)
  }, [modo])

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
      <header className="barra">
        <div className="toolbar">
          <Toolbar
            ocupado={busy}
            hayModelo={hasModel}
            onAbrir={handleOpen}
            onAnadir={() => void handleAnadir()}
            onCerrarTodo={() => void handleCerrarTodo()}
            onAbrirAjustes={() => setAjustesAbiertos(true)}
          >
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
          </Toolbar>
        </div>

        <Cinta
          ocupado={busy}
          hayModelo={hasModel}
          haySeleccion={hasSelection}
          haySeleccionUnica={selected !== null}
          opacidad={ajustes.opacidad}
          navegacion={ajustes.navegacion}
          modo={modo}
          mediciones={mediciones}
          onVista={handleVista}
          onBuscarSimilares={() => void handleBuscarSimilares()}
          onCambiarModo={handleCambiarModo}
          onBorrarMedicion={(id) => viewerRef.current?.borrarMedicion(id)}
          onBorrarMediciones={() => viewerRef.current?.borrarMediciones()}
          onExcluir={() => void handleExcluirSeleccion()}
          onAbrirEntregable={() => setPanelEntregable(true)}
          excluidos={excluidos.length}
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
        />
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

      {mensaje && (
        <div className="banner banner-ok">
          <span>{mensaje}</span>
          <button className="btn btn-small" onClick={() => setMensaje(null)}>
            Cerrar
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

        <div
          className={`viewport${dragging ? ' is-dragging' : ''}${
            modo === 'medir' || modo === 'ventana' ? ' is-midiendo' : ''
          }`}
        >
          <div ref={canvasRef} className="canvas-host" />

          <CapaMediciones
            viewer={visor}
            activo={mediciones.length > 0 || modo === 'medir'}
          />

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

      {panelEntregable && (
        <PanelEntregable
          excluidos={excluidos}
          modelos={modelos}
          exportando={exportando}
          onQuitar={(ref) =>
            setExcluidos((previos) =>
              previos.filter((e) => !mismaRef(e.ref, ref)),
            )
          }
          onVaciar={() => setExcluidos([])}
          onVer={(refs) => {
            const viewer = viewerRef.current
            if (!viewer) return
            setSelectedRefs(refs)
            void (async () => {
              await viewer.isolate(refs)
              await viewer.fitToItems(refs)
              sincronizarOcultos(viewer)
            })()
          }}
          onExportar={(modelo, lista) =>
            void handleExportarEntregable(modelo, lista)
          }
          onCerrar={() => setPanelEntregable(false)}
        />
      )}

      {similares && (
        <PanelSimilares
          resumen={similares}
          onAplicar={handleAplicarSimilares}
          onCerrar={() => setSimilares(null)}
        />
      )}

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
