// Puente sincrono worker -> hilo principal para leer el IFC por trozos.
//
// web-ifc pide los datos con un callback *sincrono* — `(offset, size) =>
// Uint8Array` — pero el acceso al disco solo existe en el hilo principal, a
// traves de la IPC de Tauri, que es asincrona. La unica forma de conciliar
// ambas cosas sin cargar el archivo entero en memoria es bloquear el worker
// con `Atomics.wait` mientras el hilo principal deja el trozo en un
// SharedArrayBuffer. Para un IFC de ~1 GB esto es la diferencia entre
// mantener unas decenas de MB vivos y mantener el archivo completo.
//
// Requiere aislamiento de origen cruzado (COOP/COEP), configurado tanto en
// vite.config.ts para desarrollo como en tauri.conf.json para produccion.
// Si no esta disponible, `conversion.ts` recurre a leer el archivo entero.

/** Capacidad del bufer de datos compartido. Holgada a proposito: si web-ifc
 *  pide mas de lo que cabe, se le devuelve una lectura parcial y vuelve a
 *  pedir el resto, pero cada vuelta cuesta una ida y vuelta por IPC. */
export const CHUNK_CAPACITY = 64 * 1024 * 1024

/** Tamano del bloque de control, en bytes. */
export const CTRL_BYTES = 32

// Indices dentro de la vista Int32Array del bloque de control.
export const I_STATE = 0
export const I_SIZE_REQUESTED = 1
export const I_BYTES_RETURNED = 4
export const I_ERROR = 5

// Indice dentro de la vista Float64Array. Ocupa los bytes 8..15, por eso los
// indices 2 y 3 de la vista Int32Array quedan reservados.
export const F_OFFSET = 1

// Estados posibles de `I_STATE`.
export const S_IDLE = 0
export const S_REQUEST = 1
export const S_READY = 2

export interface SharedBridge {
  ctrl: SharedArrayBuffer
  data: SharedArrayBuffer
}

/** Indica si el navegador permite SharedArrayBuffer + Atomics.wait. */
export function bridgeAvailable(): boolean {
  return (
    typeof SharedArrayBuffer !== 'undefined' &&
    typeof globalThis.crossOriginIsolated === 'boolean' &&
    globalThis.crossOriginIsolated
  )
}

export function createBridge(): SharedBridge {
  return {
    ctrl: new SharedArrayBuffer(CTRL_BYTES),
    data: new SharedArrayBuffer(CHUNK_CAPACITY),
  }
}
