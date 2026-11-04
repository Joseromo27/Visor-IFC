// Encapsula todo lo que toca Three.js. Los componentes de React nunca hablan
// con la escena directamente: piden cosas a esta clase y reciben datos planos.

import * as OBC from '@thatopen/components'
import * as FRAGS from '@thatopen/fragments'
import * as THREE from 'three'

import { podarItemData } from '../lib/itemData'
import type { Navegacion, Tema } from '../lib/settings'

/** Worker de fragments copiado a public/ en postinstall. Se usa el archivo
 *  local en vez de `FragmentsManager.getWorker()`, que lo descarga de unpkg:
 *  la aplicacion tiene que funcionar sin conexion. */
const FRAGMENTS_WORKER_URL = '/fragments-worker.mjs'

/**
 * Identifica un elemento cuando hay varios modelos montados.
 *
 * Los `localId` solo son unicos dentro de su modelo: dos IFC distintos tienen
 * elementos con el mismo numero. Desde que se puede montar mas de uno, ningun
 * sitio puede quedarse con el `localId` suelto.
 */
export type Ref = { modelId: string; localId: number }

export const mismaRef = (a: Ref | null, b: Ref | null) =>
  a === b || (!!a && !!b && a.modelId === b.modelId && a.localId === b.localId)

export const claveRef = (r: Ref) => `${r.modelId}:${r.localId}`

/** Inversa de `claveRef`. El modelId no lleva dos puntos, asi que basta con
 *  partir por el ultimo. */
export const desdeClave = (clave: string): Ref => {
  const corte = clave.lastIndexOf(':')
  return {
    modelId: clave.slice(0, corte),
    localId: Number(clave.slice(corte + 1)),
  }
}

/** Agrupa referencias por modelo, que es como hay que pedir casi todo. */
const agrupar = (refs: Ref[]): Map<string, number[]> => {
  const porModelo = new Map<string, number[]>()
  for (const r of refs) {
    const lista = porModelo.get(r.modelId)
    if (lista) lista.push(r.localId)
    else porModelo.set(r.modelId, [r.localId])
  }
  return porModelo
}

/** Fondos de escena por tema. El claro no es blanco puro: con geometria clara
 *  y bordes finos, el blanco se come el contraste. */
const FONDO: Record<Tema, number> = {
  oscuro: 0x1b1f24,
  claro: 0xe8eaed,
}

/**
 * Elementos cuyo color se reemplaza en tema claro.
 *
 * El firme viene de Istram en un naranja que sobre fondo claro no sugiere
 * hormigon. Se identifica por nombre y no por clase porque el IFC no lo
 * distingue: los mismos IfcBuildingElementProxy son firme, terraplen o
 * desmonte segun como los llamo el exportador.
 *
 * En tema oscuro no se toca nada: alli el naranja funciona y es el color que
 * el modelo trae de origen.
 */
const COLORES_TEMA_CLARO: { patron: RegExp; color: number }[] = [
  { patron: /^firme/i, color: 0x4a4e52 },
]

const HIGHLIGHT: FRAGS.MaterialDefinition = {
  color: new THREE.Color(0x2f7de1),
  renderedFaces: FRAGS.RenderedFaces.TWO,
  opacity: 1,
  transparent: false,
}

/** Resalte al pasar el cursor. Distinto del de seleccion a proposito: hay que
 *  poder ver a la vez que hay seleccionado y que se seleccionaria al pulsar. */
const HOVER: FRAGS.MaterialDefinition = {
  color: new THREE.Color(0x8fd0ff),
  renderedFaces: FRAGS.RenderedFaces.TWO,
  opacity: 1,
  transparent: false,
}

/** Marca de lo que no va a salir en el entregable. Rojo: es una exclusion,
 *  no una seleccion, y tiene que leerse como tal de un vistazo. */
const EXCLUIDO: FRAGS.MaterialDefinition = {
  color: new THREE.Color(0xd64545),
  renderedFaces: FRAGS.RenderedFaces.TWO,
  opacity: 1,
  transparent: false,
}

/** Excluido y ademas seleccionado: ni una cosa ni la otra pueden ganar en
 *  silencio, asi que se distingue con un tono propio. */
const EXCLUIDO_SELECCIONADO: FRAGS.MaterialDefinition = {
  color: new THREE.Color(0xff8c42),
  renderedFaces: FRAGS.RenderedFaces.TWO,
  opacity: 1,
  transparent: false,
}

/** Radios en pixeles que se prueban alrededor del cursor si el punto exacto
 *  no toca nada. Sin esto hay que acercarse mucho para poder pulsar algo. */
const RADIOS_TOLERANCIA = [5, 11, 18]

/** Pausa a partir de la cual un giro de rueda cuenta como gesto nuevo y se
 *  vuelve a anclar el zoom. Por encima del amortiguado de la libreria
 *  (`smoothTime` = 0,2 s) para no cortar la animacion anterior a medias. */
const REPOSO_RUEDA = 300

/** Cuanto puede haberse movido el cursor desde que se resolvio el punto para
 *  seguir usandolo como ancla del zoom, en pixeles. */
const TOLERANCIA_ANCLA = 12

/**
 * Vistas predeterminadas.
 *
 * **La vertical de la escena es +Y, no +Z.** El IFC viene con Z hacia arriba,
 * pero web-ifc lo rota al convertir (`makeRotationX(-PI/2)` sobre el
 * emplazamiento absoluto), de modo que dentro del visor Y es la cota y Z es el
 * norte cambiado de signo. Se comprobo contra el propio archivo: el IFC de
 * canales mide 13,5 km en X, 13,0 km en Y y solo 536 m en Z, y en la escena
 * esos 536 m son los de Y.
 *
 * La primera version de estas vistas daba por hecho que la vertical era Z. El
 * resultado no era un error visible sino vistas sin sentido: la "frontal"
 * colocaba la camara debajo de la obra y mostraba el fondo, y la "inferior"
 * salia del reves. De paso le cambiaba el `up` a la camara, con lo que la
 * orbita quedaba girada despues de usarlas.
 */
export type Vista =
  | 'planta'
  | 'inferior'
  | 'frontal'
  | 'posterior'
  | 'izquierda'
  | 'derecha'
  | 'isometrica'

export const ETIQUETAS_VISTA: Record<Vista, string> = {
  planta: 'Planta',
  inferior: 'Inferior',
  frontal: 'Frontal',
  posterior: 'Posterior',
  izquierda: 'Izquierda',
  derecha: 'Derecha',
  isometrica: 'Isometrica',
}

/**
 * Cada vista en coordenadas esfericas de camera-controls, que es como hay que
 * pedirlas para no tocar el `up` de la camara: el acimut gira alrededor de la
 * vertical y el polar mide desde ella, con 0 mirando desde arriba, PI/2 al
 * horizonte y PI desde abajo.
 *
 * Nada de colocar la camara a mano con `lookAt`: mirando en vertical, la
 * direccion de la vista y el `up` se vuelven paralelos y la orientacion queda
 * indefinida. Un pelo de margen en planta e inferior evita ese caso limite,
 * y 0,0001 rad son seis milesimas de grado.
 */
const MARGEN_POLAR = 0.0001
const ISOMETRICO = Math.atan(Math.SQRT1_2)

const VISTAS: Record<Vista, { acimut: number; polar: number }> = {
  planta: { acimut: 0, polar: MARGEN_POLAR },
  inferior: { acimut: 0, polar: Math.PI - MARGEN_POLAR },
  frontal: { acimut: 0, polar: Math.PI / 2 },
  posterior: { acimut: Math.PI, polar: Math.PI / 2 },
  derecha: { acimut: Math.PI / 2, polar: Math.PI / 2 },
  izquierda: { acimut: -Math.PI / 2, polar: Math.PI / 2 },
  isometrica: { acimut: Math.PI / 4, polar: ISOMETRICO },
}

/** Que se busca enganchar al medir, en orden de preferencia. */
const CLASES_ENGANCHE = [
  FRAGS.SnappingClass.POINT,
  FRAGS.SnappingClass.LINE,
  FRAGS.SnappingClass.FACE,
]

/**
 * Ventaja en pixeles de cada clase de enganche.
 *
 * `raycastWithSnapping` devuelve a la vez el vertice, la arista y la cara que
 * hay bajo el cursor. Elegir por distancia a la camara no sirve: lo que se
 * quiere es el que se ve mas cerca de donde se apunta. Se comparan en pantalla
 * y se le da ventaja al vertice sobre la arista que pasa por el, y a la arista
 * sobre la cara, que es el orden en que uno espera que enganche.
 */
const VENTAJA_ENGANCHE: Record<number, number> = {
  [FRAGS.SnappingClass.POINT]: 14,
  [FRAGS.SnappingClass.LINE]: 6,
  [FRAGS.SnappingClass.FACE]: 0,
}

/** Distancia maxima en pantalla para que un enganche cuente. */
const TOLERANCIA_ENGANCHE = 24

/** Color de las mediciones. Elegido para destacar sobre ambos temas. */
const COLOR_MEDICION = 0xffb703

/** Tope de espera para una actualizacion de fragments. Holgado a proposito:
 *  en un modelo de cientos de MB una actualizacion legitima puede tardar
 *  segundos, y pasarse de listo aqui solo adelantaria trabajo a medias. */
const LIMITE_ACTUALIZACION = 20000

type World = OBC.SimpleWorld<
  OBC.SimpleScene,
  OBC.OrthoPerspectiveCamera,
  OBC.SimpleRenderer
>

/** Un modelo montado y lo que hay que recordar de el. */
type Entrada = {
  model: FRAGS.FragmentsModel
  /** Nombre de archivo, para la interfaz. */
  nombre: string
  /** Ruta en disco. Sirve para no montar dos veces el mismo archivo. */
  ruta: string
  /** Ids con geometria, para filtrar encuadres. */
  idsConGeometria: Set<number>
  /** Ids afectados por cada regla de color, resueltos al cargar. */
  idsRecoloreables: number[][]
  /** Si el modelo esta mostrado u oculto entero desde la lista. */
  visible: boolean
  /**
   * Nombre de cada elemento con geometria, resuelto al cargar.
   *
   * Se guarda porque ya se pagaba: las reglas de color los piden todos al
   * montar el modelo. Volver a pedirlos para buscar elementos parecidos
   * costaria lo mismo otra vez, y en un archivo grande eso son segundos.
   */
  nombres: Map<number, string>
  /** Categoria IFC de cada elemento. Se arma la primera vez que hace falta. */
  categorias: Map<number, string> | null
}

/** Una medicion de distancia entre dos puntos. */
export type Medicion = {
  id: number
  a: THREE.Vector3
  b: THREE.Vector3
  /** Distancia en metros. */
  distancia: number
}

/** Una etiqueta de medicion ya proyectada a la pantalla. */
export type EtiquetaMedicion = {
  id: number
  x: number
  y: number
  texto: string
  /** La medicion en curso, que todavia sigue al cursor. */
  provisional: boolean
}

/** Que hace un clic en el visor. */
export type ModoVisor = 'seleccion' | 'medir' | 'ventana'

export type CriterioSimilar = 'nombre' | 'categoria'

/**
 * Lo que se puede seleccionar a partir de un elemento, con su cuenta.
 *
 * Hubo un tercer criterio, "nombre y categoria a la vez". Se quito porque en
 * la practica no aporta: en estos modelos el nombre ya es mas restrictivo que
 * la categoria, asi que la interseccion devolvia casi siempre lo mismo que el
 * nombre solo y lo unico que hacia era una opcion mas que leer.
 */
export type ResumenSimilares = {
  referencia: Ref
  nombre: string | null
  categoria: string | null
  porNombre: Ref[]
  porCategoria: Ref[]
}

/**
 * Nombre sin el numero de orden del final.
 *
 * Istram exporta los elementos numerados ("MARCO 1", "MARCO 2"), asi que
 * comparar el nombre tal cual solo encontraria el propio elemento. Lo que
 * interesa es la familia.
 */
export const baseNombre = (nombre: string) =>
  nombre
    .trim()
    .replace(/[\s_.-]*\d+([.,]\d+)?$/, '')
    .trim()
    .toLowerCase() || nombre.trim().toLowerCase()

/** Distancia en metros, con precision de milimetro. */
export const formatearDistancia = (metros: number) =>
  `${metros.toLocaleString('es-CL', {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  })} m`

export type ModeloMontado = {
  modelId: string
  nombre: string
  ruta: string
  elementos: number
  visible: boolean
}

export class Viewer {
  private components = new OBC.Components()
  private world!: World
  private fragments!: OBC.FragmentsManager
  private modelos = new Map<string, Entrada>()
  private container: HTMLElement | null = null
  private temaActual: Tema = 'oscuro'
  /** Modo de navegacion vigente: la rueda no hace lo mismo en cada uno. */
  private navegacion: Navegacion = 'Orbit'
  /** Elemento seleccionado y elemento bajo el cursor. */
  private seleccionado: Ref | null = null
  private sobrevolado: Ref | null = null
  /** Marcados para no salir en el entregable, por clave compuesta. */
  private excluidos = new Set<string>()
  /** Seleccion multiple viva, la que deja una ventana de seleccion. */
  private marcados = new Set<string>()
  /** Contador para generar identificadores de modelo unicos. */
  private siguienteId = 1

  /**
   * Punto del proyecto que se lleva al origen de la escena.
   *
   * El conversor deja la geometria en las coordenadas absolutas del proyecto
   * (ver `COORDINATE_TO_ORIGIN` en el worker), asi que todos los archivos de
   * un mismo encargo ya comparten sistema y encajan sin tocarlos. Lo unico que
   * hace falta es acercarlos al origen, porque una obra chilena esta a varios
   * millones de metros del cero y a esa distancia la camara y el raton
   * trabajan con numeros incomodos.
   *
   * Lo fija el primer modelo que se monta y **no cambia despues**: es la misma
   * resta para todos, que es justo lo que conserva intactas las posiciones
   * relativas entre archivos.
   */
  private origenComun: THREE.Vector3 | null = null

  /** Se dispara al hacer clic en el modelo. `null` al hacer clic en vacio. */
  onSelect: ((ref: Ref | null) => void) | null = null

  /** Se dispara cuando cambia la lista de mediciones o la que esta en curso. */
  onMediciones: ((mediciones: Medicion[]) => void) | null = null

  // --- Medicion ------------------------------------------------------------

  private modo: ModoVisor = 'seleccion'
  private mediciones: Medicion[] = []
  private siguienteMedicion = 1
  /** Primer punto de la medicion en curso, si ya se marco. */
  private puntoA: THREE.Vector3 | null = null
  /** Punto enganchado bajo el cursor. */
  private puntoCursor: THREE.Vector3 | null = null
  private grupoMedicion = new THREE.Group()
  private materialLinea = new THREE.LineBasicMaterial({
    color: COLOR_MEDICION,
    // Las mediciones se ven a traves del modelo a proposito: medir entre dos
    // caras opuestas es justo el caso en que una de ellas queda detras.
    depthTest: false,
    transparent: true,
  })
  private materialPunto = new THREE.PointsMaterial({
    color: COLOR_MEDICION,
    // En tamano de pantalla y no del mundo: en un modelo de kilometros una
    // esfera de tamano fijo o no se ve o tapa el puente entero.
    size: 9,
    sizeAttenuation: false,
    depthTest: false,
    transparent: true,
  })

  get hasModel() {
    return this.modelos.size > 0
  }

  /** Modelos montados, en orden de montaje. */
  getModelos(): ModeloMontado[] {
    return [...this.modelos.entries()].map(([modelId, e]) => ({
      modelId,
      nombre: e.nombre,
      ruta: e.ruta,
      elementos: e.idsConGeometria.size,
      visible: e.visible,
    }))
  }

  /**
   * GlobalId de cada elemento, que es como se le nombra dentro del IFC.
   *
   * El `localId` solo vale dentro de esta sesion; para tocar el archivo de
   * origen hace falta el GUID, que es lo unico que los dos lados comparten.
   */
  async getGuids(refs: Ref[]): Promise<Map<string, string>> {
    const guids = new Map<string, string>()
    for (const [modelId, localIds] of agrupar(refs)) {
      const entrada = this.modelos.get(modelId)
      if (!entrada) continue
      const lista = await entrada.model.getGuidsByLocalIds(localIds)
      localIds.forEach((localId, i) => {
        const g = lista[i]
        if (g) guids.set(claveRef({ modelId, localId }), g)
      })
    }
    return guids
  }

  /** Nombre ya resuelto de un elemento, para mostrarlo en listas. */
  getNombre(ref: Ref): string | null {
    return this.modelos.get(ref.modelId)?.nombres.get(ref.localId) ?? null
  }

  /** Busca si ya hay montado un archivo con esa ruta. */
  modeloDeRuta(ruta: string): string | null {
    for (const [modelId, e] of this.modelos) if (e.ruta === ruta) return modelId
    return null
  }

  init(container: HTMLElement) {
    this.container = container

    const worlds = this.components.get(OBC.Worlds)
    this.world = worlds.create<
      OBC.SimpleScene,
      OBC.OrthoPerspectiveCamera,
      OBC.SimpleRenderer
    >()

    this.world.scene = new OBC.SimpleScene(this.components)
    this.world.scene.setup()
    this.world.scene.three.background = new THREE.Color(0x1b1f24)

    this.world.renderer = new OBC.SimpleRenderer(this.components, container)
    this.world.camera = new OBC.OrthoPerspectiveCamera(this.components)

    this.components.init()

    this.fragments = this.components.get(OBC.FragmentsManager)
    this.fragments.init(FRAGMENTS_WORKER_URL)

    // Fragments decide que geometria subir a la GPU segun la camara, asi que
    // hay que reevaluar cada vez que la camara se detiene.
    this.world.camera.controls.addEventListener('rest', () => {
      void this.actualizar()
    })

    this.fragments.list.onItemSet.add(({ value: model }) => {
      model.useCamera(this.world.camera.three)
      this.world.scene.three.add(model.object)
      void this.actualizar()
    })

    // Las mediciones se dibujan al final y sin prueba de profundidad, para
    // que no queden enterradas en la geometria que estan midiendo.
    this.grupoMedicion.renderOrder = 999
    this.world.scene.three.add(this.grupoMedicion)

    this.ajustarControles()

    // En captura, antes que camera-controls: el anclaje del zoom tiene que
    // estar puesto cuando la libreria calcule el paso de la rueda. Escuchando
    // despues, el primer tic de cada gesto se daba con la distancia vieja y
    // era justo el que pegaba el salto.
    container.addEventListener('wheel', this.handleWheel, {
      passive: true,
      capture: true,
    })
    // En captura, antes que camera-controls: ver handleVentanaDown.
    container.addEventListener('pointerdown', this.handleVentanaDown, true)
    container.addEventListener('pointermove', this.handleVentanaMove, true)
    container.addEventListener('pointerup', this.handleVentanaUp, true)
    container.addEventListener('pointerdown', this.handlePointerDown)
    container.addEventListener('pointerup', this.handlePointerUp)
    container.addEventListener('pointermove', this.handlePointerMove)
    container.addEventListener('pointerleave', this.handlePointerLeave)
  }

  // Un clic solo cuenta como seleccion si el puntero apenas se movio; de lo
  // contrario, orbitar la camara seleccionaria elementos sin querer.
  private downAt: { x: number; y: number } | null = null

  // El seguimiento del cursor se limita en el tiempo y no se solapa consigo
  // mismo: cada consulta puede costar varios rayos y el raton emite decenas de
  // eventos por segundo. Tampoco se busca mientras la camara se mueve, que es
  // cuando el resultado ya no vale al llegar.
  private ultimoHover = 0
  private hoverEnCurso = false

  private handlePointerMove = (e: PointerEvent) => {
    // Basta con no consultar mientras hay un boton pulsado: orbitar y
    // desplazar requieren mantenerlo, y durante el arrastre el resultado no
    // interesa. No se usa `controls.active`, que con el amortiguado de la
    // libreria se queda practicamente siempre en cierto y lo bloqueaba todo.
    if (!this.hasModel || this.downAt) return

    const ahora = performance.now()
    if (ahora - this.ultimoHover < 90 || this.hoverEnCurso) return
    this.ultimoHover = ahora
    this.hoverEnCurso = true

    void (async () => {
      try {
        const dom = this.world.renderer!.three.domElement
        if (this.modo === 'medir') {
          // Midiendo no se resalta nada: lo que se sigue es el punto
          // enganchado, y resaltar ademas el elemento bajo el cursor llena la
          // pantalla de azul justo cuando hay que mirar un vertice.
          const enganche = await this.puntoEnganchado(e.clientX, e.clientY, dom)
          this.puntoCursor = enganche?.punto ?? null
          this.recordarImpacto(e, enganche?.punto ?? null)
          this.redibujarMediciones()
          return
        }
        const hit = await this.buscarBajoCursor(
          new THREE.Vector2(e.clientX, e.clientY),
          dom,
        )
        this.recordarImpacto(e, hit?.point ?? null)
        await this.setHover(hit ? refDe(hit) : null)
      } finally {
        this.hoverEnCurso = false
      }
    })()
  }

  // --- Seleccion por ventana ------------------------------------------------

  /** Esquina donde empezo el arrastre, y el rectangulo que lo dibuja. */
  private ventanaDesde: { x: number; y: number } | null = null
  private cajaVentana: HTMLDivElement | null = null

  /** Se dispara con lo que atrapa una ventana de seleccion. */
  onSeleccionMultiple: ((refs: Ref[]) => void) | null = null

  /**
   * Arranca una ventana de seleccion si toca.
   *
   * Va en fase de captura y detiene el evento: camera-controls escucha en el
   * lienzo, que esta por debajo, y si el evento le llega empieza a orbitar
   * mientras se dibuja el rectangulo.
   *
   * Se activa con el modo de la cinta o manteniendo Mayusculas, que es el
   * atajo que espera quien ya trabaja con esto a diario.
   */
  private handleVentanaDown = (e: PointerEvent) => {
    if (e.button !== 0 || !this.hasModel) return
    if (this.modo !== 'ventana' && !e.shiftKey) return

    e.stopPropagation()
    e.preventDefault()
    this.ventanaDesde = { x: e.clientX, y: e.clientY }

    if (!this.cajaVentana && this.container) {
      const caja = document.createElement('div')
      caja.className = 'ventana-seleccion'
      this.container.appendChild(caja)
      this.cajaVentana = caja
    }
    this.dibujarVentana(e.clientX, e.clientY)
  }

  private handleVentanaMove = (e: PointerEvent) => {
    if (!this.ventanaDesde) return
    e.stopPropagation()
    this.dibujarVentana(e.clientX, e.clientY)
  }

  private handleVentanaUp = (e: PointerEvent) => {
    const desde = this.ventanaDesde
    if (!desde) return
    e.stopPropagation()
    this.ventanaDesde = null
    if (this.cajaVentana) this.cajaVentana.style.display = 'none'

    const ancho = Math.abs(e.clientX - desde.x)
    const alto = Math.abs(e.clientY - desde.y)
    // Un arrastre de dos pixeles es un clic con pulso, no una ventana.
    if (ancho < 5 || alto < 5) return

    void this.atraparEnVentana(
      new THREE.Vector2(Math.min(desde.x, e.clientX), Math.min(desde.y, e.clientY)),
      new THREE.Vector2(Math.max(desde.x, e.clientX), Math.max(desde.y, e.clientY)),
    )
  }

  private dibujarVentana(x: number, y: number) {
    const caja = this.cajaVentana
    const desde = this.ventanaDesde
    if (!caja || !desde || !this.container) return
    const r = this.container.getBoundingClientRect()
    caja.style.display = 'block'
    caja.style.left = `${Math.min(desde.x, x) - r.left}px`
    caja.style.top = `${Math.min(desde.y, y) - r.top}px`
    caja.style.width = `${Math.abs(x - desde.x)}px`
    caja.style.height = `${Math.abs(y - desde.y)}px`
  }

  /**
   * Que elementos caen dentro de la ventana.
   *
   * `fullyIncluded: false` a proposito: en obra lineal casi nada cabe entero
   * en pantalla, y exigirlo haria que una ventana sobre un muro largo no
   * atrapara nada. Vale con que la ventana lo toque.
   */
  private async atraparEnVentana(
    topLeft: THREE.Vector2,
    bottomRight: THREE.Vector2,
  ) {
    const dom = this.world.renderer?.three.domElement
    if (!dom) return

    const camera = this.world.camera.three
    const refs: Ref[] = []
    for (const [modelId, entrada] of this.modelos) {
      if (!entrada.visible) continue
      const r = await entrada.model.rectangleRaycast({
        camera,
        dom,
        topLeft,
        bottomRight,
        fullyIncluded: false,
      })
      for (const localId of r?.localIds ?? []) refs.push({ modelId, localId })
    }

    this.seleccionado = null
    await this.setMarcados(refs)
    this.onSeleccionMultiple?.(refs)
  }

  /** Momento del ultimo giro de rueda, para distinguir gestos. */
  private ultimaRueda = 0

  /**
   * Ultimo punto resuelto bajo el cursor, con la posicion de pantalla en la
   * que se resolvio. Lo llena el seguimiento del cursor, que ya tira el rayo.
   */
  private ultimoImpacto: {
    x: number
    y: number
    punto: THREE.Vector3
  } | null = null

  /**
   * Ancla el zoom en la profundidad de lo que hay bajo el cursor.
   *
   * La rueda de camera-controls es geometrica: cada tic multiplica por un
   * factor fijo la distancia al objetivo. El paso vale, por tanto, lo que
   * valga esa distancia, y si el objetivo esta en el centro del proyecto
   * —que es donde lo deja un encuadre general— uno avanza a razon de cientos
   * de metros mientras mira un sumidero a dos. Poniendo el objetivo en lo que
   * hay bajo el cursor, el avance pasa a ser la misma fraccion de lo que uno
   * tiene delante tanto de lejos como de cerca.
   *
   * Dos cosas que costaron una version:
   *
   * El punto sale de lo ya resuelto al pasar el cursor por encima, no de un
   * rayo nuevo. El rayo nuevo tarda decenas de milisegundos y llegaba con el
   * zoom ya en marcha; `setOrbitPoint` reescribe la distancia al objetivo de
   * golpe, asi que aterrizar a mitad de un gesto cortaba en seco la animacion
   * en curso. Ese era el rebote.
   *
   * Y por lo mismo solo se reancla al empezar un gesto, con la animacion
   * anterior ya terminada: dentro de un gesto hay que converger al punto que
   * se eligio al empezarlo.
   */
  private handleWheel = (e: WheelEvent) => {
    const ahora = performance.now()
    const quieta = ahora - this.ultimaRueda > REPOSO_RUEDA
    this.ultimaRueda = ahora
    if (!quieta || !this.hasModel) return
    // En primera persona la rueda no es un zoom, es la marcha adelante.
    if (this.navegacion === 'FirstPerson') return

    const ancla = this.anclaZoom(e.clientX, e.clientY)
    if (ancla) {
      this.world.camera.controls.setOrbitPoint(ancla.x, ancla.y, ancla.z)
    }
  }

  /**
   * Donde converge el zoom, o `null` para dejar el objetivo donde este.
   *
   * Apuntando a geometria, a esa geometria. Apuntando al vacio no se reancla:
   * el objetivo que haya es lo ultimo que se miro y es la referencia menos
   * sorprendente. Solo se rescata el caso en que el objetivo se ha quedado
   * pegado a la camara, que es cuando la rueda deja de servir —cada tic
   * recorta una fraccion de nada— y hay que empujarlo hacia delante.
   */
  private anclaZoom(x: number, y: number): THREE.Vector3 | null {
    const camara = this.world.camera.three
    const ultimo = this.ultimoImpacto
    if (ultimo && Math.hypot(ultimo.x - x, ultimo.y - y) < TOLERANCIA_ANCLA) {
      const vista = camara.getWorldDirection(new THREE.Vector3())
      const hacia = ultimo.punto.clone().sub(camara.position)
      // Si entretanto la camara ha girado y el punto ha quedado detras, ya no
      // sirve de referencia.
      if (hacia.dot(vista) > 0) return ultimo.punto.clone()
    }

    const caja = this.cajaTotal()
    const diagonal = caja.isEmpty()
      ? 100
      : caja.getSize(new THREE.Vector3()).length()
    const minima = Math.max(diagonal * 0.001, 0.5)
    if (this.world.camera.controls.distance >= minima) return null

    const rayo = this.rayoDesde(x, y)
    if (!rayo) return null
    return camara.position.clone().addScaledVector(rayo.ray.direction, minima)
  }

  /** Rayo que sale de la camara por el punto de pantalla indicado. */
  private rayoDesde(x: number, y: number): THREE.Raycaster | null {
    const dom = this.world.renderer?.three.domElement
    if (!dom) return null
    const r = dom.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((x - r.left) / r.width) * 2 - 1,
      -((y - r.top) / r.height) * 2 + 1,
    )

    const rayo = new THREE.Raycaster()
    rayo.setFromCamera(ndc, this.world.camera.three)
    return rayo
  }

  private handlePointerLeave = () => {
    this.ultimoImpacto = null
    if (this.modo === 'medir') {
      this.puntoCursor = null
      this.redibujarMediciones()
      return
    }
    void this.setHover(null)
  }

  /** Guarda donde cayo el rayo, para que la rueda no tenga que repetirlo. */
  private recordarImpacto(e: PointerEvent, punto: THREE.Vector3 | null) {
    this.ultimoImpacto = punto
      ? { x: e.clientX, y: e.clientY, punto: punto.clone() }
      : null
  }

  private handlePointerDown = (e: PointerEvent) => {
    this.downAt = { x: e.clientX, y: e.clientY }
  }

  private handlePointerUp = (e: PointerEvent) => {
    const from = this.downAt
    this.downAt = null
    if (!from || !this.hasModel) return

    const moved = Math.hypot(e.clientX - from.x, e.clientY - from.y)
    if (moved > 4) {
      // Orbitar o desplazar mueve la camara sin que el cursor cambie de sitio:
      // lo que se habia resuelto bajo el ya no esta debajo.
      this.ultimoImpacto = null
      return
    }

    if (this.modo === 'medir') {
      void this.marcarPunto(e)
      return
    }
    void this.pick(e)
  }

  /**
   * Lanza un rayo contra todos los modelos y devuelve el impacto mas cercano.
   *
   * Hay que preguntar modelo por modelo: fragments no cruza modelos en un solo
   * rayo. Se queda el mas cercano a la camara, que es el que esta visualmente
   * encima, y no el del primer modelo que conteste.
   */
  private async tirarRayo(
    x: number,
    y: number,
    dom: HTMLCanvasElement,
  ): Promise<FRAGS.RaycastResult | null> {
    const camera = this.world.camera.three
    const mouse = new THREE.Vector2(x, y)
    const impactos = (
      await Promise.all(
        [...this.modelos.values()]
          .filter((e) => e.visible)
          .map((e) => e.model.raycast({ camera, mouse, dom })),
      )
    ).filter((r): r is FRAGS.RaycastResult => !!r)

    if (impactos.length === 0) return null
    return impactos.reduce((a, b) => (a.distance <= b.distance ? a : b))
  }

  /**
   * Busca elemento bajo un punto de pantalla, ensanchando la busqueda.
   *
   * El rayo exacto exige acertar al pixel y en obra lineal los elementos son
   * muy finos en pantalla: medido sobre el modelo de canales, hacia falta
   * acercarse mucho para poder pulsar algo. Si el punto exacto falla se
   * prueban anillos crecientes y se queda el impacto mas cercano a la camara,
   * que es el que esta visualmente encima.
   *
   * Lo usan tanto el cursor como el clic, a proposito: lo que se resalta al
   * pasar por encima tiene que ser exactamente lo que se seleccionaria.
   */
  private async buscarBajoCursor(
    mouse: THREE.Vector2,
    dom: HTMLCanvasElement,
  ): Promise<FRAGS.RaycastResult | null> {
    // `mouse` va en coordenadas de ventana (clientX/clientY), sin restarle la
    // posicion del lienzo: fragments ya le resta su getBoundingClientRect por
    // dentro. Restarsela aqui tambien desplazaba el punto probado el ancho del
    // panel lateral, y habia que apuntar a la derecha del objeto para tocarlo.
    if (!this.hasModel) return null

    const exacto = await this.tirarRayo(mouse.x, mouse.y, dom)
    if (exacto) return exacto

    const angulos = [0, 45, 90, 135, 180, 225, 270, 315]
    for (const radio of RADIOS_TOLERANCIA) {
      const impactos = (
        await Promise.all(
          angulos.map((g) => {
            const rad = (g * Math.PI) / 180
            return this.tirarRayo(
              mouse.x + Math.cos(rad) * radio,
              mouse.y + Math.sin(rad) * radio,
              dom,
            )
          }),
        )
      ).filter((r): r is FRAGS.RaycastResult => !!r)

      if (impactos.length > 0) {
        return impactos.reduce((a, b) => (a.distance <= b.distance ? a : b))
      }
    }
    return null
  }

  private async pick(e: PointerEvent) {
    if (!this.container || !this.hasModel) return

    const dom = this.world.renderer!.three.domElement
    const mouse = new THREE.Vector2(e.clientX, e.clientY)

    const hit = await this.buscarBajoCursor(mouse, dom)

    // El punto exacto del clic pasa a ser el centro de giro y de zoom, sin
    // mover la camara. En un modelo de kilometros es la diferencia entre
    // acercarse a lo que miras y alejarte hacia el centro del proyecto.
    //
    // `setOrbitPoint` no debe ejecutarse mientras la camara esta animando, de
    // ahi la comprobacion: durante un encuadre en curso deja las posiciones
    // inconsistentes.
    const controles = this.world.camera.controls
    if (hit && !controles.active) {
      controles.setOrbitPoint(hit.point.x, hit.point.y, hit.point.z)
    }

    const ref = hit ? refDe(hit) : null
    await this.highlight(ref)
    this.onSelect?.(ref)
  }

  /**
   * Monta un modelo mas sin quitar los que ya estan.
   *
   * Devuelve el identificador asignado, que es con lo que se le habla a partir
   * de ahi. Se genera aqui y no se usa la ruta como clave para que sea corto y
   * para que no dependa de como escriba una ruta el sistema de archivos.
   */
  async loadModel(
    fragments: Uint8Array,
    opciones: { nombre: string; ruta: string; encuadrar?: boolean },
  ): Promise<ModeloMontado> {
    // fragments se queda con el ArrayBuffer, asi que tiene que ser uno propio y
    // completo. El que llega del worker ya lo es (viene transferido, no
    // copiado), y copiarlo igualmente duplicaria mas de 100 MB en un modelo
    // grande; solo se copia si resulta ser una vista parcial de otro buffer.
    const esBufferCompleto =
      fragments.byteOffset === 0 &&
      fragments.byteLength === fragments.buffer.byteLength

    const buffer = esBufferCompleto
      ? (fragments.buffer as ArrayBuffer)
      : (fragments.slice().buffer as ArrayBuffer)

    const modelId = `m${this.siguienteId++}`

    const model = await this.fragments.core.load(buffer, {
      modelId,
      camera: this.world.camera.three,
    })

    this.coordinar(model)

    const entrada: Entrada = {
      model,
      nombre: opciones.nombre,
      ruta: opciones.ruta,
      idsConGeometria: new Set(await model.getItemsIdsWithGeometry()),
      idsRecoloreables: [],
      visible: true,
      nombres: new Map(),
      categorias: null,
    }
    this.modelos.set(modelId, entrada)

    await this.resolverRecoloreables(entrada)
    this.adjustCameraPlanes()
    this.ajustarControles()
    await this.aplicarColoresDeTema(this.temaActual)
    await this.actualizar()
    if (opciones.encuadrar !== false) await this.fitToModel()

    return {
      modelId,
      nombre: entrada.nombre,
      ruta: entrada.ruta,
      elementos: entrada.idsConGeometria.size,
      visible: entrada.visible,
    }
  }

  /**
   * Acerca un modelo al origen de la escena, sin alterar su posicion relativa.
   *
   * No se usa `getCoordinationMatrix()` de la libreria. Ese camino exige
   * deshacer, por cada archivo, el desplazamiento que web-ifc le aplico al
   * acercarlo al origen, y equivocar el sentido de esa resta no salta a la
   * vista: daba 277 m de separacion entre dos modelos que estan a 2108, que es
   * una cifra perfectamente creible. Aqui la geometria ya llega en
   * coordenadas del proyecto, asi que no hay nada que deshacer y basta con
   * restarles a todos el mismo vector: la alineacion sale exacta por
   * construccion y se puede contrastar contra el propio IFC.
   *
   * Se escribe sobre `object`, que es lo que miran tanto el dibujado como el
   * rayo y las cajas, asi que la seleccion sigue cayendo donde se ve el
   * elemento.
   */
  private coordinar(model: FRAGS.FragmentsModel) {
    if (!this.origenComun) {
      const caja = model.box
      if (caja.isEmpty()) return
      this.origenComun = caja.getCenter(new THREE.Vector3())
    }
    model.object.position.copy(this.origenComun).negate()
    model.object.updateMatrixWorld(true)
  }

  /** Caja que engloba todos los modelos montados. */
  private cajaTotal(): THREE.Box3 {
    const total = new THREE.Box3()
    total.makeEmpty()
    for (const { model } of this.modelos.values()) {
      const box = model.box
      if (!box.isEmpty()) total.union(box)
    }
    return total
  }

  /**
   * Pone los limites de la camara a la escala de lo que hay montado.
   *
   * @thatopen configura los controles para edificios, y los rehace cada vez
   * que se cambia de modo de navegacion: distancia al objetivo entre 1 y
   * **300 m**, con `infinityDolly` para que la rueda siga haciendo algo mas
   * alla de ese tope. En obra lineal eso rompe dos cosas a la vez.
   *
   * La vista panoramica, porque encuadrar un corredor de kilometros exige
   * poner la camara a miles de metros del centro y el encuadre se recortaba a
   * 300: el boton dejaba la camara mirando un trozo del proyecto, no el
   * proyecto.
   *
   * Y la rueda, porque pasado ese tope `infinityDolly` deja de acercar la
   * camara y lo que hace es empujar el objetivo. El paso deja de ser
   * proporcional a lo que uno tiene delante y pasa a serlo a los 300 m del
   * tope: a dos metros de un muro, cada tic daba un salto de decenas de
   * metros y lo atravesaba. De ahi los saltos y que el elemento se quedara
   * fuera de la vista.
   *
   * El tope pasa a ser cuatro veces la diagonal de lo montado: holgado para
   * encuadrarlo entero —hace falta cerca de una diagonal— y dentro del plano
   * lejano, que se calcula a cinco.
   *
   * En primera persona no se tocan: ese modo esta construido justamente sobre
   * el tope fijo y `infinityDolly`, que es como la rueda hace avanzar.
   */
  private ajustarControles() {
    const controles = this.world.camera.controls
    if (this.navegacion === 'FirstPerson') {
      controles.infinityDolly = true
      controles.dollyToCursor = true
      return
    }

    const caja = this.cajaTotal()
    const diagonal = caja.isEmpty()
      ? 1000
      : caja.getSize(new THREE.Vector3()).length()

    // La minima de la libreria (6 m) ahoga el zoom de cerca: la camara se topa
    // con ella y el avance proporcional se queda en centimetros por tic.
    controles.minDistance = 0.01
    controles.maxDistance = Math.max(1000, diagonal * 4)
    controles.infinityDolly = false
    // El anclaje al cursor lo lleva esta clase (ver handleWheel) y no la
    // libreria. La suya lleva una contabilidad propia del zoom pendiente que
    // se corrompe en cuanto alguien mueve el objetivo por su cuenta —que es
    // lo que hace cada clic— y el sintoma es justamente un salto.
    controles.dollyToCursor = false
  }

  /**
   * Ajusta los planos de recorte al tamano real de lo montado.
   *
   * Las camaras de @thatopen/components nacen con `far = 1000`, pensado para
   * edificios. Un modelo de obra lineal mide kilometros: al encuadrarlo entero
   * la camara queda a mas de 10 km y todo lo que pasa de 1000 m desaparece, asi
   * que el visor muestra dos hilos sueltos en vez del corredor completo.
   *
   * `near` se escala tambien, pero se mantiene pequeno para poder acercarse a
   * un elemento concreto sin que se recorte; la razon far/near queda en torno a
   * 1e5, dentro de lo que el buffer de profundidad tolera sin z-fighting
   * apreciable.
   */
  private adjustCameraPlanes() {
    const box = this.cajaTotal()
    if (box.isEmpty()) return

    const diagonal = box.getSize(new THREE.Vector3()).length()
    const far = Math.max(1000, diagonal * 5)
    const near = Math.min(1, Math.max(0.05, diagonal / 50000))

    for (const camera of [
      this.world.camera.threePersp,
      this.world.camera.threeOrtho,
    ]) {
      camera.near = near
      camera.far = far
      camera.updateProjectionMatrix()
    }
  }

  /**
   * Pide a fragments que aplique el trabajo pendiente. **Ningun sitio llama a
   * `core.update` directamente**, por dos razones.
   *
   * La primera es un cuelgue real: la espera forzada de la libreria se
   * resuelve cuando el worker devuelve un aviso de fin sellado con un numero
   * de secuencia igual o mayor al de la ultima peticion enviada. Al quitar el
   * ultimo modelo, la libreria le pide al worker que lo borre y acto seguido
   * **termina el worker**, asi que ese aviso no llega jamas y la espera queda
   * pendiente para siempre. Sin modelos montados tampoco hay nada que
   * actualizar, de modo que la llamada se omite.
   *
   * La segunda es que una actualizacion que no vuelve no puede dejar la
   * aplicacion inservible: aunque quede algun modelo, la espera lleva limite.
   * Pasado el limite se sigue adelante; el trabajo del worker continua por su
   * cuenta y, como mucho, la escena tarda un instante mas en reflejarlo.
   */
  private async actualizar() {
    if (this.modelos.size === 0) return
    let aTiempo = false
    await Promise.race([
      this.fragments.core.update(true).then(() => {
        aTiempo = true
      }),
      new Promise<void>((listo) => setTimeout(listo, LIMITE_ACTUALIZACION)),
    ])
    if (!aTiempo) {
      console.warn(
        `La actualizacion de fragments no termino en ${LIMITE_ACTUALIZACION} ms;` +
          ' se continua sin esperarla.',
      )
    }
  }

  /**
   * Fuerza la reevaluacion de que geometria sube a la GPU. Es lo que dispara
   * el evento `rest` de la camara al terminar un encuadre, pero alli va sin
   * esperar: si tarda, la ventana se queda sin responder y no hay forma de
   * atribuirlo. Expuesto para poder medirlo.
   */
  async forceUpdate() {
    await this.actualizar()
  }

  /** Posicion y distancia al objetivo de la camara. Para diagnostico. */
  getCameraState() {
    const c = this.world.camera.three
    const controls = this.world.camera.controls
    const objetivo = controls.getTarget(new THREE.Vector3())
    return {
      posicion: c.position.clone(),
      objetivo,
      distancia: c.position.distanceTo(objetivo),
      /** Vertical de la camara. Las vistas no deben cambiarla. */
      arriba: c.up.clone(),
    }
  }

  /**
   * Cuanto se sale de la pantalla lo montado, en coordenadas normalizadas:
   * 1 es justo el borde y por debajo de 1 cabe entero. Devuelve 99 si alguna
   * esquina queda detras de la camara o pasado el plano lejano.
   *
   * Es la forma de comprobar que un encuadre encuadra de verdad. Mirar solo
   * la distancia no vale: la libreria la recorta a su tope y la camara se
   * queda corta sin decirlo.
   */
  getDesborde(): number {
    const caja = this.cajaTotal()
    if (caja.isEmpty()) return 0

    const camara = this.world.camera.three
    camara.updateMatrixWorld()
    let peor = 0
    for (let i = 0; i < 8; i++) {
      const esquina = new THREE.Vector3(
        i & 1 ? caja.max.x : caja.min.x,
        i & 2 ? caja.max.y : caja.min.y,
        i & 4 ? caja.max.z : caja.min.z,
      ).project(camara)
      if (esquina.z < -1 || esquina.z > 1) return 99
      peor = Math.max(peor, Math.abs(esquina.x), Math.abs(esquina.y))
    }
    return peor
  }

  /** Caja de todo lo montado. Para diagnostico y para las pruebas. */
  getCajaTotal(): THREE.Box3 {
    return this.cajaTotal()
  }

  /** Planos de recorte vigentes. Para diagnostico. */
  getCameraPlanes() {
    const c = this.world.camera.three
    return { near: c.near, far: c.far }
  }

  /** Quita un modelo de la escena. */
  async disposeModel(modelId: string) {
    if (!this.modelos.has(modelId)) return
    await this.fragments.core.disposeModel(modelId)
    this.modelos.delete(modelId)
    if (this.seleccionado?.modelId === modelId) this.seleccionado = null
    if (this.sobrevolado?.modelId === modelId) this.sobrevolado = null
    // El origen comun lo fijo el primer modelo. Si no queda ninguno se olvida,
    // para que el siguiente vuelva a fijarlo; mientras quede alguno se
    // conserva, o los que siguen montados saltarian de sitio.
    if (this.modelos.size === 0) this.origenComun = null
    this.adjustCameraPlanes()
    this.ajustarControles()
    await this.actualizar()
  }

  /** Quita todos los modelos. */
  async disposeAll() {
    for (const modelId of [...this.modelos.keys()]) {
      await this.fragments.core.disposeModel(modelId)
    }
    this.modelos.clear()
    this.seleccionado = null
    this.sobrevolado = null
    this.excluidos.clear()
    this.origenComun = null
    // Las mediciones cuelgan de una geometria que ya no esta; dejarlas
    // flotando en el vacio seria peor que perderlas.
    this.borrarMediciones()
    await this.actualizar()
  }

  /** Arboles espaciales, uno por modelo montado. */
  async getSpatialTrees(): Promise<
    { modelId: string; nombre: string; tree: FRAGS.SpatialTreeItem }[]
  > {
    const arboles: {
      modelId: string
      nombre: string
      tree: FRAGS.SpatialTreeItem
    }[] = []
    for (const [modelId, e] of this.modelos) {
      arboles.push({
        modelId,
        nombre: e.nombre,
        tree: await e.model.getSpatialStructure(),
      })
    }
    return arboles
  }

  /**
   * Nombres de un lote de elementos de un modelo, para etiquetar el arbol.
   * Solo pide el atributo `Name`: traer todos los atributos de cientos de
   * nodos a la vez tarda mas que la conversion entera.
   */
  async getNames(
    modelId: string,
    localIds: number[],
  ): Promise<Map<number, string>> {
    const names = new Map<number, string>()
    const entrada = this.modelos.get(modelId)
    if (!entrada || localIds.length === 0) return names

    const data = await entrada.model.getItemsData(localIds, {
      attributesDefault: false,
      attributes: ['Name', '_localId'],
      relationsDefault: { attributes: false, relations: false },
    })

    for (const item of data) {
      const id = item._localId
      const name = item.Name
      if (
        id && 'value' in id && typeof id.value === 'number' &&
        name && 'value' in name && typeof name.value === 'string' && name.value
      ) {
        names.set(id.value, name.value)
      }
    }

    return names
  }

  /**
   * Lanza un rayo en coordenadas de ventana y devuelve donde cayo.
   *
   * Sirve para comprobar la correspondencia sin depender de que elemento se
   * toque: el punto 3D del impacto, reproyectado a pantalla, tiene que caer
   * donde se apunto. Si no coincide, las coordenadas estan desalineadas.
   */
  async sondearEn(x: number, y: number) {
    if (!this.hasModel) return null
    const dom = this.world.renderer!.three.domElement
    const hit = await this.buscarBajoCursor(new THREE.Vector2(x, y), dom)
    if (!hit) return null
    const vuelta = this.proyectar(hit.point)
    return {
      ref: refDe(hit),
      localId: hit.localId,
      pedido: { x, y },
      reproyectado: vuelta,
      desvio: vuelta ? Math.hypot(vuelta.x - x, vuelta.y - y) : null,
    }
  }

  /** Proyecta un punto del mundo a coordenadas del lienzo. Para diagnostico. */
  proyectar(punto: THREE.Vector3): { x: number; y: number } | null {
    const dom = this.world.renderer?.three.domElement
    if (!dom) return null
    const v = punto.clone().project(this.world.camera.three)
    if (v.z > 1) return null
    const r = dom.getBoundingClientRect()
    return {
      x: r.left + ((v.x + 1) / 2) * r.width,
      y: r.top + ((1 - v.y) / 2) * r.height,
    }
  }

  /** Centro de la caja de un elemento, en coordenadas del mundo. */
  async centroDe(ref: Ref): Promise<THREE.Vector3 | null> {
    const entrada = this.modelos.get(ref.modelId)
    if (!entrada) return null
    const [caja] = await entrada.model.getBoxes([ref.localId])
    if (!caja || caja.isEmpty()) return null
    return caja.getCenter(new THREE.Vector3())
  }

  /** Elementos actualmente resaltados. Para comprobar que la seleccion cuaja. */
  async getHighlighted(): Promise<Ref[]> {
    const refs: Ref[] = []
    for (const [modelId, e] of this.modelos) {
      for (const localId of await e.model.getHighlightItemIds()) {
        refs.push({ modelId, localId })
      }
    }
    return refs
  }

  /** Colores de material de un lote de elementos. Para diagnostico. */
  async getColors(refs: Ref[]) {
    const aHex = (c: unknown) => {
      // La definicion vuelve del worker serializada: es un objeto plano con
      // r, g y b, no una instancia de THREE.Color.
      if (c instanceof THREE.Color) return `#${c.getHexString()}`
      const o = c as { r?: number; g?: number; b?: number }
      if (
        typeof o?.r !== 'number' ||
        typeof o?.g !== 'number' ||
        typeof o?.b !== 'number'
      ) {
        return 'desconocido'
      }
      return `#${new THREE.Color(o.r, o.g, o.b).getHexString()}`
    }

    const salida: { cuantos: number; color: string; opacidad?: number }[] = []
    for (const [modelId, localIds] of agrupar(refs)) {
      const entrada = this.modelos.get(modelId)
      if (!entrada) continue
      const defs = await entrada.model.getItemsMaterialDefinition(localIds)
      for (const d of defs) {
        salida.push({
          // La API agrupa: una definicion de material vale para varios elementos.
          cuantos: d.localIds.length,
          color: aHex(d.definition.color),
          opacidad: d.definition.opacity,
        })
      }
    }
    return salida
  }

  /** Diagnostico del encuadre: dimensiones y centro de lo montado. */
  getBoxInfo(): { size: THREE.Vector3; center: THREE.Vector3 } | null {
    const box = this.cajaTotal()
    if (box.isEmpty()) return null
    return {
      size: box.getSize(new THREE.Vector3()),
      center: box.getCenter(new THREE.Vector3()),
    }
  }

  /** Caja de un modelo concreto, ya en el origen comun. Para diagnostico. */
  getModelBox(modelId: string): THREE.Box3 | null {
    const entrada = this.modelos.get(modelId)
    if (!entrada) return null
    const box = entrada.model.box
    return box.isEmpty() ? null : box
  }

  /**
   * Desplazamiento aplicado a un modelo respecto del primero montado.
   * Sirve para comprobar que la coordinacion hizo algo, y cuanto.
   */
  getOffset(modelId: string): THREE.Vector3 | null {
    const entrada = this.modelos.get(modelId)
    if (!entrada) return null
    return entrada.model.object.position.clone()
  }

  /**
   * Lo que la libreria sabe de la georreferencia de cada modelo, en crudo.
   * Para averiguar por que dos modelos no caen donde deben.
   */
  async getCoordsDebug() {
    const salida: string[] = []
    for (const [modelId, e] of this.modelos) {
      const crudo = await e.model.getCoordinates()
      const m = await e.model.getCoordinationMatrix()
      const t = new THREE.Vector3().setFromMatrixPosition(m)
      const sinTransformar = e.model.object.matrixWorld.clone().invert()
      const cajaLocal = e.model.box.clone().applyMatrix4(sinTransformar)
      salida.push(
        `${modelId} (${e.nombre}): getCoordinates=[${[...crudo]
          .map((n) => Number(n).toFixed(2))
          .join(', ')}]` +
          ` | traslacion de su matriz (${t.x.toFixed(1)}, ${t.y.toFixed(1)}, ${t.z.toFixed(1)})` +
          ` | caja sin coordinar centro (${cajaLocal
            .getCenter(new THREE.Vector3())
            .toArray()
            .map((n) => n.toFixed(1))
            .join(', ')})`,
      )
    }
    return salida
  }

  /** Cajas individuales, para detectar elementos disparados lejos del resto. */
  async getItemBoxes(refs: Ref[]) {
    const cajas: THREE.Box3[] = []
    for (const [modelId, localIds] of agrupar(refs)) {
      const entrada = this.modelos.get(modelId)
      if (!entrada) continue
      cajas.push(...(await entrada.model.getBoxes(localIds)))
    }
    return cajas
  }

  /** Referencias de los elementos que tienen geometria. */
  getRefsWithGeometry(): Ref[] {
    const refs: Ref[] = []
    for (const [modelId, e] of this.modelos) {
      for (const localId of e.idsConGeometria) refs.push({ modelId, localId })
    }
    return refs
  }

  /** Cantidad de elementos con geometria. Util para contrastar contra el arbol. */
  getItemsWithGeometryCount(): number {
    let total = 0
    for (const e of this.modelos.values()) total += e.idsConGeometria.size
    return total
  }

  /** Datos sin podar. Solo para diagnostico: pintarlos cuelga la interfaz. */
  async getItemDataSinPodar(ref: Ref): Promise<FRAGS.ItemData | null> {
    const entrada = this.modelos.get(ref.modelId)
    if (!entrada) return null
    const [d] = await entrada.model.getItemsData([ref.localId], {
      attributesDefault: true,
      relations: {
        IsDefinedBy: { attributes: true, relations: true },
        DefinesOcurrence: { attributes: false, relations: false },
      },
      relationsDefault: { attributes: false, relations: false },
    })
    return d ?? null
  }

  /**
   * Property sets y atributos de un elemento, ya acotados.
   *
   * Las relaciones hay que pedirlas en profundidad porque los valores de las
   * propiedades cuelgan por debajo de ellas, pero lo que vuelve es ciclico.
   * Se poda aqui y no en el panel para que ningun consumidor pueda recibir una
   * estructura sin fin.
   */
  async getItemData(ref: Ref): Promise<FRAGS.ItemData | null> {
    const entrada = this.modelos.get(ref.modelId)
    if (!entrada) return null
    const [data] = await entrada.model.getItemsData([ref.localId], {
      attributesDefault: true,
      relations: {
        IsDefinedBy: { attributes: true, relations: true },
        DefinesOcurrence: { attributes: false, relations: false },
      },
      relationsDefault: { attributes: false, relations: false },
    })
    if (!data) return null

    const { data: podado, info } = podarItemData(data)
    // Cortar el ciclo es lo normal y pasa en todos los elementos, asi que no
    // se reporta. Los cortes por profundidad o presupuesto si: significan que
    // puede haberse quedado fuera informacion real y conviene saberlo.
    if (info.porProfundidad > 0 || info.porPresupuesto > 0) {
      console.warn(
        `propiedades de #${ref.localId} truncadas: ${info.nodos} nodos conservados,` +
          ` ${info.porProfundidad} cortes por profundidad y ${info.porPresupuesto} por presupuesto`,
      )
    }
    return podado
  }

  /**
   * Resalta un elemento, o quita el resaltado con `null`.
   *
   * No se usa `resetHighlight()` sin argumentos: los colores propios del tema
   * se aplican por el mismo canal interno que el resaltado, asi que borrarlo
   * entero devolvia el firme a su color original en cuanto se pulsaba
   * cualquier elemento. Se limpia solo lo que estaba resaltado y se le
   * devuelve su color de tema si le correspondia.
   */
  async highlight(ref: Ref | null) {
    // Elegir uno deshace la seleccion multiple: si no, quedaria media
    // ventana resaltada en azul sin que nada lo explique.
    const habiaMarcados = this.marcados.size > 0
    if (mismaRef(this.seleccionado, ref) && !habiaMarcados) return

    const afectados = [this.seleccionado, ref].filter(
      (x): x is Ref => x !== null,
    )
    if (habiaMarcados) {
      afectados.push(...[...this.marcados].map(desdeClave))
      this.marcados.clear()
    }
    this.seleccionado = ref
    await this.refrescarAspecto(afectados)
  }

  /** Marca el elemento bajo el cursor. `null` cuando no hay ninguno. */
  async setHover(ref: Ref | null) {
    if (mismaRef(this.sobrevolado, ref)) return
    const afectados = [this.sobrevolado, ref].filter(
      (x): x is Ref => x !== null,
    )
    this.sobrevolado = ref
    await this.refrescarAspecto(afectados)
  }

  /**
   * Fija la seleccion multiple viva, la que deja una ventana de seleccion.
   *
   * Se separa del elemento seleccionado porque no son lo mismo: el panel de
   * propiedades necesita uno solo, y una ventana puede traer treinta.
   */
  async setMarcados(refs: Ref[]) {
    const nuevos = new Set(refs.map(claveRef))
    const cambiados: Ref[] = []
    for (const clave of this.marcados) {
      if (!nuevos.has(clave)) cambiados.push(desdeClave(clave))
    }
    for (const r of refs) {
      if (!this.marcados.has(claveRef(r))) cambiados.push(r)
    }
    this.marcados = nuevos
    if (cambiados.length > 0) await this.refrescarAspecto(cambiados)
  }

  /**
   * Fija que elementos quedan marcados como fuera del entregable.
   *
   * Se repinta solo lo que cambia de estado, no todo: en un modelo grande la
   * lista de exclusion crece de cuarenta en cuarenta y repintar el modelo
   * entero en cada anadido se nota.
   */
  async setExcluidos(refs: Ref[]) {
    const nuevos = new Set(refs.map(claveRef))
    const cambiados: Ref[] = []

    for (const clave of this.excluidos) {
      if (!nuevos.has(clave)) cambiados.push(desdeClave(clave))
    }
    for (const r of refs) {
      if (!this.excluidos.has(claveRef(r))) cambiados.push(r)
    }

    this.excluidos = nuevos
    if (cambiados.length > 0) await this.refrescarAspecto(cambiados)
  }

  /** Elementos marcados como fuera del entregable. */
  getExcluidos(): Ref[] {
    return [...this.excluidos].map(desdeClave)
  }

  /**
   * Repone la marca de los excluidos.
   *
   * Hace falta despues de cualquier `resetHighlight` general, que se lleva
   * por delante todo lo que viva en ese canal.
   */
  private async reponerExcluidos() {
    if (this.excluidos.size === 0) return
    await this.refrescarAspecto(this.getExcluidos())
  }

  /** Color de tema que le toca a un elemento, si le toca alguno. */
  private colorDeTema(modelId: string, id: number): number | null {
    if (this.temaActual !== 'claro') return null
    const entrada = this.modelos.get(modelId)
    if (!entrada) return null
    for (const [i, regla] of COLORES_TEMA_CLARO.entries()) {
      if (entrada.idsRecoloreables[i]?.includes(id)) return regla.color
    }
    return null
  }

  /**
   * Repinta unos pocos elementos segun el estado en que esten.
   *
   * El resaltado, la marca del cursor y los colores del tema se aplican por el
   * mismo canal interno de fragments, asi que no pueden gestionarse por
   * separado: quien escriba ultimo gana y los demas desaparecen. Se decide
   * aqui, en un unico sitio y con prioridad explicita.
   */
  private async refrescarAspecto(refs: Ref[]) {
    if (refs.length === 0) return

    for (const [modelId, ids] of agrupar(refs)) {
      const entrada = this.modelos.get(modelId)
      if (!entrada) continue
      await entrada.model.resetHighlight(ids)
      for (const id of ids) {
        const ref = { modelId, localId: id }
        const clave = claveRef(ref)
        const fuera = this.excluidos.has(clave)
        const elegido = mismaRef(ref, this.seleccionado) || this.marcados.has(clave)
        if (mismaRef(ref, this.sobrevolado)) {
          await entrada.model.highlight([id], HOVER)
        } else if (fuera) {
          await entrada.model.highlight(
            [id],
            elegido ? EXCLUIDO_SELECCIONADO : EXCLUIDO,
          )
        } else if (elegido) {
          await entrada.model.highlight([id], HIGHLIGHT)
        } else {
          const color = this.colorDeTema(modelId, id)
          if (color !== null) {
            await entrada.model.setColor([id], new THREE.Color(color))
          }
        }
      }
    }
    await this.actualizar()
  }

  /**
   * Deja visibles solo los elementos indicados.
   *
   * Con varios modelos montados el aislamiento es global: los modelos que no
   * aportan ningun elemento se ocultan enteros. Si solo se ocultara dentro del
   * modelo del elegido, aislar no serviria para nada en cuanto hay mas de uno.
   */
  async isolate(refs: Ref[]) {
    if (refs.length === 0) return
    const porModelo = agrupar(refs)
    for (const [modelId, entrada] of this.modelos) {
      await entrada.model.setVisible(undefined, false)
      const ids = porModelo.get(modelId)
      if (ids) await entrada.model.setVisible(ids, true)
      // Un modelo que no aporta nada al aislamiento queda oculto entero. Se
      // anota para que la lista de modelos no diga lo contrario que la escena.
      entrada.visible = !!ids
    }

    // El centro de giro pasa a ser lo que queda visible, sin mover la camara.
    // Si no, la orbita sigue girando alrededor del ultimo punto que se pulso,
    // que despues de aislar suele estar dentro de algo ya oculto: la camara
    // da vueltas en torno a un sitio donde no hay nada.
    const caja = await this.cajaDe(refs)
    if (caja) {
      const centro = caja.getCenter(new THREE.Vector3())
      this.world.camera.controls.setOrbitPoint(centro.x, centro.y, centro.z)
    }

    await this.actualizar()
  }

  async hide(refs: Ref[]) {
    if (refs.length === 0) return
    for (const [modelId, ids] of agrupar(refs)) {
      await this.modelos.get(modelId)?.model.setVisible(ids, false)
    }
    await this.actualizar()
  }

  async showAll() {
    for (const e of this.modelos.values()) {
      await e.model.resetVisible()
      e.visible = true
    }
    await this.actualizar()
  }

  /**
   * Muestra u oculta un modelo entero desde la lista de modelos.
   *
   * Es lo que hace util montar varios: poder apagar una disciplina para ver
   * que hay debajo. Un modelo oculto tampoco responde al rayo, o seguiria
   * seleccionandose a traves de lo que si se ve.
   */
  async setModelVisible(modelId: string, visible: boolean) {
    const entrada = this.modelos.get(modelId)
    if (!entrada) return
    entrada.visible = visible
    if (visible) await entrada.model.resetVisible()
    else await entrada.model.setVisible(undefined, false)
    if (!visible) {
      if (this.seleccionado?.modelId === modelId) this.seleccionado = null
      if (this.sobrevolado?.modelId === modelId) this.sobrevolado = null
    }
    await this.actualizar()
  }

  /**
   * Aplica transparencia a un conjunto de elementos.
   *
   * `opacidad` va de 0 (invisible) a 1 (opaco). Se marca el material como
   * transparente y se desactiva la escritura de profundidad: sin eso, un
   * elemento translucido sigue tapando a los que tiene detras y el efecto no
   * sirve para lo que se busca, que es ver a traves.
   */
  async setOpacity(refs: Ref[], opacidad: number) {
    if (refs.length === 0) return
    const valor = Math.min(1, Math.max(0, opacidad))
    for (const [modelId, ids] of agrupar(refs)) {
      await this.modelos.get(modelId)?.model.setOpacity(ids, valor)
    }
    await this.actualizar()
  }

  /**
   * Deja translucido todo menos lo indicado.
   *
   * Es el uso habitual al revisar un modelo: ver un elemento en su contexto
   * sin que el resto lo tape. Con varios modelos montados "todo lo demas"
   * incluye los otros modelos, que es justo lo que se quiere al buscar un
   * cruce entre disciplinas. Se limpia la transparencia previa antes de
   * aplicar la nueva, o al cambiar de seleccion se irian acumulando capas.
   */
  async invertOpacity(refs: Ref[], opacidad: number) {
    if (refs.length === 0) return
    const valor = Math.min(1, Math.max(0, opacidad))
    const elegidos = new Set(refs.map(claveRef))

    for (const [modelId, entrada] of this.modelos) {
      const resto = [...entrada.idsConGeometria].filter(
        (localId) => !elegidos.has(claveRef({ modelId, localId })),
      )
      await entrada.model.resetOpacity(undefined)
      if (resto.length > 0) await entrada.model.setOpacity(resto, valor)
    }
    await this.actualizar()
  }

  async resetOpacity(refs?: Ref[]) {
    if (!refs) {
      for (const e of this.modelos.values()) {
        await e.model.resetOpacity(undefined)
      }
    } else {
      for (const [modelId, ids] of agrupar(refs)) {
        await this.modelos.get(modelId)?.model.resetOpacity(ids)
      }
    }
    await this.actualizar()
  }

  /** Modo de navegacion de la camara. */
  setNavigation(modo: Navegacion) {
    this.navegacion = modo
    this.world.camera.set(modo)
    // Cambiar de modo rehace los limites con los valores de la libreria; hay
    // que volver a ponerlos a la escala del modelo.
    this.ajustarControles()
  }

  /**
   * Resuelve una vez, al cargar, que elementos afecta cada regla de color.
   * Consultar los nombres es caro y no cambia mientras el modelo este abierto.
   */
  private async resolverRecoloreables(entrada: Entrada) {
    entrada.idsRecoloreables = COLORES_TEMA_CLARO.map(() => [])
    if (entrada.idsConGeometria.size === 0) return

    const ids = [...entrada.idsConGeometria]
    const nombres = await this.getNames(entrada.model.modelId, ids)
    // Se guardan para despues: buscar elementos parecidos necesita los mismos
    // nombres, y volver a pedirlos cuesta otra vez lo que acaba de costar.
    entrada.nombres = nombres
    for (const id of ids) {
      const nombre = nombres.get(id)
      if (!nombre) continue
      COLORES_TEMA_CLARO.forEach((regla, i) => {
        if (regla.patron.test(nombre)) entrada.idsRecoloreables[i].push(id)
      })
    }
  }

  /** Aplica o retira los colores propios del tema claro. */
  private async aplicarColoresDeTema(tema: Tema) {
    for (const [modelId, entrada] of this.modelos) {
      for (const [i, regla] of COLORES_TEMA_CLARO.entries()) {
        const ids = entrada.idsRecoloreables[i]
        if (!ids || ids.length === 0) continue
        // Se excluyen el seleccionado y el sobrevolado: su marca manda sobre
        // el color de tema, y aplicarselo aqui la borraria.
        const libres = ids.filter(
          (localId) =>
            !mismaRef({ modelId, localId }, this.seleccionado) &&
            !mismaRef({ modelId, localId }, this.sobrevolado) &&
            !this.excluidos.has(claveRef({ modelId, localId })) &&
            !this.marcados.has(claveRef({ modelId, localId })),
        )
        if (libres.length === 0) continue
        if (tema === 'claro') {
          await entrada.model.setColor(libres, new THREE.Color(regla.color))
        } else {
          await entrada.model.resetColor(libres)
        }
      }
    }
    await this.actualizar()
  }

  /** Cambia el fondo de la escena y los colores que dependen del tema. */
  setTheme(tema: Tema) {
    this.temaActual = tema
    this.world.scene.three.background = new THREE.Color(FONDO[tema])
    void this.aplicarColoresDeTema(tema)
  }

  /** Cuantos elementos afecta cada regla de color. Para diagnostico. */
  getRecoloreables() {
    return COLORES_TEMA_CLARO.map((r, i) => {
      let cuantos = 0
      for (const e of this.modelos.values()) {
        cuantos += e.idsRecoloreables[i]?.length ?? 0
      }
      return { patron: String(r.patron), cuantos }
    })
  }

  /**
   * Vuelve a la vista general: todo visible, sin transparencias ni resaltados,
   * y la camara encuadrando todo lo montado.
   */
  async resetView() {
    if (!this.hasModel) return
    for (const e of this.modelos.values()) {
      await e.model.resetVisible()
      await e.model.resetOpacity(undefined)
      await e.model.resetHighlight()
      e.visible = true
    }
    this.seleccionado = null
    this.sobrevolado = null
    // resetHighlight sin argumentos tambien se lleva los colores del tema y
    // la marca de los excluidos, porque comparten canal; hay que reponerlos.
    await this.aplicarColoresDeTema(this.temaActual)
    await this.reponerExcluidos()
    await this.actualizar()
    await this.fitToModel()
  }

  /** Encuadra la camara sobre todo lo montado. */
  async fitToModel() {
    const box = this.cajaTotal()
    if (box.isEmpty()) return
    await this.world.camera.controls.fitToBox(box, true, {
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: 1,
      paddingBottom: 1,
    })
  }

  /** Encuadra la camara sobre un modelo concreto. */
  async fitToOneModel(modelId: string) {
    const box = this.getModelBox(modelId)
    if (!box) return
    await this.world.camera.controls.fitToBox(box, true, {
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: 1,
      paddingBottom: 1,
    })
  }

  /**
   * Encuadra la camara sobre un conjunto de elementos.
   *
   * Se filtran los que no tienen geometria antes de pedir la caja: los nodos
   * espaciales del arbol (proyecto, sitio, instalacion) no tienen caja propia,
   * y basta con que se cuele uno para que la caja combinada salga vacia y el
   * boton no haga nada sin decir por que.
   */
  async fitToItems(refs: Ref[]) {
    const caja = await this.cajaDe(refs)
    if (!caja) return
    await this.world.camera.controls.fitToBox(caja, true, {
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: 1,
      paddingBottom: 1,
    })
  }

  /** Caja que engloba unos elementos, o `null` si ninguno tiene geometria. */
  private async cajaDe(refs: Ref[]): Promise<THREE.Box3 | null> {
    if (refs.length === 0) return null

    const total = new THREE.Box3()
    total.makeEmpty()
    for (const [modelId, localIds] of agrupar(refs)) {
      const entrada = this.modelos.get(modelId)
      if (!entrada) continue
      const conGeometria = localIds.filter((id) =>
        entrada.idsConGeometria.has(id),
      )
      if (conGeometria.length === 0) continue
      const box = await entrada.model.getMergedBox(conGeometria)
      if (!box.isEmpty()) total.union(box)
    }
    return total.isEmpty() ? null : total
  }

  // --- Vistas predeterminadas ----------------------------------------------

  /**
   * Coloca la camara en una vista conocida sobre los elementos indicados, o
   * sobre todo lo montado si no se pasa ninguno.
   *
   * Se gira primero sin animacion y se encuadra despues con ella: `fitToBox`
   * conserva la direccion de la camara, asi que el orden importa, y animar
   * los dos pasos encadenaria dos vuelos en vez de uno. El giro va sobre el
   * objetivo que haya en ese momento; el encuadre posterior es el que lleva
   * la camara al sitio.
   *
   * El `up` de la camara no se toca. Es la vertical de la escena y cambiarlo
   * deja la orbita girada para todo lo que venga despues.
   */
  async vistaPredeterminada(vista: Vista, refs: Ref[] = []) {
    const caja = refs.length > 0 ? await this.cajaDe(refs) : this.cajaTotal()
    if (!caja || caja.isEmpty()) return

    const { acimut, polar } = VISTAS[vista]
    const controles = this.world.camera.controls

    await controles.rotateTo(acimut, polar, false)
    await controles.fitToBox(caja, true, {
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: 1,
      paddingBottom: 1,
    })
  }

  // --- Elementos parecidos -------------------------------------------------

  /**
   * Que elementos se parecen al indicado, por nombre, por categoria y por
   * ambas cosas a la vez.
   *
   * Devuelve las tres listas en lugar de aplicar una: con 1300 elementos en
   * el archivo chico y muchos mas en los grandes, conviene que se vea cuantos
   * atrapa cada criterio antes de ocultar medio modelo.
   */
  async buscarSimilares(ref: Ref): Promise<ResumenSimilares | null> {
    const origen = this.modelos.get(ref.modelId)
    if (!origen) return null

    const nombre = origen.nombres.get(ref.localId) ?? null
    const categoria = (await this.indiceCategorias(origen)).get(ref.localId) ?? null
    const base = nombre ? baseNombre(nombre) : null

    const porNombre: Ref[] = []
    const porCategoria: Ref[] = []

    for (const [modelId, entrada] of this.modelos) {
      const cats = categoria ? await this.indiceCategorias(entrada) : null
      for (const localId of entrada.idsConGeometria) {
        const n = entrada.nombres.get(localId)
        if (base && n && baseNombre(n) === base) {
          porNombre.push({ modelId, localId })
        }
        if (categoria && cats?.get(localId) === categoria) {
          porCategoria.push({ modelId, localId })
        }
      }
    }

    return { referencia: ref, nombre, categoria, porNombre, porCategoria }
  }

  /**
   * Categoria IFC de cada elemento del modelo.
   *
   * Se arma una sola vez y a peticion: `getItemsOfCategories` con todas las
   * categorias devuelve el modelo entero, y no hace falta mientras nadie
   * busque elementos parecidos.
   */
  private async indiceCategorias(entrada: Entrada): Promise<Map<number, string>> {
    if (entrada.categorias) return entrada.categorias

    const mapa = new Map<number, string>()
    try {
      const categorias = await entrada.model.getCategories()
      const porCategoria = await entrada.model.getItemsOfCategories(
        categorias.map((c) => new RegExp(`^${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)),
      )
      for (const [categoria, ids] of Object.entries(porCategoria)) {
        for (const id of ids) mapa.set(id, categoria)
      }
    } catch (err) {
      console.warn('No se pudieron leer las categorias del modelo', err)
    }

    entrada.categorias = mapa
    return mapa
  }

  // --- Medicion ------------------------------------------------------------

  getModo(): ModoVisor {
    return this.modo
  }

  /** Cambia lo que hace un clic. Al salir de medir se abandona lo a medias. */
  setModo(modo: ModoVisor) {
    if (this.modo === modo) return
    this.modo = modo
    this.puntoA = null
    this.puntoCursor = null
    this.ventanaDesde = null
    if (this.cajaVentana) this.cajaVentana.style.display = 'none'
    if (modo === 'medir') void this.setHover(null)
    this.redibujarMediciones()
  }

  getMediciones(): Medicion[] {
    return this.mediciones
  }

  /** Si hay una medicion empezada y sin cerrar. */
  hayMedicionEnCurso(): boolean {
    return this.puntoA !== null
  }

  /** Abandona la medicion a medias, dejando las ya tomadas. */
  cancelarMedicion() {
    if (!this.puntoA && !this.puntoCursor) return
    this.puntoA = null
    this.redibujarMediciones()
  }

  borrarMedicion(id: number) {
    this.mediciones = this.mediciones.filter((m) => m.id !== id)
    this.redibujarMediciones()
  }

  borrarMediciones() {
    this.mediciones = []
    this.puntoA = null
    this.redibujarMediciones()
  }

  /**
   * Marca un punto. El primero abre la medicion y el segundo la cierra.
   *
   * Expuesto ademas de usarse desde el raton para poder probarlo sin depender
   * de donde caiga el cursor.
   */
  async marcarEn(x: number, y: number): Promise<Medicion | null> {
    const dom = this.world.renderer?.three.domElement
    if (!dom || !this.hasModel) return null

    const enganche = await this.puntoEnganchado(x, y, dom)
    if (!enganche) return null

    if (!this.puntoA) {
      this.puntoA = enganche.punto
      this.puntoCursor = enganche.punto.clone()
      this.redibujarMediciones()
      return null
    }

    const medicion: Medicion = {
      id: this.siguienteMedicion++,
      a: this.puntoA.clone(),
      b: enganche.punto.clone(),
      distancia: this.puntoA.distanceTo(enganche.punto),
    }
    this.mediciones = [...this.mediciones, medicion]
    this.puntoA = null
    this.redibujarMediciones()
    return medicion
  }

  private async marcarPunto(e: PointerEvent) {
    await this.marcarEn(e.clientX, e.clientY)
  }

  /**
   * Punto enganchado bajo el cursor.
   *
   * `raycastWithSnapping` no devuelve un punto sino todos los candidatos que
   * hay bajo el rayo — vertices, aristas y la cara —, asi que hay que elegir.
   * Se comparan proyectados a pantalla, porque lo que se quiere es el que se
   * ve mas cerca de donde se apunta, no el mas cercano a la camara.
   *
   * Si ninguno cae dentro de la tolerancia se usa el punto donde el rayo toca
   * la geometria: medir a ojo sobre una cara es preferible a no poder medir.
   */
  private async puntoEnganchado(
    x: number,
    y: number,
    dom: HTMLCanvasElement,
  ): Promise<{ punto: THREE.Vector3; clase: FRAGS.SnappingClass | null } | null> {
    if (!this.hasModel) return null

    const camera = this.world.camera.three
    const mouse = new THREE.Vector2(x, y)
    const listas = await Promise.all(
      [...this.modelos.values()]
        .filter((e) => e.visible)
        .map((e) =>
          e.model
            .raycastWithSnapping({
              camera,
              mouse,
              dom,
              snappingClasses: CLASES_ENGANCHE,
            })
            .catch(() => null),
        ),
    )

    let mejor: FRAGS.RaycastResult | null = null
    let mejorCoste = Infinity
    for (const lista of listas) {
      for (const candidato of lista ?? []) {
        const p = this.proyectar(candidato.point)
        if (!p) continue
        const coste =
          Math.hypot(p.x - x, p.y - y) -
          (VENTAJA_ENGANCHE[candidato.snappingClass] ?? 0)
        if (coste < mejorCoste) {
          mejorCoste = coste
          mejor = candidato
        }
      }
    }

    if (mejor && mejorCoste <= TOLERANCIA_ENGANCHE) {
      return { punto: mejor.point.clone(), clase: mejor.snappingClass }
    }

    const hit = await this.buscarBajoCursor(mouse, dom)
    return hit ? { punto: hit.point.clone(), clase: null } : null
  }

  /**
   * Rehace la geometria de las mediciones.
   *
   * Se rehace entera en vez de actualizarla en sitio: son unas pocas lineas y
   * un punado de puntos, y asi no hay estado que mantener en orden.
   */
  private redibujarMediciones() {
    for (const hijo of [...this.grupoMedicion.children]) {
      this.grupoMedicion.remove(hijo)
      const conGeometria = hijo as THREE.Mesh
      conGeometria.geometry?.dispose()
    }

    const segmentos: number[] = []
    const puntos: number[] = []
    for (const m of this.mediciones) {
      segmentos.push(m.a.x, m.a.y, m.a.z, m.b.x, m.b.y, m.b.z)
      puntos.push(m.a.x, m.a.y, m.a.z, m.b.x, m.b.y, m.b.z)
    }

    // La medicion en curso se dibuja igual que las demas: la goma elastica
    // hasta el cursor es lo que deja ver cuanto va a medir antes de soltar.
    if (this.modo === 'medir') {
      if (this.puntoA && this.puntoCursor) {
        segmentos.push(
          this.puntoA.x, this.puntoA.y, this.puntoA.z,
          this.puntoCursor.x, this.puntoCursor.y, this.puntoCursor.z,
        )
      }
      if (this.puntoA) puntos.push(this.puntoA.x, this.puntoA.y, this.puntoA.z)
      if (this.puntoCursor) {
        puntos.push(this.puntoCursor.x, this.puntoCursor.y, this.puntoCursor.z)
      }
    }

    if (segmentos.length > 0) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(segmentos, 3))
      const lineas = new THREE.LineSegments(geo, this.materialLinea)
      lineas.renderOrder = 999
      lineas.frustumCulled = false
      this.grupoMedicion.add(lineas)
    }

    if (puntos.length > 0) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(puntos, 3))
      const nube = new THREE.Points(geo, this.materialPunto)
      nube.renderOrder = 1000
      nube.frustumCulled = false
      this.grupoMedicion.add(nube)
    }

    this.onMediciones?.(this.mediciones)
  }

  /**
   * Etiquetas de las mediciones ya proyectadas a la pantalla.
   *
   * Van en coordenadas de ventana, como todo lo que cruza entre el visor y la
   * interfaz, para no tener que restar la posicion del lienzo en cada sitio.
   */
  getEtiquetas(): EtiquetaMedicion[] {
    const etiquetas: EtiquetaMedicion[] = []
    for (const m of this.mediciones) {
      const medio = m.a.clone().add(m.b).multiplyScalar(0.5)
      const p = this.proyectar(medio)
      if (!p) continue
      etiquetas.push({
        id: m.id,
        x: p.x,
        y: p.y,
        texto: formatearDistancia(m.distancia),
        provisional: false,
      })
    }

    if (this.modo === 'medir' && this.puntoA && this.puntoCursor) {
      const medio = this.puntoA.clone().add(this.puntoCursor).multiplyScalar(0.5)
      const p = this.proyectar(medio)
      if (p) {
        etiquetas.push({
          id: 0,
          x: p.x,
          y: p.y,
          texto: formatearDistancia(this.puntoA.distanceTo(this.puntoCursor)),
          provisional: true,
        })
      }
    }

    return etiquetas
  }

  dispose() {
    this.container?.removeEventListener('wheel', this.handleWheel, true)
    this.container?.removeEventListener('pointerdown', this.handleVentanaDown, true)
    this.container?.removeEventListener('pointermove', this.handleVentanaMove, true)
    this.container?.removeEventListener('pointerup', this.handleVentanaUp, true)
    this.cajaVentana?.remove()
    this.cajaVentana = null
    this.container?.removeEventListener('pointerdown', this.handlePointerDown)
    this.container?.removeEventListener('pointerup', this.handlePointerUp)
    this.container?.removeEventListener('pointermove', this.handlePointerMove)
    this.container?.removeEventListener('pointerleave', this.handlePointerLeave)
    this.container = null
    this.modelos.clear()
    this.origenComun = null
    this.borrarMediciones()
    this.materialLinea.dispose()
    this.materialPunto.dispose()
    this.components.dispose()
  }
}

/** Referencia del elemento que toco un rayo. */
const refDe = (hit: FRAGS.RaycastResult): Ref => ({
  modelId: hit.fragments.modelId,
  localId: hit.localId,
})

