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

/** Radios en pixeles que se prueban alrededor del cursor si el punto exacto
 *  no toca nada. Sin esto hay que acercarse mucho para poder pulsar algo. */
const RADIOS_TOLERANCIA = [5, 11, 18]

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
}

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
  /** Elemento seleccionado y elemento bajo el cursor. */
  private seleccionado: Ref | null = null
  private sobrevolado: Ref | null = null
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
        const hit = await this.buscarBajoCursor(
          new THREE.Vector2(e.clientX, e.clientY),
          dom,
        )
        await this.setHover(hit ? refDe(hit) : null)
      } finally {
        this.hoverEnCurso = false
      }
    })()
  }

  private handlePointerLeave = () => {
    void this.setHover(null)
  }

  private handlePointerDown = (e: PointerEvent) => {
    this.downAt = { x: e.clientX, y: e.clientY }
  }

  private handlePointerUp = (e: PointerEvent) => {
    const from = this.downAt
    this.downAt = null
    if (!from || !this.hasModel) return

    const moved = Math.hypot(e.clientX - from.x, e.clientY - from.y)
    if (moved > 4) return

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
    }
    this.modelos.set(modelId, entrada)

    await this.resolverRecoloreables(entrada)
    this.adjustCameraPlanes()
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
    }
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
    this.origenComun = null
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
    if (mismaRef(this.seleccionado, ref)) return
    const afectados = [this.seleccionado, ref].filter(
      (x): x is Ref => x !== null,
    )
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
        if (mismaRef(ref, this.sobrevolado)) {
          await entrada.model.highlight([id], HOVER)
        } else if (mismaRef(ref, this.seleccionado)) {
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
    this.world.camera.set(modo)
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
            !mismaRef({ modelId, localId }, this.sobrevolado),
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
    // resetHighlight sin argumentos tambien se lleva los colores del tema,
    // porque comparten canal; hay que reponerlos.
    await this.aplicarColoresDeTema(this.temaActual)
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
    if (refs.length === 0) return

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

    if (total.isEmpty()) return
    await this.world.camera.controls.fitToBox(total, true, {
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: 1,
      paddingBottom: 1,
    })
  }

  dispose() {
    this.container?.removeEventListener('pointerdown', this.handlePointerDown)
    this.container?.removeEventListener('pointerup', this.handlePointerUp)
    this.container?.removeEventListener('pointermove', this.handlePointerMove)
    this.container?.removeEventListener('pointerleave', this.handlePointerLeave)
    this.container = null
    this.modelos.clear()
    this.origenComun = null
    this.components.dispose()
  }
}

/** Referencia del elemento que toco un rayo. */
const refDe = (hit: FRAGS.RaycastResult): Ref => ({
  modelId: hit.fragments.modelId,
  localId: hit.localId,
})

