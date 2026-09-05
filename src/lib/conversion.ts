// Orquesta el camino completo de un IFC: dialogo nativo -> cache -> conversion
// en worker -> bytes de Fragments listos para el visor.

import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { exists, readFile, writeFile } from '@tauri-apps/plugin-fs'
import type { ProgressData } from '@thatopen/fragments'

import {
  bridgeAvailable,
  createBridge,
  F_OFFSET,
  I_BYTES_RETURNED,
  I_ERROR,
  I_SIZE_REQUESTED,
  I_STATE,
  S_READY,
} from './bridge'
import type { ConvertRequest, WorkerOut } from '../workers/ifcConverter.worker'

export interface FileInfo {
  size: number
  modified_ms: number | null
  name: string
}

export type Stage = ProgressData['process'] | 'lectura' | 'cache' | 'escena'

export interface LoadProgress {
  stage: Stage
  /** Fraccion 0..1, o `null` cuando la etapa no es medible. */
  progress: number | null
  detail?: string
}

export interface LoadResult {
  fragments: Uint8Array
  info: FileInfo
  fromCache: boolean
  elapsedMs: number
}

/** Etiquetas en espanol para las etapas que reporta el conversor. */
export const STAGE_LABELS: Record<Stage, string> = {
  lectura: 'Leyendo archivo',
  cache: 'Cargando desde cache',
  conversion: 'Convirtiendo a Fragments',
  geometries: 'Procesando geometria',
  attributes: 'Procesando atributos',
  relations: 'Procesando relaciones',
  escena: 'Preparando escena',
}

/** Abre el selector de archivos nativo del sistema operativo. */
export async function pickIfcFile(): Promise<string | null> {
  const selected = await openDialog({
    multiple: false,
    directory: false,
    title: 'Seleccionar archivo IFC',
    filters: [{ name: 'Archivos IFC', extensions: ['ifc'] }],
  })
  return typeof selected === 'string' ? selected : null
}

export const getFileInfo = (path: string) =>
  invoke<FileInfo>('file_info', { path })

/**
 * Version de las opciones de conversion. **Hay que subirla cada vez que cambie
 * algo que altere los Fragments resultantes** (clases importadas, relaciones,
 * compresion): entra en la clave de cache, de modo que los archivos generados
 * con la configuracion anterior se ignoran en vez de devolver un modelo viejo
 * que ya no corresponde al codigo.
 */
const CONVERTER_VERSION = 2

/**
 * Clave de cache derivada de ruta, tamano y fecha de modificacion. Si el
 * usuario reexporta el IFC sobre la misma ruta, la fecha cambia y la entrada
 * anterior deja de usarse en vez de devolver un modelo desactualizado.
 */
async function cacheKey(path: string, info: FileInfo): Promise<string> {
  const material = `v${CONVERTER_VERSION}|${path}|${info.size}|${info.modified_ms ?? 0}`
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(material),
  )
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function cachePathFor(path: string, info: FileInfo): Promise<string> {
  const key = await cacheKey(path, info)
  return invoke<string>('cache_path', { key })
}

/**
 * Atiende las peticiones de trozos del worker. Devuelve la funcion que hay que
 * llamar cuando llega un mensaje `chunk-request`.
 */
function makeChunkServer(
  path: string,
  ctrl: SharedArrayBuffer,
  data: SharedArrayBuffer,
) {
  const i32 = new Int32Array(ctrl)
  const f64 = new Float64Array(ctrl)
  const shared = new Uint8Array(data)

  return async () => {
    const offset = f64[F_OFFSET]
    const len = Atomics.load(i32, I_SIZE_REQUESTED)

    try {
      const chunk = await invoke<ArrayBuffer>('read_chunk', {
        path,
        offset,
        len,
      })
      const view = new Uint8Array(chunk)
      shared.set(view, 0)
      Atomics.store(i32, I_BYTES_RETURNED, view.byteLength)
    } catch (err) {
      console.error('read_chunk fallo', err)
      Atomics.store(i32, I_ERROR, 1)
      Atomics.store(i32, I_BYTES_RETURNED, 0)
    }

    // Despertar al worker, que esta bloqueado en Atomics.wait.
    Atomics.store(i32, I_STATE, S_READY)
    Atomics.notify(i32, I_STATE)
  }
}

/**
 * Lee el archivo completo en memoria, en trozos.
 *
 * Usa el mismo comando nativo que el puente y no el plugin de filesystem: los
 * permisos de la aplicacion solo abren la carpeta de datos, mientras que el IFC
 * puede estar en cualquier parte del disco.
 */
async function readWholeFile(
  path: string,
  onProgress: (p: LoadProgress) => void,
): Promise<Uint8Array> {
  const { size } = await getFileInfo(path)
  const bytes = new Uint8Array(size)
  const CHUNK = 16 * 1024 * 1024
  let offset = 0

  while (offset < size) {
    const chunk = await invoke<ArrayBuffer>('read_chunk', {
      path,
      offset,
      len: Math.min(CHUNK, size - offset),
    })
    const view = new Uint8Array(chunk)
    if (view.byteLength === 0) break
    bytes.set(view, offset)
    offset += view.byteLength
    onProgress({ stage: 'lectura', progress: offset / size })
  }

  return bytes
}

/** Convierte el IFC a Fragments en un worker, informando el avance. */
function convertInWorker(
  path: string,
  onProgress: (p: LoadProgress) => void,
): Promise<{ fragments: Uint8Array; elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('../workers/ifcConverter.worker.ts', import.meta.url),
      { type: 'module' },
    )

    let serveChunk: (() => Promise<void>) | null = null

    const finish = (fn: () => void) => {
      worker.terminate()
      fn()
    }

    worker.onerror = (e) =>
      finish(() => reject(new Error(e.message || 'Error en el worker')))

    worker.onmessage = (event: MessageEvent<WorkerOut>) => {
      const msg = event.data
      switch (msg.type) {
        case 'chunk-request':
          void serveChunk?.()
          break
        case 'progress':
          onProgress({ stage: msg.stage, progress: msg.progress })
          break
        case 'done':
          finish(() =>
            resolve({ fragments: msg.fragments, elapsedMs: msg.elapsedMs }),
          )
          break
        case 'error':
          finish(() => reject(new Error(msg.message)))
          break
      }
    }

    if (bridgeAvailable()) {
      const bridge = createBridge()
      serveChunk = makeChunkServer(path, bridge.ctrl, bridge.data)
      const req: ConvertRequest = {
        type: 'convert',
        path,
        ctrl: bridge.ctrl,
        data: bridge.data,
      }
      worker.postMessage(req)
      return
    }

    // Respaldo sin aislamiento de origen cruzado: se lee el archivo entero.
    // Sirve para modelos chicos; con ~1 GB es muy probable que agote memoria.
    console.warn(
      'Sin crossOriginIsolated: se leera el IFC completo en memoria en vez de por trozos.',
    )
    readWholeFile(path, onProgress)
      .then((bytes) => {
        const req: ConvertRequest = { type: 'convert', path, bytes }
        worker.postMessage(req, [bytes.buffer as ArrayBuffer])
      })
      .catch((err) => finish(() => reject(err)))
  })
}

/**
 * Devuelve los Fragments del IFC indicado, desde el cache si ya se convirtio
 * antes y convirtiendolo en caso contrario.
 */
export async function loadIfc(
  path: string,
  onProgress: (p: LoadProgress) => void,
): Promise<LoadResult> {
  const started = performance.now()
  const info = await getFileInfo(path)
  const cached = await cachePathFor(path, info)

  if (await exists(cached)) {
    onProgress({ stage: 'cache', progress: null })
    const fragments = await readFile(cached)
    return {
      fragments,
      info,
      fromCache: true,
      elapsedMs: performance.now() - started,
    }
  }

  const { fragments, elapsedMs } = await convertInWorker(path, onProgress)

  // Guardar el resultado no debe hacer fallar la carga: si el disco esta lleno
  // o la carpeta no es escribible, el modelo ya esta listo para mostrarse.
  try {
    await writeFile(cached, fragments)
  } catch (err) {
    console.error('No se pudo guardar el cache de Fragments', err)
  }

  return { fragments, info, fromCache: false, elapsedMs }
}
