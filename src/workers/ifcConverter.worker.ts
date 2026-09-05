// Worker que convierte IFC -> Fragments.
//
// Corre fuera del hilo de UI porque la conversion de un modelo grande tarda
// minutos y satura un nucleo por completo. Los datos del IFC llegan de dos
// formas: por el puente compartido (lectura por trozos, la via normal) o como
// un Uint8Array completo cuando el aislamiento de origen cruzado no esta
// disponible.

import { IfcImporter } from '@thatopen/fragments'
import type { ProgressData } from '@thatopen/fragments'
import * as WEBIFC from 'web-ifc'
import {
  CHUNK_CAPACITY,
  F_OFFSET,
  I_BYTES_RETURNED,
  I_ERROR,
  I_SIZE_REQUESTED,
  I_STATE,
  S_REQUEST,
} from '../lib/bridge'

export type ConvertRequest = {
  type: 'convert'
  /** Ruta en disco, solo informativa cuando se usa `bytes`. */
  path: string
  /** Puente compartido; ausente en el modo de respaldo. */
  ctrl?: SharedArrayBuffer
  data?: SharedArrayBuffer
  /** Archivo completo; solo en el modo de respaldo. */
  bytes?: Uint8Array
}

export type WorkerOut =
  | { type: 'chunk-request' }
  | { type: 'progress'; progress: number; stage: ProgressData['process'] }
  | { type: 'done'; fragments: Uint8Array; elapsedMs: number }
  | { type: 'error'; message: string }

/**
 * Obliga a web-ifc a usar su compilacion de un solo hilo.
 *
 * web-ifc elige la version multihilo cuando `self.crossOriginIsolated` es
 * cierto, y emscripten arranca sus hilos con `new Worker(pthreadMainJs)` — sin
 * `{ type: "module" }`. Como este worker es un modulo ES, esos hilos fallan al
 * instante con "Cannot use import statement outside a module" y la conversion
 * se cae. `@thatopen/fragments` llama a `IfcAPI.Init()` sin argumentos, asi que
 * no expone el parametro `forceSingleThread`; la unica forma de decidirlo desde
 * fuera es que la deteccion vea `false`.
 *
 * El aislamiento de origen cruzado sigue activo: SharedArrayBuffer y
 * Atomics.wait, que es lo que necesita el puente de lectura por trozos, no
 * dependen de esta propiedad sino del cluster de agentes.
 */
function forceWebIfcSingleThread() {
  try {
    Object.defineProperty(self, 'crossOriginIsolated', {
      value: false,
      configurable: true,
    })
  } catch {
    // Si el motor no permite sombrear la propiedad, la conversion fallara de
    // forma visible y el mensaje de error lo dejara claro.
    console.warn('No se pudo forzar el modo de un solo hilo en web-ifc')
  }
}

/**
 * Contenedores espaciales de IFC4X3 (obra lineal) que el importador no trae en
 * su lista por defecto, pensada para edificacion.
 *
 * El arbol espacial se arma recorriendo las relaciones de agregacion, pero solo
 * atraviesa entidades que el importador haya serializado; una entidad ausente
 * corta la rama entera que cuelga de ella. En un modelo de carretera la
 * jerarquia es IfcProject > IfcSite > IfcFacility > IfcRoad > IfcRoadPart >
 * elementos, asi que sin IfcFacility el arbol se queda en el sitio y no aparece
 * ni un solo elemento, aunque el modelo tenga miles.
 */
const CLASES_ESPACIALES_IFC4X3 = [
  WEBIFC.IFCFACILITY,
  WEBIFC.IFCFACILITYPART,
  WEBIFC.IFCFACILITYPARTCOMMON,
  WEBIFC.IFCROAD,
  WEBIFC.IFCROADPART,
  WEBIFC.IFCBRIDGE,
  WEBIFC.IFCBRIDGEPART,
  WEBIFC.IFCRAILWAY,
  WEBIFC.IFCRAILWAYPART,
  WEBIFC.IFCMARINEFACILITY,
  WEBIFC.IFCMARINEPART,
  WEBIFC.IFCSPATIALZONE,
  WEBIFC.IFCEXTERNALSPATIALELEMENT,
]

const post = (msg: WorkerOut, transfer?: Transferable[]) =>
  transfer
    ? self.postMessage(msg, { transfer })
    : self.postMessage(msg)

/**
 * Construye el callback sincrono que espera web-ifc. Cada llamada publica la
 * peticion en el bloque de control, avisa al hilo principal y bloquea el
 * worker hasta que los bytes estan en el bufer compartido.
 */
function makeBridgeReader(ctrl: SharedArrayBuffer, data: SharedArrayBuffer) {
  const i32 = new Int32Array(ctrl)
  const f64 = new Float64Array(ctrl)
  const bytes = new Uint8Array(data)

  return (offset: number, size: number): Uint8Array => {
    const want = Math.min(size, CHUNK_CAPACITY)

    f64[F_OFFSET] = offset
    i32[I_SIZE_REQUESTED] = want
    i32[I_BYTES_RETURNED] = 0
    i32[I_ERROR] = 0
    Atomics.store(i32, I_STATE, S_REQUEST)

    // El mensaje se encola antes de bloquear: el hilo principal lo recibe
    // igual, porque el bloqueo solo detiene a este worker.
    post({ type: 'chunk-request' })

    // Vuelve inmediatamente si el hilo principal ya respondio.
    Atomics.wait(i32, I_STATE, S_REQUEST)

    if (Atomics.load(i32, I_ERROR) !== 0) {
      throw new Error('Fallo la lectura del archivo IFC desde el disco')
    }

    const got = Atomics.load(i32, I_BYTES_RETURNED)
    if (got <= 0) return new Uint8Array(0)

    // Hay que copiar: el bufer compartido se reutiliza en la siguiente vuelta.
    return bytes.slice(0, got)
  }
}

self.onmessage = async (event: MessageEvent<ConvertRequest>) => {
  const req = event.data
  if (req.type !== 'convert') return

  const started = performance.now()

  try {
    forceWebIfcSingleThread()

    const importer = new IfcImporter()
    // Los .wasm se copian a public/wasm en postinstall; la ruta absoluta
    // funciona igual en el servidor de Vite y bajo el protocolo de Tauri.
    importer.wasm = { path: '/wasm/', absolute: true }

    for (const clase of CLASES_ESPACIALES_IFC4X3) {
      importer.classes.elements.add(clase)
    }

    // Sin comprimir: el archivo de cache pesa mas, pero abrirlo desde el
    // cache es notablemente mas rapido, que es justamente para lo que existe.
    const raw = true

    let lastSent = 0
    const progressCallback = (progress: number, info: ProgressData) => {
      // Limitar la frecuencia: sin esto la conversion emite miles de mensajes
      // por segundo y la UI se atasca redibujando la barra.
      const now = performance.now()
      if (now - lastSent < 100 && progress < 1) return
      lastSent = now
      post({ type: 'progress', progress, stage: info.process })
    }

    const fragments = req.ctrl && req.data
      ? await importer.process({
          readFromCallback: true,
          readCallback: makeBridgeReader(req.ctrl, req.data),
          raw,
          progressCallback,
        })
      : await importer.process({
          bytes: req.bytes!,
          raw,
          progressCallback,
        })

    post(
      {
        type: 'done',
        fragments,
        elapsedMs: performance.now() - started,
      },
      [fragments.buffer as ArrayBuffer],
    )
  } catch (err) {
    post({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    })
  }
}
