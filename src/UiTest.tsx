// Prueba de la interfaz real.
//
// La prueba de humo monta su propio arranque del visor, no la aplicacion: por
// eso dio verde mientras el panel de propiedades congelaba la ventana, y por
// eso vuelve a dar verde con un clic que en la aplicacion no selecciona nada.
// Aqui se monta <App /> tal cual y se interactua con el DOM de verdad.
//
// Se activa con VITE_SELFTEST_UI. En un build normal no se incluye.

import { useEffect, useState } from 'react'
import { exit } from '@tauri-apps/plugin-process'

import App from './App'
import type { Viewer } from './viewer/Viewer'

declare global {
  interface Window {
    /** Lo expone App solo en modo prueba, para abrir sin pasar por el dialogo. */
    __pruebaAbrir?: (ruta: string) => Promise<void>
    /** El visor de la aplicacion, para inspeccionarlo desde la prueba. */
    __pruebaVisor?: () => Viewer | null
  }
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Espera a que una condicion se cumpla, hasta un limite. */
async function esperarA(
  condicion: () => boolean,
  limiteMs: number,
  pasoMs = 250,
): Promise<boolean> {
  const fin = performance.now() + limiteMs
  while (performance.now() < fin) {
    if (condicion()) return true
    await esperar(pasoMs)
  }
  return condicion()
}

export default function UiTest({ path }: { path: string }) {
  const [listo, setListo] = useState(false)

  useEffect(() => {
    const resultados: string[] = []
    let fallos = 0

    const decir = (t: string) => {
      resultados.push(t)
      console.info(`[UITEST] ${t}`)
    }
    const check = (ok: boolean, etiqueta: string, detalle = '') => {
      if (!ok) fallos += 1
      decir(`${ok ? 'OK  ' : 'FALLA'} ${etiqueta}${detalle ? ` :: ${detalle}` : ''}`)
    }

    const correr = async () => {
      try {
        decir(`archivo: ${path}`)

        const hayHook = await esperarA(() => !!window.__pruebaAbrir, 10000)
        check(hayHook, 'la aplicacion expone el punto de entrada de prueba')
        if (!hayHook) throw new Error('sin punto de entrada')

        await window.__pruebaAbrir!(path)

        const lienzo = () =>
          document.querySelector<HTMLCanvasElement>('.canvas-host canvas')
        check(await esperarA(() => !!lienzo(), 20000), 'el lienzo 3D esta montado')

        const filasArbol = () => document.querySelectorAll('.tree-row').length
        check(
          await esperarA(() => filasArbol() > 0, 20000),
          'el arbol se puebla',
          `${filasArbol()} filas visibles`,
        )

        // --- El clic, tal como lo hace una persona ---
        const c = lienzo()!
        const caja = c.getBoundingClientRect()
        const comun = {
          clientX: caja.left + caja.width / 2,
          clientY: caja.top + caja.height / 2,
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          button: 0,
        }
        c.dispatchEvent(new PointerEvent('pointerdown', comun))
        c.dispatchEvent(new PointerEvent('pointerup', comun))

        // Con el modelo entero a la vista no hay nada bajo el cursor: los
        // elementos miden menos de un pixel. Lo que debe comprobarse aqui no
        // es que seleccione, sino que lo diga en vez de no hacer nada.
        await esperar(900)
        const hayPropiedades = () =>
          document.querySelectorAll('.props-row').length > 0
        check(
          !hayPropiedades(),
          'pulsar en vacio no selecciona, como corresponde',
        )
        check(
          !!document.querySelector('.aviso-flotante'),
          'se avisa de que no habia ningun elemento en ese punto',
        )

        // --- Cuan dificil es acertarle a algo ---
        const visor = window.__pruebaVisor?.()
        if (visor) {
          const pulsar = async (px: number, py: number) => {
            const base = { clientX: px, clientY: py, bubbles: true, cancelable: true, pointerId: 1, button: 0 }
            c.dispatchEvent(new PointerEvent('pointerdown', base))
            c.dispatchEvent(new PointerEvent('pointerup', base))
            await esperar(120)
            return (await visor.getHighlighted()).length > 0
          }

          const barrer = async (etiqueta: string) => {
            let aciertos = 0
            const n = 7
            for (let i = 1; i <= n; i++) {
              for (let j = 1; j <= n; j++) {
                const px = caja.left + (caja.width * i) / (n + 1)
                const py = caja.top + (caja.height * j) / (n + 1)
                if (await pulsar(px, py)) aciertos += 1
              }
            }
            decir(`aciertos ${etiqueta}: ${aciertos} de ${n * n} puntos`)
            return aciertos
          }

          const vistaCompleta = await barrer('con el modelo entero a la vista')

          // Medicion justa de la tolerancia: apuntar al centro de un elemento
          // y desviarse N pixeles, que es el error de un clic humano. La
          // rejilla uniforme no mide esto, porque sus fallos caen lejos de
          // cualquier geometria.
          const idsP = await visor.getIdsWithGeometry()
          if (idsP.length > 0) {
            await visor.fitToItems([idsP[0]])
            await esperar(2200)
            const centro = await visor.centroDe(idsP[0])
            const pantalla = centro ? visor.proyectar(centro) : null
            if (pantalla) {
              const aciertosPorDesvio: string[] = []
              for (const desvio of [0, 3, 6, 10, 15, 25]) {
                const ok2 = await pulsar(pantalla.x + desvio, pantalla.y + desvio)
                aciertosPorDesvio.push(`${desvio}px:${ok2 ? 'si' : 'no'}`)
              }
              decir(`acierto apuntando al centro con desvio -> ${aciertosPorDesvio.join('  ')}`)
            } else {
              decir('no se pudo proyectar el centro del elemento a pantalla')
            }
          }

          // Se acerca al elemento mas compacto de una muestra, no al primero:
          // encuadrar una franja de pavimento de kilometros deja la camara tan
          // lejos que el elemento vuelve a ser una linea y no se puede pulsar.
          const ids = await visor.getIdsWithGeometry()
          let masPequeno = ids[0]
          let menorDiagonal = Infinity
          for (const id of ids.slice(0, 120)) {
            const centro2 = await visor.centroDe(id)
            if (!centro2) continue
            const [cajaId] = await visor.getItemBoxes([id])
            if (!cajaId || cajaId.isEmpty()) continue
            const d = cajaId.max.distanceTo(cajaId.min)
            if (d > 0 && d < menorDiagonal) { menorDiagonal = d; masPequeno = id }
          }
          decir(`elemento mas compacto de la muestra: ${masPequeno} (${menorDiagonal.toFixed(1)} m)`)
          await visor.fitToItems([masPequeno])
          await esperar(2200)
          const acercado = await barrer('acercado a un elemento')

          check(
            acercado > 0,
            'acertar a un elemento es posible al acercarse',
            `${acercado} aciertos de 49`,
          )

          // Coste del seguimiento del cursor: el caso malo es moverlo sobre
          // zona vacia, donde se agota la escalera de anillos sin encontrar
          // nada. Si eso fuera caro, mover el raton pondria la app a arrastrar.
          {
            const t0 = performance.now()
            const vueltas = 12
            for (let k = 0; k < vueltas; k++) {
              c.dispatchEvent(new PointerEvent('pointermove', {
                clientX: caja.left + 3 + k, clientY: caja.top + 3,
                bubbles: true, pointerId: 1,
              }))
              await esperar(110)
            }
            const porConsulta = (performance.now() - t0) / vueltas - 110
            decir(`coste del seguimiento sobre zona vacia: ~${porConsulta.toFixed(0)} ms por consulta`)
          }

          // --- Resalte al pasar el cursor ---
          // Buscar un punto que acierte y comprobar que el solo hecho de
          // pasar por encima ya marca el elemento, sin pulsar.
          let puntoBueno: { x: number; y: number } | null = null
          for (let i = 1; i <= 7 && !puntoBueno; i++) {
            for (let j = 1; j <= 7 && !puntoBueno; j++) {
              const px = caja.left + (caja.width * i) / 8
              const py = caja.top + (caja.height * j) / 8
              if (await pulsar(px, py)) puntoBueno = { x: px, y: py }
            }
          }
          if (puntoBueno) {
            await visor.highlight(null)
            await visor.setHover(null)
            await esperar(300)
            const antesDeSobrevolar = (await visor.getHighlighted()).length

            c.dispatchEvent(new PointerEvent('pointermove', {
              clientX: puntoBueno.x, clientY: puntoBueno.y,
              bubbles: true, pointerId: 1,
            }))
            await esperar(700)
            const sobrevolando = (await visor.getHighlighted()).length

            check(
              sobrevolando > antesDeSobrevolar,
              'pasar el cursor por encima resalta el elemento',
              `${antesDeSobrevolar} -> ${sobrevolando} marcados`,
            )

            // Al sacar el cursor del visor el resalte debe apagarse. Se usa
            // pointerleave y no un movimiento a una esquina: una esquina puede
            // tener geometria y entonces el resalte solo cambia de elemento,
            // que es correcto pero no es lo que se quiere comprobar aqui.
            c.dispatchEvent(new PointerEvent('pointerleave', {
              bubbles: true, pointerId: 1,
            }))
            await esperar(700)
            const fuera = (await visor.getHighlighted()).length
            check(
              fuera <= antesDeSobrevolar,
              'al sacar el cursor del visor se apaga el resalte',
              `${sobrevolando} -> ${fuera} marcados`,
            )
          }

          // Y lo que de verdad importa: que al acertar, la interfaz responda.
          if (acercado > 0) {
            let encontrado = false
            for (let i = 1; i <= 7 && !encontrado; i++) {
              for (let j = 1; j <= 7 && !encontrado; j++) {
                const px = caja.left + (caja.width * i) / 8
                const py = caja.top + (caja.height * j) / 8
                if (await pulsar(px, py)) encontrado = true
              }
            }
            const conPropiedades = await esperarA(hayPropiedades, 6000)
            check(
              conPropiedades,
              'al acertarle a un elemento aparecen sus propiedades',
              `${document.querySelectorAll('.props-row').length} filas`,
            )
          }
          if (vistaCompleta === 0) {
            decir(
              'NOTA: con el modelo entero a la vista no se acierta en ningun punto;' +
                ' a esa escala los elementos miden menos de un pixel',
            )
          }
        }

        // --- Recoloreado por tema ---
        const v2 = window.__pruebaVisor?.()
        if (v2) {
          // Diagnostico: que nombres y categorias tienen de verdad los
          // elementos con geometria, que es sobre los que actua la regla.
          const idsG = await v2.getIdsWithGeometry()
          const nombresG = await v2.getNames(idsG)
          const conNombre = idsG.filter((i) => nombresG.has(i)).length
          const ejemplos = [...nombresG.entries()].slice(0, 8).map(([i, n]) => `${i}:"${n}"`)
          decir(`elementos con geometria: ${idsG.length}, con nombre: ${conNombre}`)
          decir(`ejemplos de nombre: ${ejemplos.join('  ')}`)
          const conFirme = [...nombresG.values()].filter((n) => /firme/i.test(n)).length
          decir(`nombres que contienen "firme": ${conFirme}`)

          const reglas = v2.getRecoloreables()
          decir(`reglas de color: ${reglas.map((r) => `${r.patron} -> ${r.cuantos} elementos`).join(' ; ')}`)
          if (conFirme > 0) {
            check(
              reglas.some((r) => r.cuantos > 0),
              'la regla de color encuentra los elementos de firme',
              `${reglas.map((r) => r.cuantos).join(', ')} de ${conFirme} con ese nombre`,
            )
          } else {
            decir('el modelo no tiene elementos de firme; la regla de color no aplica')
          }

          const muestra = (await v2.getIdsWithGeometry()).slice(0, 400)
          v2.setTheme('claro')
          await esperar(1200)
          const claros = await v2.getColors(muestra)
          v2.setTheme('oscuro')
          await esperar(1200)
          const oscuros = await v2.getColors(muestra)
          const resumir = (cs: { color: string; cuantos: number }[]) => {
            const m = new Map<string, number>()
            for (const c of cs) m.set(c.color, (m.get(c.color) ?? 0) + c.cuantos)
            return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c, n]) => `${c} x${n}`).join('  ')
          }
          decir(`colores en tema claro : ${resumir(claros)}`)
          decir(`colores en tema oscuro: ${resumir(oscuros)}`)

          // setColor puede implementarse por el mismo canal que el resaltado.
          // Si es asi, seleccionar un elemento borraria los colores del tema,
          // que seria un fallo sutil y molesto.
          v2.setTheme('claro')
          await esperar(1200)
          const marcadosTrasColor = (await v2.getHighlighted()).length
          decir(`elementos en el canal de resaltado tras recolorear: ${marcadosTrasColor}`)

          const idsSel = await v2.getIdsWithGeometry()
          await v2.highlight(idsSel[0])
          await esperar(600)
          const marcadosTrasSeleccion = (await v2.getHighlighted()).length
          decir(`tras seleccionar uno: ${marcadosTrasSeleccion}`)
          if (conFirme > 0) {
            // El invariante util no es que el total no baje -- si se
            // selecciona un elemento que ya estaba coloreado no suma -- sino
            // que sigan presentes al menos tantos como dice la regla.
            const esperados = reglas.reduce((a, r) => a + r.cuantos, 0)
            check(
              marcadosTrasSeleccion >= esperados,
              'seleccionar no borra los colores del tema',
              `canal de resaltado: ${marcadosTrasColor} -> ${marcadosTrasSeleccion}, esperados al menos ${esperados}`,
            )
          } else {
            decir('sin colores de tema que preservar en este modelo')
          }
          v2.setTheme('oscuro')
        }

        decir(fallos === 0 ? '=== UITEST OK ===' : `=== UITEST CON ${fallos} FALLAS ===`)
      } catch (err) {
        fallos += 1
        decir(`FALLA excepcion :: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
        decir('=== UITEST CON FALLAS ===')
      }
      setListo(true)
      setTimeout(() => void exit(fallos === 0 ? 0 : 1), 1500)
    }

    void correr()
  }, [path])

  return (
    <>
      <App />
      {listo && null}
    </>
  )
}
