// Prueba de capacidad: cuantos modelos aguanta una sesion.
//
// No busca un si o un no, sino el punto de ruptura. Monta los archivos uno
// tras otro sin cerrar nada y, despues de cada uno, anota cuanto tardo, que
// trae y si el visor sigue respondiendo. Cada linea se escribe en el momento,
// no al final: si el WebView se queda sin memoria y se cae, lo ya escrito en
// el log de Rust es justamente el dato que interesa.
//
// Se activa con VITE_SELFTEST_CARGA, una lista de rutas separadas por `;`.
// En un build normal no se incluye.

import { useEffect, useState } from 'react'
import { exit } from '@tauri-apps/plugin-process'

import App from './App'
import type { Viewer } from './viewer/Viewer'

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function esperarA(condicion: () => boolean, limiteMs: number) {
  const fin = performance.now() + limiteMs
  while (performance.now() < fin) {
    if (condicion()) return true
    await esperar(250)
  }
  return condicion()
}

const mb = (bytes: number) => (bytes / 1024 ** 2).toFixed(0)
const seg = (ms: number) => (ms / 1000).toFixed(1)

/** Heap de JavaScript. Solo del hilo principal: la geometria vive en los
 *  workers y en la GPU, asi que el dato bueno se mide desde fuera. */
function heapMB(): string {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number } })
    .memory
  return m ? mb(m.usedJSHeapSize) : 'n/d'
}

export default function CargaTest({ rutas }: { rutas: string[] }) {
  const [listo, setListo] = useState(false)

  useEffect(() => {
    let fallos = 0

    const decir = (t: string) => console.info(`[CARGA] ${t}`)

    const correr = async () => {
      decir(`=== INICIO: ${rutas.length} archivos ===`)

      const hayHook = await esperarA(() => !!window.__pruebaAbrir, 15000)
      if (!hayHook) {
        decir('FALLA: la aplicacion no expone el punto de entrada')
        setTimeout(() => void exit(1), 1000)
        return
      }

      const visor = () => window.__pruebaVisor?.() ?? null
      let montados = 0

      for (const [i, ruta] of rutas.entries()) {
        const nombre = ruta.split('\\').pop() ?? ruta
        const n = i + 1
        const t0 = performance.now()

        try {
          // Con limite: un archivo que no termina no puede dejar colgada la
          // prueba entera, que es justo lo que se quiere medir de los demas.
          const abrio = await Promise.race([
            window.__pruebaAbrir!(ruta, i > 0).then(() => true),
            esperar(10 * 60 * 1000).then(() => false),
          ])
          const tardo = performance.now() - t0

          const v = visor()
          const modelos = v?.getModelos() ?? []
          const elementos = modelos.reduce((t, m) => t + m.elementos, 0)

          if (!abrio) {
            fallos += 1
            decir(`${n}/${rutas.length} TIEMPO AGOTADO | ${nombre}`)
            break
          }

          // El aviso de error de la interfaz es la via por la que la
          // aplicacion dice que algo no se pudo abrir.
          const aviso = document.querySelector('.banner-error span')?.textContent
          if (modelos.length > montados) {
            montados = modelos.length
            decir(
              `${n}/${rutas.length} OK | ${nombre} | ${seg(tardo)} s |` +
                ` montados ${modelos.length} | elementos ${elementos.toLocaleString('es-CL')} |` +
                ` heap ${heapMB()} MB`,
            )
          } else {
            fallos += 1
            decir(
              `${n}/${rutas.length} NO MONTO | ${nombre} | ${seg(tardo)} s |` +
                ` aviso: ${aviso ?? 'ninguno'}`,
            )
          }
        } catch (err) {
          fallos += 1
          decir(
            `${n}/${rutas.length} EXCEPCION | ${nombre} |` +
              ` ${err instanceof Error ? err.message : String(err)}`,
          )
        }

        // Cada pocos modelos, comprobar que el visor sigue siendo usable:
        // tener la geometria cargada no sirve de nada si ya no responde.
        if (n % 5 === 0 || n === rutas.length) {
          const v = visor()
          if (v) {
            const lienzo = document.querySelector<HTMLCanvasElement>(
              '.canvas-host canvas',
            )
            const caja = lienzo?.getBoundingClientRect()
            const tr = performance.now()
            const impacto = caja
              ? await v.sondearEn(
                  caja.left + caja.width / 2,
                  caja.top + caja.height / 2,
                )
              : null
            const costeRayo = performance.now() - tr

            const te = performance.now()
            await v.fitToModel()
            const costeEncuadre = performance.now() - te

            decir(
              `   respuesta tras ${n}: rayo ${costeRayo.toFixed(0)} ms` +
                ` (${impacto ? 'toca algo' : 'vacio'}),` +
                ` encuadre ${costeEncuadre.toFixed(0)} ms`,
            )
          }
        }
      }

      const v = visor()
      const modelos = v?.getModelos() ?? []
      decir(
        `=== FIN: ${modelos.length} modelos montados de ${rutas.length},` +
          ` ${fallos} fallos, ` +
          `${modelos.reduce((t, m) => t + m.elementos, 0).toLocaleString('es-CL')} elementos ===`,
      )
      setListo(true)
      // Margen para que el log termine de escribirse antes de cerrar.
      setTimeout(() => void exit(0), 3000)
    }

    void correr()
  }, [rutas])

  return (
    <>
      <App />
      {listo && null}
    </>
  )
}

/** Tipos del puente de pruebas, declarados ya en UiTest. */
declare global {
  interface Window {
    __pruebaAbrir?: (ruta: string, anadir?: boolean) => Promise<void>
    __pruebaVisor?: () => Viewer | null
  }
}
