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

const MODEL_ID = 'modelo'

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

type World = OBC.SimpleWorld<
  OBC.SimpleScene,
  OBC.OrthoPerspectiveCamera,
  OBC.SimpleRenderer
>

export class Viewer {
  private components = new OBC.Components()
  private world!: World
  private fragments!: OBC.FragmentsManager
  private model: FRAGS.FragmentsModel | null = null
  private container: HTMLElement | null = null
  /** Ids con geometria del modelo cargado, para filtrar encuadres. */
  private idsConGeometria = new Set<number>()
  /** Ids afectados por cada regla de color, resueltos al cargar. */
  private idsRecoloreables: number[][] = []
  private temaActual: Tema = 'oscuro'
  /** Lo que hay resaltado ahora, para poder quitarlo sin borrar mas. */
  private resaltados: number[] = []

  /** Se dispara al hacer clic en el modelo. `null` al hacer clic en vacio. */
  onSelect: ((localId: number | null) => void) | null = null

  get hasModel() {
    return this.model !== null
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
      void this.fragments.core.update(true)
    })

    this.fragments.list.onItemSet.add(({ value: model }) => {
      model.useCamera(this.world.camera.three)
      this.world.scene.three.add(model.object)
      void this.fragments.core.update(true)
    })

    container.addEventListener('pointerdown', this.handlePointerDown)
    container.addEventListener('pointerup', this.handlePointerUp)
  }

  // Un clic solo cuenta como seleccion si el puntero apenas se movio; de lo
  // contrario, orbitar la camara seleccionaria elementos sin querer.
  private downAt: { x: number; y: number } | null = null

  private handlePointerDown = (e: PointerEvent) => {
    this.downAt = { x: e.clientX, y: e.clientY }
  }

  private handlePointerUp = (e: PointerEvent) => {
    const from = this.downAt
    this.downAt = null
    if (!from || !this.model) return

    const moved = Math.hypot(e.clientX - from.x, e.clientY - from.y)
    if (moved > 4) return

    void this.pick(e)
  }

  private async pick(e: PointerEvent) {
    if (!this.container || !this.model) return

    const dom = this.world.renderer!.three.domElement
    const rect = dom.getBoundingClientRect()
    const mouse = new THREE.Vector2(e.clientX - rect.left, e.clientY - rect.top)

    const hit = await this.model.raycast({
      camera: this.world.camera.three,
      mouse,
      dom,
    })

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

    const localId = hit?.localId ?? null
    await this.highlight(localId)
    this.onSelect?.(localId)
  }

  async loadModel(fragments: Uint8Array, opciones?: { encuadrar?: boolean }) {
    await this.disposeModel()

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

    this.model = await this.fragments.core.load(buffer, {
      modelId: MODEL_ID,
      camera: this.world.camera.three,
    })

    this.idsConGeometria = new Set(await this.model.getItemsIdsWithGeometry())
    await this.resolverRecoloreables()
    this.adjustCameraPlanes()
    await this.aplicarColoresDeTema(this.temaActual)
    await this.fragments.core.update(true)
    if (opciones?.encuadrar !== false) await this.fitToModel()
    return this.model
  }

  /**
   * Ajusta los planos de recorte al tamano real del modelo.
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
    if (!this.model) return
    const box = this.model.box
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
   * Fuerza la reevaluacion de que geometria sube a la GPU. Es lo que dispara
   * el evento `rest` de la camara al terminar un encuadre, pero alli va sin
   * esperar: si tarda, la ventana se queda sin responder y no hay forma de
   * atribuirlo. Expuesto para poder medirlo.
   */
  async forceUpdate() {
    await this.fragments.core.update(true)
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

  async disposeModel() {
    if (!this.model) return
    await this.fragments.core.disposeModel(MODEL_ID)
    this.model = null
    this.idsConGeometria.clear()
  }

  /** Arbol espacial del modelo: proyecto > sitio > edificio > piso > elementos. */
  async getSpatialTree(): Promise<FRAGS.SpatialTreeItem | null> {
    if (!this.model) return null
    return this.model.getSpatialStructure()
  }

  /**
   * Nombres de un lote de elementos, para etiquetar el arbol. Solo pide el
   * atributo `Name`: traer todos los atributos de cientos de nodos a la vez
   * tarda mas que la conversion entera.
   */
  async getNames(localIds: number[]): Promise<Map<number, string>> {
    const names = new Map<number, string>()
    if (!this.model || localIds.length === 0) return names

    const data = await this.model.getItemsData(localIds, {
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
  async centroDe(localId: number): Promise<THREE.Vector3 | null> {
    if (!this.model) return null
    const [caja] = await this.model.getBoxes([localId])
    if (!caja || caja.isEmpty()) return null
    return caja.getCenter(new THREE.Vector3())
  }

  /** Ids actualmente resaltados. Para comprobar que la seleccion cuaja. */
  async getHighlighted(): Promise<number[]> {
    if (!this.model) return []
    return this.model.getHighlightItemIds()
  }

  /** Colores de material de un lote de elementos. Para diagnostico. */
  async getColors(localIds: number[]) {
    if (!this.model) return []
    const defs = await this.model.getItemsMaterialDefinition(localIds)
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
    return defs.map((d) => ({
      // La API agrupa: una definicion de material vale para varios elementos.
      cuantos: d.localIds.length,
      color: aHex(d.definition.color),
      opacidad: d.definition.opacity,
    }))
  }

  /** Diagnostico del encuadre: dimensiones y centro del modelo. */
  getBoxInfo(): { size: THREE.Vector3; center: THREE.Vector3 } | null {
    if (!this.model) return null
    const box = this.model.box
    if (box.isEmpty()) return null
    return {
      size: box.getSize(new THREE.Vector3()),
      center: box.getCenter(new THREE.Vector3()),
    }
  }

  /** Cajas individuales, para detectar elementos disparados lejos del resto. */
  async getItemBoxes(localIds: number[]) {
    if (!this.model) return []
    return this.model.getBoxes(localIds)
  }

  /** Ids de los elementos que tienen geometria. */
  async getIdsWithGeometry(): Promise<number[]> {
    if (!this.model) return []
    return this.model.getItemsIdsWithGeometry()
  }

  /** Cantidad de elementos con geometria. Util para contrastar contra el arbol. */
  async getItemsWithGeometryCount(): Promise<number> {
    return (await this.getIdsWithGeometry()).length
  }

  /** Datos sin podar. Solo para diagnostico: pintarlos cuelga la interfaz. */
  async getItemDataSinPodar(localId: number): Promise<FRAGS.ItemData | null> {
    if (!this.model) return null
    const [d] = await this.model.getItemsData([localId], {
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
  async getItemData(localId: number): Promise<FRAGS.ItemData | null> {
    if (!this.model) return null
    const [data] = await this.model.getItemsData([localId], {
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
        `propiedades de #${localId} truncadas: ${info.nodos} nodos conservados,` +
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
  async highlight(localId: number | null) {
    if (!this.model) return

    if (this.resaltados.length > 0) {
      await this.model.resetHighlight(this.resaltados)
      await this.reaplicarColorDeTema(this.resaltados)
    }

    this.resaltados = localId !== null ? [localId] : []
    if (localId !== null) {
      await this.model.highlight([localId], HIGHLIGHT)
    }
    await this.fragments.core.update(true)
  }

  /** Devuelve el color de tema a los ids indicados que lo tuvieran. */
  private async reaplicarColorDeTema(ids: number[]) {
    if (!this.model || this.temaActual !== 'claro' || ids.length === 0) return
    const afectados = new Set(ids)
    for (const [i, regla] of COLORES_TEMA_CLARO.entries()) {
      const suyos = (this.idsRecoloreables[i] ?? []).filter((id) =>
        afectados.has(id),
      )
      if (suyos.length > 0) {
        await this.model.setColor(suyos, new THREE.Color(regla.color))
      }
    }
  }

  /** Deja visibles solo los ids indicados. */
  async isolate(localIds: number[]) {
    if (!this.model || localIds.length === 0) return
    await this.model.setVisible(undefined, false)
    await this.model.setVisible(localIds, true)
    await this.fragments.core.update(true)
  }

  async hide(localIds: number[]) {
    if (!this.model || localIds.length === 0) return
    await this.model.setVisible(localIds, false)
    await this.fragments.core.update(true)
  }

  async showAll() {
    if (!this.model) return
    await this.model.resetVisible()
    await this.fragments.core.update(true)
  }

  /**
   * Aplica transparencia a un conjunto de elementos.
   *
   * `opacidad` va de 0 (invisible) a 1 (opaco). Se marca el material como
   * transparente y se desactiva la escritura de profundidad: sin eso, un
   * elemento translucido sigue tapando a los que tiene detras y el efecto no
   * sirve para lo que se busca, que es ver a traves.
   */
  async setOpacity(localIds: number[], opacidad: number) {
    if (!this.model || localIds.length === 0) return
    const valor = Math.min(1, Math.max(0, opacidad))
    await this.model.setOpacity(localIds, valor)
    await this.fragments.core.update(true)
  }

  /**
   * Deja translucido todo menos lo indicado.
   *
   * Es el uso habitual al revisar un modelo: ver un elemento en su contexto
   * sin que el resto lo tape. Se limpia la transparencia previa antes de
   * aplicar la nueva, o al cambiar de seleccion se irian acumulando capas.
   */
  async invertOpacity(localIds: number[], opacidad: number) {
    if (!this.model || localIds.length === 0) return
    const seleccion = new Set(localIds)
    const resto = [...this.idsConGeometria].filter((id) => !seleccion.has(id))
    if (resto.length === 0) return

    await this.model.resetOpacity(undefined)
    await this.model.setOpacity(resto, Math.min(1, Math.max(0, opacidad)))
    await this.fragments.core.update(true)
  }

  async resetOpacity(localIds?: number[]) {
    if (!this.model) return
    await this.model.resetOpacity(localIds)
    await this.fragments.core.update(true)
  }

  /** Modo de navegacion de la camara. */
  setNavigation(modo: Navegacion) {
    this.world.camera.set(modo)
  }

  /**
   * Resuelve una vez, al cargar, que elementos afecta cada regla de color.
   * Consultar los nombres es caro y no cambia mientras el modelo este abierto.
   */
  private async resolverRecoloreables() {
    this.idsRecoloreables = COLORES_TEMA_CLARO.map(() => [])
    if (!this.model || this.idsConGeometria.size === 0) return

    const ids = [...this.idsConGeometria]
    const nombres = await this.getNames(ids)
    for (const id of ids) {
      const nombre = nombres.get(id)
      if (!nombre) continue
      COLORES_TEMA_CLARO.forEach((regla, i) => {
        if (regla.patron.test(nombre)) this.idsRecoloreables[i].push(id)
      })
    }
  }

  /** Aplica o retira los colores propios del tema claro. */
  private async aplicarColoresDeTema(tema: Tema) {
    if (!this.model) return
    for (const [i, regla] of COLORES_TEMA_CLARO.entries()) {
      const ids = this.idsRecoloreables[i]
      if (!ids || ids.length === 0) continue
      if (tema === 'claro') {
        await this.model.setColor(ids, new THREE.Color(regla.color))
      } else {
        await this.model.resetColor(ids)
      }
    }
    await this.fragments.core.update(true)
  }

  /** Cambia el fondo de la escena y los colores que dependen del tema. */
  setTheme(tema: Tema) {
    this.temaActual = tema
    this.world.scene.three.background = new THREE.Color(FONDO[tema])
    void this.aplicarColoresDeTema(tema)
  }

  /** Cuantos elementos afecta cada regla de color. Para diagnostico. */
  getRecoloreables() {
    return COLORES_TEMA_CLARO.map((r, i) => ({
      patron: String(r.patron),
      cuantos: this.idsRecoloreables[i]?.length ?? 0,
    }))
  }

  /**
   * Vuelve a la vista general: todo visible, sin transparencias ni resaltados,
   * y la camara encuadrando el modelo completo.
   */
  async resetView() {
    if (!this.model) return
    await this.model.resetVisible()
    await this.model.resetOpacity(undefined)
    await this.model.resetHighlight()
    this.resaltados = []
    // resetHighlight sin argumentos tambien se lleva los colores del tema,
    // porque comparten canal; hay que reponerlos.
    await this.aplicarColoresDeTema(this.temaActual)
    await this.fragments.core.update(true)
    await this.fitToModel()
  }

  /** Encuadra la camara sobre todo el modelo. */
  async fitToModel() {
    if (!this.model) return
    const box = this.model.box
    if (box.isEmpty()) return
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
  async fitToItems(localIds: number[]) {
    if (!this.model || localIds.length === 0) return

    const conGeometria = localIds.filter((id) => this.idsConGeometria.has(id))
    if (conGeometria.length === 0) return

    const box = await this.model.getMergedBox(conGeometria)
    if (box.isEmpty()) return
    await this.world.camera.controls.fitToBox(box, true, {
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: 1,
      paddingBottom: 1,
    })
  }

  dispose() {
    this.container?.removeEventListener('pointerdown', this.handlePointerDown)
    this.container?.removeEventListener('pointerup', this.handlePointerUp)
    this.container = null
    this.model = null
    this.components.dispose()
  }
}
