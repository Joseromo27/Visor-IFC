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
  /** Bytes del IFC leidos hasta ahora, si la etapa los mueve. */
  bytesRead?: number
  totalBytes?: number
  /** Entidades IFC procesadas y clase en curso. */
  entities?: number
  ifcClass?: string
  /** Milisegundos desde que empezo la carga. */
  elapsedMs?: number
  /** Estimacion de lo que falta. `null` cuando todavia no es fiable. */
  etaMs?: number | null
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
  onBytes: (bytesRead: number) => void,
) {
  const i32 = new Int32Array(ctrl)
  const f64 = new Float64Array(ctrl)
  const shared = new Uint8Array(data)

  // Se sigue la posicion mas avanzada, no la suma de trozos: web-ifc puede
  // releer zonas ya vistas y sumarlas daria mas del tamano del archivo.
  let furthest = 0

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

      furthest = Math.max(furthest, offset + view.byteLength)
      onBytes(furthest)
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
  totalBytes: number,
  onProgress: (p: LoadProgress) => void,
): Promise<{ fragments: Uint8Array; elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('../workers/ifcConverter.worker.ts', import.meta.url),
      { type: 'module' },
    )

    const startedAt = performance.now()
    let bytesRead = 0
    let lastByteReport = 0
    // web-ifc lee y parsea el archivo entero antes de construir geometria.
    // Una vez que llega el primer avance de conversion se dejan de publicar
    // los avisos de lectura, o la barra alternaria entre dos etapas distintas.
    let conversionStarted = false

    // Lectura y conversion son fases con escalas independientes: cada una va
    // de 0 a 1 por su cuenta. Se reparten un unico recorrido para que la barra
    // avance de principio a fin sin reiniciarse a mitad de camino. El cuarto
    // asignado a la lectura no es solo E/S: dentro va el parseo del STEP, que
    // en modelos grandes pesa lo suyo.
    const PESO_LECTURA = 0.25

    // Red de seguridad: pase lo que pase aguas arriba, la barra no retrocede.
    let ultimo = 0
    const monotono = (v: number) => {
      ultimo = Math.min(1, Math.max(ultimo, v))
      return ultimo
    }

    /**
     * Tiempo restante estimado. Solo a partir de un 3 % de avance: antes de
     * eso el ritmo todavia no se ha estabilizado y la cifra bailaria tanto que
     * seria peor que no mostrar nada.
     */
    const eta = (fraction: number, elapsed: number) =>
      fraction > 0.03 ? (elapsed / fraction) * (1 - fraction) : null

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
        case 'progress': {
          // "conversion" es solo el marcador de arranque y llega antes de leer
          // un solo byte; si contara como inicio de la conversion, el contador
          // de lectura quedaria silenciado durante toda la fase de parseo, que
          // en un modelo de 1 GB es precisamente la mas larga.
          if (msg.stage !== 'conversion') conversionStarted = true
          const elapsedMs = performance.now() - startedAt

          // El marcador de arranque no debe consumir el tramo de lectura: si
          // se mapeara por la escala de conversion saltaria al 25 % antes de
          // leer un byte y la barra se quedaria congelada ahi durante todo el
          // parseo, que con 1 GB son varios minutos.
          const esArranque = msg.stage === 'conversion' && msg.progress <= 0

          onProgress({
            stage: msg.stage,
            progress: esArranque
              ? monotono(0)
              : monotono(PESO_LECTURA + msg.progress * (1 - PESO_LECTURA)),
            bytesRead,
            totalBytes,
            entities: msg.entities,
            ifcClass: msg.ifcClass,
            elapsedMs,
            etaMs: eta(ultimo, elapsedMs),
          })
          break
        }
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
      serveChunk = makeChunkServer(path, bridge.ctrl, bridge.data, (read) => {
        bytesRead = read
        // Durante el parseo inicial el conversor no emite avance propio, asi
        // que estos avisos son lo unico que mueve la barra. Se limitan igual,
        // porque un IFC de 1 GB son cientos de trozos.
        if (conversionStarted) return
        const now = performance.now()
        if (now - lastByteReport < 150 && read < totalBytes) return
        lastByteReport = now

        const elapsedMs = now - startedAt
        const fraction = totalBytes > 0 ? read / totalBytes : 0
        const overall = monotono(fraction * PESO_LECTURA)
        onProgress({
          stage: 'lectura',
          progress: overall,
          bytesRead: read,
          totalBytes,
          elapsedMs,
          etaMs: eta(overall, elapsedMs),
        })
      })
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

  const { fragments, elapsedMs } = await convertInWorker(
    path,
    info.size,
    onProgress,
  )

  // Guardar el resultado no debe hacer fallar la carga: si el disco esta lleno
  // o la carpeta no es escribible, el modelo ya esta listo para mostrarse.
  try {
    await writeFile(cached, fragments)
  } catch (err) {
    console.error('No se pudo guardar el cache de Fragments', err)
  }

  return { fragments, info, fromCache: false, elapsedMs }
}
