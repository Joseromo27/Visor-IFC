// Prueba de la interfaz real.
//
// La prueba de humo monta su propio arranque del visor, no la aplicacion: por
// eso dio verde mientras el panel de propiedades congelaba la ventana, y por
// eso vuelve a dar verde con un clic que en la aplicacion no selecciona nada.
// Aqui se monta <App /> tal cual y se interactua con el DOM de verdad.
//
// Se activa con VITE_SELFTEST_UI. En un build normal no se incluye.

import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { exit } from '@tauri-apps/plugin-process'
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'
import * as THREE from 'three'

import App from './App'
import { claveRef, mismaRef, type Viewer } from './viewer/Viewer'

declare global {
  interface Window {
    /** Lo expone App solo en modo prueba, para abrir sin pasar por el dialogo. */
    __pruebaAbrir?: (ruta: string, anadir?: boolean) => Promise<void>
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

        // --- Cerrar todo y volver a abrir ---
        //
        // Ciclo que en la 0.3.0 dejaba la aplicacion muerta: la ventana seguia
        // viva, pero con todos los botones apagados menos "Opciones". Se hace
        // por los botones de verdad, porque el fallo estaba en que la espera
        // del visor no volvia nunca y la barra se quedaba en "ocupado"; y con
        // limite de tiempo, para que un cuelgue salga como falla en vez de
        // colgar tambien la prueba.
        const boton = (texto: string) =>
          [...document.querySelectorAll<HTMLButtonElement>('.toolbar button')]
            .find((b) => b.textContent?.trim().startsWith(texto)) ?? null

        const cerrar = boton('Cerrar todo')
        check(!!cerrar && !cerrar.disabled, 'el boton de cerrar todo responde')
        cerrar?.click()
        check(
          await esperarA(() => filasArbol() === 0, 20000),
          'cerrar todo vacia el arbol',
          `${filasArbol()} filas`,
        )
        check(
          await esperarA(() => boton('Abrir IFC')?.disabled === false, 20000),
          'tras cerrar todo la barra vuelve a estar disponible',
          boton('Abrir IFC')?.disabled ? 'los botones siguen apagados' : '',
        )

        // Sin modelos montados, descargar y actualizar tienen que volver en
        // el acto. Aqui estaba el fallo: la espera de la libreria aguardaba un
        // aviso de un worker que ella misma acababa de terminar, y no volvia
        // nunca. Se mide por separado porque desde la interfaz el sintoma
        // (toda la barra apagada) no dice en que llamada se quedo.
        const enPlazo = async (etiqueta: string, fn: () => Promise<unknown>) => {
          const ok = await Promise.race([
            fn().then(
              () => true,
              (e) => {
                decir(`${etiqueta} lanzo :: ${e}`)
                return true
              },
            ),
            esperar(25000).then(() => false),
          ])
          check(ok, `${etiqueta} vuelve con el visor vacio`, ok ? '' : 'sigue esperando a los 25 s')
        }
        const vacio = window.__pruebaVisor!()!
        await enPlazo('descargar todo', () => vacio.disposeAll())
        await enPlazo('actualizar', () => vacio.forceUpdate())

        const reabrio = await Promise.race([
          window.__pruebaAbrir!(path).then(() => true),
          esperar(120000).then(() => false),
        ])
        check(reabrio, 'volver a abrir despues de cerrar todo termina')
        check(
          await esperarA(() => filasArbol() > 0, 20000),
          'el arbol se vuelve a poblar',
          `${filasArbol()} filas`,
        )
        // Se miran las dos filas: la de archivos y la cinta. El cuelgue que
        // esto vigila dejaba todos los botones apagados menos "Opciones".
        const enCintaHabilitado = (texto: string) =>
          [...document.querySelectorAll<HTMLButtonElement>('.cinta button')]
            .find((b) => b.textContent?.trim().startsWith(texto))?.disabled === false
        check(
          await esperarA(
            () =>
              boton('Abrir IFC')?.disabled === false &&
              enCintaHabilitado('Mostrar'),
            20000,
          ),
          'la barra sigue utilizable despues del ciclo',
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
          const idsP = visor.getRefsWithGeometry()
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
          const ids = visor.getRefsWithGeometry()
          if (ids.length === 0) throw new Error('el modelo no trajo geometria')
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
          decir(`elemento mas compacto de la muestra: ${claveRef(masPequeno)} (${menorDiagonal.toFixed(1)} m)`)
          await visor.fitToItems([masPequeno])
          await esperar(2200)
          const acercado = await barrer('acercado a un elemento')

          check(
            acercado > 0,
            'acertar a un elemento es posible al acercarse',
            `${acercado} aciertos de 49`,
          )

          // --- Correspondencia entre lo que se ve y lo que responde ---
          //
          // Es el invariante que faltaba: no basta con que pulsar seleccione
          // algo, tiene que seleccionar lo que hay debajo del cursor. Sin
          // esta comprobacion paso un desfase del ancho del panel lateral.
          {
            const idsC = visor.getRefsWithGeometry()
            let objetivo = idsC[0]
            let menor = Infinity
            for (const id of idsC.slice(0, 120)) {
              const [b] = await visor.getItemBoxes([id])
              if (!b || b.isEmpty()) continue
              const d = b.max.distanceTo(b.min)
              if (d > 0 && d < menor) { menor = d; objetivo = id }
            }
            await visor.fitToItems([objetivo])
            await esperar(2200)

            const centroObj = await visor.centroDe(objetivo)
            const punto = centroObj ? visor.proyectar(centroObj) : null
            if (punto) {
              await visor.highlight(null)
              await visor.setHover(null)
              await esperar(250)

              c.dispatchEvent(new PointerEvent('pointermove', {
                clientX: punto.x, clientY: punto.y, bubbles: true, pointerId: 1,
              }))
              // Con holgura: el seguimiento del cursor va limitado en el
              // tiempo y no se solapa consigo mismo, asi que una consulta
              // puede tardar bastante mas de lo normal si la maquina esta
              // ocupada. Con una espera fija esto fallaba de vez en cuando.
              let marcados = await visor.getHighlighted()
              for (let i = 0; i < 8 && marcados.length === 0; i++) {
                await esperar(250)
                marcados = await visor.getHighlighted()
              }
              // Que resalte justo el objetivo no esta garantizado: puede
              // haber otro elemento delante, y resaltar ese es correcto. Se
              // deja como dato, no como fallo.
              decir(
                `apuntado ${claveRef(objetivo)} en (${punto.x.toFixed(0)}, ${punto.y.toFixed(0)}),` +
                `  resaltado [${marcados.map(claveRef).join(', ')}]`,
              )
              check(marcados.length > 0, 'el cursor resalta algo donde hay geometria')

              // El invariante solido: el punto 3D del impacto, reproyectado a
              // pantalla, debe caer donde se apunto. No depende de que
              // elemento se toque, solo de que las coordenadas cuadren.
              const sondas: number[] = []
              for (const [sx, sy] of [
                [punto.x, punto.y],
                [punto.x + 15, punto.y],
                [punto.x, punto.y + 15],
              ] as [number, number][]) {
                const r = await visor.sondearEn(sx, sy)
                if (r?.desvio != null) sondas.push(r.desvio)
              }
              if (sondas.length > 0) {
                const peor = Math.max(...sondas)
                check(
                  peor < 20,
                  'el impacto del rayo cae donde apunta el cursor',
                  `desvio maximo ${peor.toFixed(1)} px en ${sondas.length} sondas`,
                )
              } else {
                decir('no se pudo sondear: ningun rayo acerto')
              }

              // Medir el desfase: a que distancia horizontal del punto real
              // hay que apuntar para que responda.
              let desfase: number | null = null
              for (const dx of [0, 40, 80, 120, 160, 200, 240, 280, 320, 360, -40, -80]) {
                await visor.setHover(null)
                await esperar(140)
                c.dispatchEvent(new PointerEvent('pointermove', {
                  clientX: punto.x + dx, clientY: punto.y, bubbles: true, pointerId: 1,
                }))
                // Con holgura y no con una espera fija: el seguimiento del
                // cursor va limitado en el tiempo y no se solapa consigo
                // mismo, asi que una consulta puede tardar bastante mas que
                // de costumbre si la maquina esta ocupada. Con 220 ms fijos,
                // una instancia suelta de otra corrida bastaba para que esta
                // medida acusara un desfase de 40 px que no existia.
                let marcado = false
                for (let i = 0; i < 6 && !marcado; i++) {
                  await esperar(180)
                  marcado = (await visor.getHighlighted()).length > 0
                }
                if (marcado) { desfase = dx; break }
              }
              decir(`desfase horizontal necesario para acertar: ${desfase === null ? 'no se encontro' : desfase + ' px'}`)
              check(
                desfase === 0,
                'no hace falta desplazar el cursor para acertar',
                `${desfase} px`,
              )
            }
          }

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

          // --- Cinta, vistas predeterminadas, similares y medicion ---

          const enCinta = (texto: string) =>
            [...document.querySelectorAll<HTMLButtonElement>('.cinta button')]
              .find((b) => b.textContent?.trim().startsWith(texto)) ?? null

          check(
            document.querySelectorAll('.cinta-grupo').length >= 5,
            'la cinta esta desplegada con sus grupos',
            `${document.querySelectorAll('.cinta-grupo').length} grupos`,
          )
          check(
            !!enCinta('Aislar') && !!enCinta('Ocultar') && !!enCinta('Mostrar'),
            'la cinta tiene a la vista los controles de visibilidad',
          )
          check(
            !!enCinta('Planta') && !!enCinta('Isometrica') && !!enCinta('Derecha'),
            'la cinta tiene a la vista las vistas predeterminadas',
          )
          check(
            !!enCinta('Similares') && !!enCinta('Medir'),
            'la cinta tiene a la vista similares y medicion',
          )

          // --- La barra se adapta al ancho de la ventana ---
          //
          // Lo que no puede pasar es que haya que desplazarse por la barra
          // para alcanzar un boton. Se comprueba midiendo el desbordamiento
          // real a tres anchos, no mirando que clase tiene puesta.
          const cinta = () => document.querySelector<HTMLElement>('.cinta')
          const desborda = () => {
            const c = cinta()
            return c ? c.scrollWidth > c.clientWidth + 1 : false
          }
          const disposicion = () => {
            const c = cinta()
            if (!c) return 'sin cinta'
            if (c.classList.contains('is-menus')) return 'menus'
            return c.classList.contains('is-compacta') ? 'compacta' : 'completa'
          }

          const ventana = getCurrentWindow()
          // Minimizada, el area util es 0x0, setSize no hace nada y el
          // WebView conserva la disposicion anterior: se medirian siempre los
          // mismos pixeles y la prueba acusaria un fallo que no existe.
          await ventana.unminimize()
          await ventana.setFocus()
          await esperar(500)
          const tamanoOriginal = await ventana.innerSize()
          const escala = await ventana.scaleFactor()
          const anchear = async (ancho: number) => {
            try {
              await ventana.setSize(new LogicalSize(ancho, 900))
            } catch (err) {
              decir(`setSize(${ancho}) lanzo: ${err}`)
            }
            // Dos cosas tienen que asentarse: el redimensionado del sistema y
            // la remedida de la barra, que ocurre en el siguiente pintado.
            await esperar(900)
            const real = await ventana.innerSize()
            decir(
              `ventana pedida ${ancho} -> interior ${real.width}x${real.height} fisicos,` +
                ` escala ${escala}, maximizada ${await ventana.isMaximized()},` +
                ` lienzo ${cinta()?.clientWidth} px`,
            )
          }

          const visible = (await ventana.innerSize()).width > 0
          if (!visible) {
            decir(
              'NOTA: la ventana no esta visible, no se puede medir como se' +
                ' adapta la barra al ancho',
            )
          }

          await anchear(1440)
          const anchaDisposicion = disposicion()
          check(
            !desborda(),
            `con la ventana ancha la barra cabe entera (${anchaDisposicion})`,
            `${cinta()?.scrollWidth} px de contenido en ${cinta()?.clientWidth} px`,
          )

          await anchear(1100)
          const mediaDisposicion = disposicion()
          check(
            !desborda(),
            `al encoger, la barra se acomoda sin desplazamiento (${mediaDisposicion})`,
            `${cinta()?.scrollWidth} px de contenido en ${cinta()?.clientWidth} px`,
          )

          await anchear(780)
          const estrechaDisposicion = disposicion()
          check(
            !visible || estrechaDisposicion === 'menus',
            'con la ventana estrecha la barra pasa a menus desplegables',
            `disposicion ${estrechaDisposicion}`,
          )
          check(
            !desborda(),
            'tampoco desborda en modo menus',
            `${cinta()?.scrollWidth} px de contenido en ${cinta()?.clientWidth} px`,
          )
          // Los controles siguen estando, solo que dentro del desplegable.
          const botonMenu = [
            ...document.querySelectorAll<HTMLButtonElement>('.cinta button'),
          ].find((b) => b.textContent?.trim().startsWith('Visualizacion'))
          botonMenu?.click()
          await esperar(300)
          check(
            !visible ||
              (!!document.querySelector('.menu-panel') &&
                [...document.querySelectorAll('.menu-panel button')].some(
                  (b) => b.textContent?.trim() === 'Aislar',
                )),
            'el desplegable conserva los controles de la cinta',
          )
          document.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
          )
          await esperar(250)

          await ventana.setSize(
            new LogicalSize(
              Math.round(tamanoOriginal.width / escala),
              Math.round(tamanoOriginal.height / escala),
            ),
          )
          await esperar(900)
          check(
            !visible || (disposicion() !== 'menus' && !desborda()),
            'al volver a ensanchar, la barra vuelve a desplegarse',
            `disposicion ${disposicion()}`,
          )
          decir(
            `disposiciones: 1440 px -> ${anchaDisposicion}, 1100 px -> ${mediaDisposicion},` +
              ` 780 px -> ${estrechaDisposicion}, al volver -> ${disposicion()}`,
          )

          // Cual es la vertical del dato, contrastado contra el propio IFC:
          // el archivo de canales mide 13,5 km en X, 13,0 km en Y y 536 m en
          // Z, y web-ifc rota Z arriba a Y arriba al convertir. En la escena,
          // por tanto, la cota tiene que ser el eje mas corto, y ser Y.
          const tamano = visor.getCajaTotal().getSize(new THREE.Vector3())
          decir(
            `tamano de la escena: X ${tamano.x.toFixed(0)} m,` +
              ` Y ${tamano.y.toFixed(0)} m, Z ${tamano.z.toFixed(0)} m`,
          )
          check(
            tamano.y < tamano.x && tamano.y < tamano.z,
            'la vertical de la escena es Y, que es el eje mas corto de una obra lineal',
            `Y mide ${tamano.y.toFixed(0)} m frente a ${tamano.x.toFixed(0)} y ${tamano.z.toFixed(0)}`,
          )

          // Las vistas tienen que mirar segun el eje que dicen y, sobre todo,
          // desde el lado que dicen: la primera version colocaba la frontal
          // debajo de la obra y mostraba el fondo, con una direccion de
          // camara que igualmente "parecia" horizontal.
          const estadoCamara = () => {
            const cam = visor.getCameraState()
            return {
              ...cam,
              direccion: cam.objetivo.clone().sub(cam.posicion).normalize(),
            }
          }
          const cajaVista = (await visor.getItemBoxes([masPequeno]))[0]
          const alto = cajaVista.max.y - cajaVista.min.y

          await visor.vistaPredeterminada('planta', [masPequeno])
          await esperar(1800)
          const planta = estadoCamara()
          check(
            planta.direccion.y < -0.98,
            'la planta mira hacia abajo segun la vertical',
            `direccion (${planta.direccion.toArray().map((n) => n.toFixed(2)).join(', ')})`,
          )
          check(
            planta.posicion.y > cajaVista.max.y,
            'la planta mira el elemento desde encima, no desde debajo',
            `camara a cota ${planta.posicion.y.toFixed(1)} y techo del elemento en ${cajaVista.max.y.toFixed(1)}`,
          )

          await visor.vistaPredeterminada('inferior', [masPequeno])
          await esperar(1800)
          const inferior = estadoCamara()
          check(
            inferior.direccion.y > 0.98 && inferior.posicion.y < cajaVista.min.y,
            'la inferior mira hacia arriba desde debajo del elemento',
            `direccion (${inferior.direccion.toArray().map((n) => n.toFixed(2)).join(', ')}),` +
              ` camara a cota ${inferior.posicion.y.toFixed(1)} y suelo del elemento en ${cajaVista.min.y.toFixed(1)}`,
          )

          await visor.vistaPredeterminada('frontal', [masPequeno])
          await esperar(1800)
          const frontal = estadoCamara()
          check(
            Math.abs(frontal.direccion.y) < 0.05,
            'la frontal mira en horizontal, no desde arriba ni desde abajo',
            `direccion (${frontal.direccion.toArray().map((n) => n.toFixed(2)).join(', ')})`,
          )
          check(
            Math.abs(frontal.posicion.y - cajaVista.getCenter(new THREE.Vector3()).y) <
              Math.max(1, alto),
            'en la frontal la camara esta a la altura del elemento',
            `camara a cota ${frontal.posicion.y.toFixed(1)}, elemento entre` +
              ` ${cajaVista.min.y.toFixed(1)} y ${cajaVista.max.y.toFixed(1)}`,
          )

          // Y lo que rompia la orbita: ninguna vista puede tocar la vertical
          // de la camara. Si se cambia, todo lo que se orbite despues gira
          // sobre un plano distinto.
          const arriba = visor.getCameraState().arriba
          check(
            Math.abs(arriba.y - 1) < 1e-6 && Math.abs(arriba.x) < 1e-6 && Math.abs(arriba.z) < 1e-6,
            'las vistas no alteran la vertical de la camara',
            `up (${arriba.toArray().map((n) => n.toFixed(3)).join(', ')})`,
          )

          // Y que el elemento quede de verdad encuadrado, no fuera de cuadro.
          const centroEncuadre = await visor.centroDe(masPequeno)
          const enPantalla = centroEncuadre ? visor.proyectar(centroEncuadre) : null
          check(
            !!enPantalla &&
              enPantalla.x > caja.left &&
              enPantalla.x < caja.right &&
              enPantalla.y > caja.top &&
              enPantalla.y < caja.bottom,
            'la vista predeterminada deja el elemento dentro del cuadro',
            enPantalla
              ? `(${enPantalla.x.toFixed(0)}, ${enPantalla.y.toFixed(0)}) en un lienzo de ${caja.width.toFixed(0)}x${caja.height.toFixed(0)}`
              : 'no se pudo proyectar',
          )

          // Elementos parecidos.
          const resumen = await visor.buscarSimilares(masPequeno)
          check(!!resumen, 'se puede analizar un elemento para buscar parecidos')
          if (resumen) {
            decir(
              `similares de "${resumen.nombre}" (${resumen.categoria}):` +
                ` por nombre ${resumen.porNombre.length},` +
                ` por categoria ${resumen.porCategoria.length}`,
            )
            check(
              resumen.porNombre.some((r) => mismaRef(r, masPequeno)),
              'el elemento de partida esta entre sus propios parecidos',
            )
            check(
              resumen.porNombre.length > 0 && resumen.porCategoria.length > 0,
              'los dos criterios devuelven algo',
            )
          }

          // --- Medir ---
          const [cajaObjetivo] = await visor.getItemBoxes([masPequeno])
          if (cajaObjetivo && !cajaObjetivo.isEmpty()) {
            await visor.fitToItems([masPequeno])
            await esperar(2000)

            // Dos puntos separados sobre el propio elemento: se proyectan sus
            // ocho esquinas y se apunta dentro del rectangulo que ocupan.
            const esquinas: { x: number; y: number }[] = []
            for (const ex of [cajaObjetivo.min.x, cajaObjetivo.max.x]) {
              for (const ey of [cajaObjetivo.min.y, cajaObjetivo.max.y]) {
                for (const ez of [cajaObjetivo.min.z, cajaObjetivo.max.z]) {
                  const p = visor.proyectar(new THREE.Vector3(ex, ey, ez))
                  if (p) esquinas.push(p)
                }
              }
            }
            const xs = esquinas.map((p) => p.x)
            const ys = esquinas.map((p) => p.y)
            const medioY = (Math.min(...ys) + Math.max(...ys)) / 2
            const anchoX = Math.max(...xs) - Math.min(...xs)
            const x1 = Math.min(...xs) + anchoX * 0.25
            const x2 = Math.min(...xs) + anchoX * 0.75

            enCinta('Medir')?.click()
            await esperar(300)
            check(
              !!document.querySelector('.viewport.is-midiendo'),
              'activar la medicion cambia el modo del visor',
            )

            const marcadosAntes = (await visor.getHighlighted())
              .map(claveRef)
              .sort()
              .join(',')
            const pulsarEn = async (px: number, py: number) => {
              const base = {
                clientX: px, clientY: py, bubbles: true,
                cancelable: true, pointerId: 1, button: 0,
              }
              c.dispatchEvent(new PointerEvent('pointermove', base))
              await esperar(250)
              c.dispatchEvent(new PointerEvent('pointerdown', base))
              c.dispatchEvent(new PointerEvent('pointerup', base))
              await esperar(400)
            }
            await pulsarEn(x1, medioY)
            await pulsarEn(x2, medioY)

            const medidas = visor.getMediciones()
            check(
              medidas.length === 1,
              'dos clics cierran una medida',
              `${medidas.length} medidas tras dos clics en (${x1.toFixed(0)}, ${medioY.toFixed(0)}) y (${x2.toFixed(0)}, ${medioY.toFixed(0)})`,
            )

            if (medidas.length === 1) {
              const m = medidas[0]
              const diagonal = cajaObjetivo.max.distanceTo(cajaObjetivo.min)
              // Lo que de verdad puede fallar sin avisar es que los puntos
              // salgan en otro sistema de coordenadas: la cifra pareceria
              // razonable y estaria medida a kilometros de donde se pulso.
              const holgura = cajaObjetivo
                .clone()
                .expandByScalar(Math.max(0.5, diagonal * 0.05))
              check(
                holgura.containsPoint(m.a) && holgura.containsPoint(m.b),
                'los puntos medidos caen sobre el elemento al que se apunto',
                `a (${m.a.toArray().map((n) => n.toFixed(1)).join(', ')})` +
                  ` b (${m.b.toArray().map((n) => n.toFixed(1)).join(', ')})` +
                  ` dentro de ${holgura.min.toArray().map((n) => n.toFixed(1)).join(', ')}` +
                  ` .. ${holgura.max.toArray().map((n) => n.toFixed(1)).join(', ')}`,
              )
              check(
                m.distancia > 0 && m.distancia <= diagonal * 1.05,
                'la distancia medida cabe dentro del elemento',
                `${m.distancia.toFixed(3)} m frente a una diagonal de ${diagonal.toFixed(3)} m`,
              )
            }

            const marcadosDespues = (await visor.getHighlighted())
              .map(claveRef)
              .sort()
              .join(',')
            check(
              marcadosDespues === marcadosAntes,
              'mientras se mide, pulsar no cambia la seleccion',
              `[${marcadosAntes}] -> [${marcadosDespues}]`,
            )
            check(
              await esperarA(
                () => document.querySelectorAll('.medida-etiqueta').length > 0,
                4000,
              ),
              'la medida se rotula encima del modelo',
            )

            visor.borrarMediciones()
            check(
              await esperarA(
                () => document.querySelectorAll('.medida-etiqueta').length === 0,
                3000,
              ),
              'borrar las medidas las quita de la pantalla',
            )

            // Escape: primero abandona la medida a medias y solo despues sale
            // de la herramienta. Equivocarse en el segundo punto es mucho mas
            // frecuente que querer salir.
            const escape = () =>
              window.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
              )
            await pulsarEn(x1, medioY)
            check(
              visor.hayMedicionEnCurso(),
              'el primer clic deja una medida empezada',
            )
            escape()
            await esperar(250)
            check(
              !visor.hayMedicionEnCurso() && visor.getModo() === 'medir',
              'Escape abandona la medida a medias sin apagar la herramienta',
              `modo ${visor.getModo()}`,
            )
            escape()
            await esperar(250)
            check(
              visor.getModo() === 'seleccion',
              'el segundo Escape sale de la herramienta',
              `modo ${visor.getModo()}`,
            )
            visor.borrarMediciones()
            await esperar(200)
          }

          // --- Varios modelos montados a la vez ---
          //
          // Lo que se comprueba aqui no es que se vean dos cosas, sino las dos
          // formas en que esto puede salir mal sin avisar: que el segundo
          // modelo se apile sobre el primero (parece correcto y esta a dos
          // kilometros de su sitio), y que la seleccion deje de cuadrar en un
          // modelo desplazado, porque el rayo ignore su transformacion.
          const segundaRuta = import.meta.env.VITE_SELFTEST_PATH2 as
            | string
            | undefined
          if (segundaRuta) {
            decir(`segundo archivo: ${segundaRuta}`)
            await window.__pruebaAbrir!(segundaRuta, true)
            const montados = await esperarA(
              () => visor.getModelos().length === 2,
              120000,
            )
            check(montados, 'se monta un segundo IFC sin quitar el primero',
              `${visor.getModelos().length} modelos`)

            if (montados) {
              const [m1, m2] = visor.getModelos()
              decir(
                `modelos: ${m1.nombre} (${m1.elementos} elem) + ` +
                  `${m2.nombre} (${m2.elementos} elem)`,
              )

              for (const linea of await visor.getCoordsDebug()) decir(linea)

              const off = visor.getOffset(m2.modelId)
              const sep = off?.length() ?? 0
              decir(
                `desplazamiento aplicado al segundo: ` +
                  `(${off?.x.toFixed(1)}, ${off?.y.toFixed(1)}, ${off?.z.toFixed(1)}) m` +
                  ` | modulo ${sep.toFixed(1)} m`,
              )

              // No basta con exigir que el desplazamiento no sea cero: un
              // "mayor que uno" lo cumple igual de bien un error de tres mil
              // kilometros, y eso es exactamente lo que paso la primera vez.
              // Lo que hay que comprobar es que los dos modelos acaben en el
              // mismo sitio del mundo, no que se hayan movido.
              const caja1 = visor.getModelBox(m1.modelId)
              const caja2 = visor.getModelBox(m2.modelId)
              const c1 = caja1?.getCenter(new THREE.Vector3())
              const c2 = caja2?.getCenter(new THREE.Vector3())
              if (c1 && c2 && caja1) {
                const distancia = c1.distanceTo(c2)
                const alcance = caja1.getSize(new THREE.Vector3()).length()
                decir(
                  `centros: (${c1.x.toFixed(0)}, ${c1.y.toFixed(0)}, ${c1.z.toFixed(0)})` +
                    ` y (${c2.x.toFixed(0)}, ${c2.y.toFixed(0)}, ${c2.z.toFixed(0)})` +
                    ` | distancia ${distancia.toFixed(1)} m` +
                    ` | diagonal del primero ${alcance.toFixed(0)} m`,
                )
                check(
                  distancia < alcance,
                  'los dos modelos caen en la misma obra, no en dos sitios distintos',
                  `${distancia.toFixed(1)} m de separacion frente a ${alcance.toFixed(0)} m de modelo`,
                )
              }
              decir(`modulo del desplazamiento: ${sep.toFixed(1)} m`)

              // La regresion que de verdad importa: en un modelo al que se le
              // ha aplicado una transformacion, el rayo tiene que seguir
              // cayendo donde apunta el cursor. Si fragments no invirtiera la
              // matriz del objeto, aqui saldria un desvio enorme.
              const delSegundo = visor
                .getRefsWithGeometry()
                .filter((r) => r.modelId === m2.modelId)
              if (delSegundo.length > 0) {
                let objetivo2 = delSegundo[0]
                let menor2 = Infinity
                for (const r of delSegundo.slice(0, 120)) {
                  const [b] = await visor.getItemBoxes([r])
                  if (!b || b.isEmpty()) continue
                  const d = b.max.distanceTo(b.min)
                  if (d > 0 && d < menor2) { menor2 = d; objetivo2 = r }
                }
                await visor.fitToItems([objetivo2])
                await esperar(2200)

                const centro2b = await visor.centroDe(objetivo2)
                const punto2 = centro2b ? visor.proyectar(centro2b) : null
                if (punto2) {
                  const sondas2: number[] = []
                  for (const [sx, sy] of [
                    [punto2.x, punto2.y],
                    [punto2.x + 15, punto2.y],
                    [punto2.x, punto2.y + 15],
                  ] as [number, number][]) {
                    const r = await visor.sondearEn(sx, sy)
                    if (r?.desvio != null) sondas2.push(r.desvio)
                  }
                  if (sondas2.length > 0) {
                    const peor2 = Math.max(...sondas2)
                    check(
                      peor2 < 20,
                      'en el modelo desplazado el rayo tambien cae donde se apunta',
                      `desvio maximo ${peor2.toFixed(1)} px en ${sondas2.length} sondas`,
                    )
                  } else {
                    decir('no se pudo sondear el segundo modelo: ningun rayo acerto')
                  }

                  // Y que lo que se selecciona pertenece al modelo correcto:
                  // es lo que el identificador compuesto tiene que garantizar.
                  await visor.highlight(null)
                  await visor.setHover(null)
                  await esperar(250)
                  c.dispatchEvent(new PointerEvent('pointermove', {
                    clientX: punto2.x, clientY: punto2.y,
                    bubbles: true, pointerId: 1,
                  }))
                  await esperar(700)
                  const marcados2 = await visor.getHighlighted()
                  decir(`resaltado sobre el segundo modelo: [${marcados2.map(claveRef).join(', ')}]`)
                  if (marcados2.length > 0) {
                    check(
                      marcados2.every((r) => r.modelId === m2.modelId),
                      'apuntando al segundo modelo se resalta ese y no el otro',
                      marcados2.map((r) => r.modelId).join(', '),
                    )
                  }
                }
              }

              // Ocultar un modelo entero: lo que hace util montar varios.
              await visor.setModelVisible(m2.modelId, false)
              await esperar(600)
              const trasOcultar = await visor.sondearEn(
                caja.left + caja.width / 2,
                caja.top + caja.height / 2,
              )
              decir(
                `tras ocultar el segundo modelo, el rayo al centro toca: ` +
                  `${trasOcultar ? claveRef(trasOcultar.ref) : 'nada'}`,
              )
              check(
                !trasOcultar || trasOcultar.ref.modelId !== m2.modelId,
                'un modelo oculto deja de responder al raton',
              )
              await visor.setModelVisible(m2.modelId, true)
              await esperar(400)
            }
          } else {
            decir(
              'NOTA: sin VITE_SELFTEST_PATH2 no se comprueba el montaje de varios IFC',
            )
          }
        }

        // --- Recoloreado por tema ---
        const v2 = window.__pruebaVisor?.()
        if (v2) {
          // Diagnostico: que nombres y categorias tienen de verdad los
          // elementos con geometria, que es sobre los que actua la regla.
          const idsG = v2.getRefsWithGeometry()
          // Los nombres se piden por modelo y se guardan con la clave
          // compuesta: con varios IFC montados los localId se repiten.
          const nombresG = new Map<string, string>()
          for (const m of v2.getModelos()) {
            const soloDeEse = idsG
              .filter((r) => r.modelId === m.modelId)
              .map((r) => r.localId)
            for (const [localId, n] of await v2.getNames(m.modelId, soloDeEse)) {
              nombresG.set(claveRef({ modelId: m.modelId, localId }), n)
            }
          }
          const conNombre = idsG.filter((r) => nombresG.has(claveRef(r))).length
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

          const muestra = (v2.getRefsWithGeometry()).slice(0, 400)
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

          const idsSel = v2.getRefsWithGeometry()
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

        // --- Seleccion por ventana y marca de los excluidos ---
        {
          const vs = window.__pruebaVisor!()!
          const lienzoS = document.querySelector<HTMLCanvasElement>(
            '.canvas-host canvas',
          )!
          const idsS = vs.getRefsWithGeometry()

          // Acercarse a un elemento para tener geometria en pantalla: con el
          // modelo entero a la vista no hay nada que atrapar.
          await vs.fitToItems([idsS[0]])
          await esperar(2000)

          const cajaS = lienzoS.getBoundingClientRect()
          const arrastrar = async (
            x1: number,
            y1: number,
            x2: number,
            y2: number,
          ) => {
            const base = { bubbles: true, cancelable: true, pointerId: 1 }
            lienzoS.dispatchEvent(
              new PointerEvent('pointerdown', {
                ...base, clientX: x1, clientY: y1, button: 0, buttons: 1,
                shiftKey: true,
              }),
            )
            lienzoS.dispatchEvent(
              new PointerEvent('pointermove', {
                ...base, clientX: x2, clientY: y2, buttons: 1, shiftKey: true,
              }),
            )
            lienzoS.dispatchEvent(
              new PointerEvent('pointerup', {
                ...base, clientX: x2, clientY: y2, button: 0, shiftKey: true,
              }),
            )
            await esperar(900)
          }

          await vs.highlight(null)
          await esperar(300)
          await arrastrar(
            cajaS.left + cajaS.width * 0.2,
            cajaS.top + cajaS.height * 0.2,
            cajaS.left + cajaS.width * 0.8,
            cajaS.top + cajaS.height * 0.8,
          )

          const atrapados = await vs.getHighlighted()
          check(
            atrapados.length > 1,
            'arrastrando con Mayusculas se seleccionan varios de una vez',
            `${atrapados.length} elementos en la ventana`,
          )

          // Y la ventana no puede orbitar la camara a la vez que selecciona.
          const camaraAntes = vs.getCameraState().posicion.clone()
          await arrastrar(
            cajaS.left + cajaS.width * 0.3,
            cajaS.top + cajaS.height * 0.3,
            cajaS.left + cajaS.width * 0.7,
            cajaS.top + cajaS.height * 0.7,
          )
          const movida = camaraAntes.distanceTo(vs.getCameraState().posicion)
          check(
            movida < 0.5,
            'dibujar la ventana no mueve la camara',
            `la camara se movio ${movida.toFixed(2)} m`,
          )

          // Marca de los excluidos: tiene que verse, y verse distinta.
          // Se suelta antes la seleccion de la ventana: comparten canal, y si
          // no, no se sabria cual de los dos estados deja cada marca.
          await vs.setMarcados([])
          await esperar(400)
          const paraExcluir = idsS.slice(0, 3)
          await vs.setExcluidos(paraExcluir)
          await esperar(700)
          // Se comprueba por el canal de resaltado y no por el color: la
          // libreria solo deja leer el material propio del elemento, que no
          // cambia aunque encima se le pinte una marca.
          const marcadosFuera = (await vs.getHighlighted()).map(claveRef)
          check(
            paraExcluir.every((r) => marcadosFuera.includes(claveRef(r))),
            'los elementos excluidos quedan marcados en el modelo',
            `${marcadosFuera.length} marcados, se esperaban al menos` +
              ` ${paraExcluir.length}`,
          )

          await vs.setExcluidos([])
          await esperar(700)
          const tras = (await vs.getHighlighted()).map(claveRef)
          check(
            !paraExcluir.some((r) => tras.includes(claveRef(r))),
            'al sacarlos de la lista se les quita la marca',
            `quedan ${tras.length} marcados`,
          )
          await vs.setMarcados([])
          await esperar(300)
        }

        // --- Vista panoramica y zoom ---
        //
        // Dos averias con la misma raiz: los limites que la libreria le pone
        // a la camara estan pensados para un edificio —objetivo entre 1 y
        // 300 m— y este modelo mide kilometros.
        //
        // La panoramica no encuadraba el proyecto porque el encuadre se
        // recortaba a esos 300 m. Y la rueda saltaba porque, pasado el tope,
        // `infinityDolly` deja de acercar la camara y lo que hace es empujar
        // el objetivo: el paso dejaba de valer una fraccion de lo que uno
        // tiene delante y pasaba a valer una fraccion de los 300 m del tope,
        // asi que a dos metros de un muro un tic lo atravesaba.
        {
          const vn = window.__pruebaVisor!()!
          await vn.resetView()
          await esperar(2000)

          const desborde = vn.getDesborde()
          check(
            desborde <= 1.05,
            'la vista panoramica encuadra el proyecto entero',
            `la esquina mas lejana cae a ${desborde.toFixed(2)} del centro` +
              ' (1,00 es el borde de la pantalla)',
          )

          const lienzoN = document.querySelector<HTMLCanvasElement>(
            '.canvas-host canvas',
          )!
          const cajaN = lienzoN.getBoundingClientRect()
          const cx = cajaN.left + cajaN.width / 2
          const cy = cajaN.top + cajaN.height / 2

          const rueda = async (veces: number, reposo: number) => {
            for (let i = 0; i < veces; i++) {
              lienzoN.dispatchEvent(
                new WheelEvent('wheel', {
                  clientX: cx,
                  clientY: cy,
                  deltaY: -120,
                  bubbles: true,
                  cancelable: true,
                }),
              )
              await esperar(30)
            }
            await esperar(reposo)
          }

          // Tic a tic, con la camara parada entre uno y otro: asi es como se
          // mira un detalle, y es donde se notaban los saltos.
          const pasos: number[] = []
          const hasta: number[] = []
          let antes = vn.getCameraState()
          for (let i = 0; i < 12; i++) {
            await rueda(1, 500)
            const ahora = vn.getCameraState()
            pasos.push(ahora.posicion.distanceTo(antes.posicion))
            hasta.push(antes.distancia)
            antes = ahora
          }
          decir(
            `zoom tic a tic (m recorridos): ${pasos
              .map((d) => d.toFixed(1))
              .join(', ')}`,
          )
          decir(
            `distancia al objetivo antes de cada tic (m): ${hasta
              .map((d) => d.toFixed(1))
              .join(', ')}`,
          )

          // Un tic se come una fraccion de lo que hay hasta el objetivo.
          // Comerse mas de la mitad es el salto que se denuncia.
          const saltos = pasos.filter((p, i) => p > hasta[i] * 0.5)
          check(
            saltos.length === 0,
            'ningun tic de rueda se lleva por delante lo que hay delante',
            `${saltos.length} de ${pasos.length} tics pasan de la mitad de la` +
              ' distancia al objetivo',
          )

          // Y de un tic al siguiente el paso cambia poco: el avance es
          // geometrico, cada uno vale algo menos que el anterior. Un repunte
          // es el rebote.
          const repunte = Math.max(
            ...pasos.slice(1).map((p, i) => (pasos[i] > 0 ? p / pasos[i] : 99)),
          )
          check(
            repunte < 1.6,
            'el zoom avanza parejo, sin rebotes',
            `el mayor repunte entre dos tics es x${repunte.toFixed(2)}`,
          )

          // Y en tandas seguidas, que es como se recorre distancia: tiene que
          // seguir avanzando por mucho que uno se acerque.
          const partida = vn.getCameraState()
          const avances: number[] = []
          let previa = partida.posicion.clone()
          for (let tanda = 0; tanda < 4; tanda++) {
            await rueda(10, 900)
            const ahora = vn.getCameraState().posicion.clone()
            avances.push(ahora.distanceTo(previa))
            previa = ahora
          }
          decir(
            `zoom por tandas de 10 (m recorridos): ${avances
              .map((d) => d.toFixed(1))
              .join(', ')}`,
          )
          const ultima = avances[avances.length - 1]
          check(
            ultima > 0.05,
            'la rueda sigue avanzando por mucho que uno se acerque',
            `primera tanda ${avances[0].toFixed(1)} m, ultima ${ultima.toFixed(2)} m`,
          )

          // Y despues de todo ese zoom, la panoramica tiene que volver a
          // encuadrarlo todo: es el caso en el que fallaba.
          await vn.resetView()
          await esperar(2000)
          const vuelta = vn.getDesborde()
          check(
            vuelta <= 1.05,
            'la panoramica vuelve a encuadrar despues de hacer zoom',
            `la esquina mas lejana cae a ${vuelta.toFixed(2)} del centro`,
          )
        }

        // --- Entregable depurado ---
        //
        // Lo que hay que demostrar no es que el archivo salga, sino que salga
        // exactamente el original menos lo pedido. Un filtro de texto mal
        // hecho se lleva por delante una relacion compartida y tumba
        // elementos que nadie marco, y eso mirando el visor no se ve: los
        // elementos que faltan simplemente no estan.
        {
          await window.__pruebaAbrir!(path)
          await esperar(1200)
          const v3 = window.__pruebaVisor!()!

          const antes = v3.getRefsWithGeometry()
          const guidsAntes = await v3.getGuids(antes)
          decir(`entregable: el original trae ${antes.length} elementos con geometria`)

          // Se quita una familia entera, que es el caso real: "esta OA sobra".
          const familia = await v3.buscarSimilares(antes[0])
          const aQuitar = (familia?.porNombre ?? []).slice(0, 40)
          check(
            aQuitar.length > 0,
            'hay una familia que excluir del entregable',
            `${aQuitar.length} elementos de "${familia?.nombre}"`,
          )

          if (aQuitar.length > 0) {
            const guidsQuitados = await v3.getGuids(aQuitar)
            const marcados = [...guidsQuitados.values()]
            const modelo = v3.getModelos()[0]
            const destino = modelo.ruta.replace(/\.ifc$/i, '_prueba_depurado.ifc')

            let informe: {
              eliminados: number
              relaciones_reparadas: number
              relaciones_eliminadas: number
              bytes_entrada: number
              bytes_salida: number
              no_encontrados: string[]
            } | null = null
            try {
              informe = await invoke('depurar_ifc', {
                origen: modelo.ruta,
                destino,
                guids: marcados,
                nota: 'Prueba automatica',
              })
            } catch (err) {
              check(false, 'se puede escribir el entregable depurado', String(err))
            }

            if (informe) {
              decir(
                `entregable: ${informe.eliminados} fuera,` +
                  ` ${informe.relaciones_reparadas} relaciones ajustadas,` +
                  ` ${informe.relaciones_eliminadas} retiradas,` +
                  ` ${(informe.bytes_entrada / 1024 ** 2).toFixed(1)} MB ->` +
                  ` ${(informe.bytes_salida / 1024 ** 2).toFixed(1)} MB`,
              )
              check(
                informe.eliminados === marcados.length &&
                  informe.no_encontrados.length === 0,
                'se quitan exactamente los elementos marcados',
                `${informe.eliminados} de ${marcados.length} pedidos`,
              )
              check(
                informe.bytes_salida < informe.bytes_entrada,
                'el archivo depurado es mas pequeno que el original',
              )

              // Y la comprobacion que importa: abrirlo y comparar los GUID.
              await window.__pruebaAbrir!(destino)
              await esperar(1500)
              const v4 = window.__pruebaVisor!()!
              const despues = v4.getRefsWithGeometry()
              const guidsDespues = new Set(
                (await v4.getGuids(despues)).values(),
              )

              const quitados = new Set(marcados)
              const esperados = new Set(
                [...guidsAntes.values()].filter((g) => !quitados.has(g)),
              )
              const sobran = [...guidsDespues].filter((g) => !esperados.has(g))
              const faltan = [...esperados].filter((g) => !guidsDespues.has(g))

              check(
                sobran.length === 0 && faltan.length === 0,
                'el depurado es el original menos lo marcado, ni un elemento mas',
                `${guidsDespues.size} elementos: faltan ${faltan.length},` +
                  ` sobran ${sobran.length}` +
                  (faltan.length > 0 ? ` (p.ej. ${faltan.slice(0, 3).join(', ')})` : ''),
              )
              check(
                ![...guidsDespues].some((g) => quitados.has(g)),
                'ninguno de los excluidos sobrevive en el archivo',
              )
            }
          }
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
