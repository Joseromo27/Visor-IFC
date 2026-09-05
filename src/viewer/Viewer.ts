// Encapsula todo lo que toca Three.js. Los componentes de React nunca hablan
// con la escena directamente: piden cosas a esta clase y reciben datos planos.

import * as OBC from '@thatopen/components'
import * as FRAGS from '@thatopen/fragments'
import * as THREE from 'three'

/** Worker de fragments copiado a public/ en postinstall. Se usa el archivo
 *  local en vez de `FragmentsManager.getWorker()`, que lo descarga de unpkg:
 *  la aplicacion tiene que funcionar sin conexion. */
const FRAGMENTS_WORKER_URL = '/fragments-worker.mjs'

const MODEL_ID = 'modelo'

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

    const localId = hit?.localId ?? null
    await this.highlight(localId)
    this.onSelect?.(localId)
  }

  async loadModel(fragments: Uint8Array) {
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

    await this.fragments.core.update(true)
    await this.fitToModel()
    return this.model
  }

  async disposeModel() {
    if (!this.model) return
    await this.fragments.core.disposeModel(MODEL_ID)
    this.model = null
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

  /** Cantidad de elementos con geometria. Util para contrastar contra el arbol. */
  async getItemsWithGeometryCount(): Promise<number> {
    if (!this.model) return 0
    return (await this.model.getItemsIdsWithGeometry()).length
  }

  async getCategories(): Promise<string[]> {
    if (!this.model) return []
    return this.model.getCategories()
  }

  /** Property sets y atributos de un elemento. */
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
    return data ?? null
  }

  async highlight(localId: number | null) {
    if (!this.model) return
    await this.model.resetHighlight()
    if (localId !== null) {
      await this.model.highlight([localId], HIGHLIGHT)
    }
    await this.fragments.core.update(true)
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

  /** Encuadra la camara sobre un conjunto de elementos. */
  async fitToItems(localIds: number[]) {
    if (!this.model || localIds.length === 0) return
    const box = await this.model.getMergedBox(localIds)
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
