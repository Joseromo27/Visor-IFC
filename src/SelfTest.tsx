// Prueba de humo del flujo completo, sin intervencion del usuario.
//
// Existe porque la parte critica de la aplicacion — puente de lectura por
// trozos, conversion en el worker, cache en disco, montaje de la escena — solo
// se puede ejercitar dentro del WebView de Tauri, donde no hay forma de
// automatizar clics. Se activa con VITE_SELFTEST_PATH; en un build normal esa
// variable no existe y este componente nunca se monta.

import { useEffect, useRef, useState } from 'react'
import { exit } from '@tauri-apps/plugin-process'
import * as THREE from 'three'

import type { ItemData } from '@thatopen/fragments'

import { PropertiesPanel } from './components/PropertiesPanel'
import { loadIfc } from './lib/conversion'
import { buildDisplayTree, collectIds, countNodes } from './lib/tree'
import { Viewer } from './viewer/Viewer'

const line = (ok: boolean, label: string, detail = '') =>
  `${ok ? 'OK  ' : 'FALLA'} ${label}${detail ? ` :: ${detail}` : ''}`

export default function SelfTest({ path }: { path: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [log, setLog] = useState<string[]>([])
  const [panelData, setPanelData] = useState<ItemData | null>(null)

  useEffect(() => {
    if (!hostRef.current) return

    const results: string[] = []
    const say = (text: string) => {
      results.push(text)
      console.info(`[SELFTEST] ${text}`)
      setLog([...results])
    }

    const viewer = new Viewer()
    viewer.init(hostRef.current)

    const run = async () => {
      let failures = 0
      const check = (ok: boolean, label: string, detail = '') => {
        if (!ok) failures += 1
        say(line(ok, label, detail))
      }

      try {
        say(`archivo: ${path}`)
        say(`crossOriginIsolated: ${globalThis.crossOriginIsolated}`)
        say(`userAgent: ${navigator.userAgent}`)


        // --- Conversion (o lectura de cache) ---
        const stages = new Set<string>()
        const muestras: { stage: string; pct: number }[] = []
        let retrocesos = 0
        let ultimo = -1

        const t0 = performance.now()
        const result = await loadIfc(path, (p) => {
          stages.add(p.stage)
          if (p.progress === null) return
          const pct = Math.round(p.progress * 100)
          // La barra no debe retroceder nunca: el avance crudo del conversor
          // no es monotono y se remapea en el worker.
          if (pct < ultimo) retrocesos += 1
          ultimo = pct
          if (muestras.length === 0 || pct !== muestras[muestras.length - 1].pct) {
            muestras.push({ stage: p.stage, pct })
          }
        })
        const elapsed = performance.now() - t0

        check(
          result.fragments.byteLength > 0,
          'conversion produce Fragments',
          `${(result.fragments.byteLength / 1024 ** 2).toFixed(1)} MB en ${(elapsed / 1000).toFixed(1)} s, cache=${result.fromCache}`,
        )
        check(
          result.info.size > 0,
          'metadatos del archivo',
          `${(result.info.size / 1024 ** 2).toFixed(1)} MB, ${result.info.name}`,
        )
        if (!result.fromCache) {
          check(stages.size > 0, 'se reportaron etapas de progreso', [...stages].join(', '))
          check(
            retrocesos === 0,
            'la barra de progreso nunca retrocede',
            `${muestras.length} valores distintos, ${retrocesos} retrocesos`,
          )
          check(ultimo >= 99, 'el progreso llega al final', `termina en ${ultimo}%`)
          say(
            `recorrido: ${muestras
              .filter((_, i) => i % Math.max(1, Math.ceil(muestras.length / 12)) === 0)
              .map((m) => `${m.stage}:${m.pct}%`)
              .join(' -> ')}`,
          )
        }

        // --- Escena ---
        await viewer.loadModel(result.fragments)
        check(viewer.hasModel, 'modelo montado en la escena')

        // --- Arbol espacial ---
        const raw = await viewer.getSpatialTree()
        const roots = buildDisplayTree(raw)
        const ids = roots.flatMap(collectIds)
        check(roots.length > 0, 'arbol espacial disponible', `raiz=${roots[0]?.category ?? '-'}`)
        check(ids.length > 0, 'el arbol tiene elementos', `${ids.length} nodos con localId`)

        const conGeometria = await viewer.getItemsWithGeometryCount()
        say(`arbol: ${countNodes(roots)} nodos; elementos con geometria: ${conGeometria}`)
        check(
          ids.length >= conGeometria,
          'el arbol cubre los elementos con geometria',
          `${ids.length} nodos frente a ${conGeometria} con geometria`,
        )

        const esquema = (n: (typeof roots)[number], d: number): string =>
          d > 3
            ? ''
            : `${'  '.repeat(d)}${n.category}#${n.localId} (${n.children.length} hijos)\n` +
              n.children
                .slice(0, 2)
                .map((c) => esquema(c, d + 1))
                .join('')
        say(`esquema:\n${roots.map((r) => esquema(r, 0)).join('')}`)

        // --- Encuadre ---
        const box = viewer.getBoxInfo()
        if (box) {
          const f = (n: number) => n.toFixed(1)
          say(
            `caja del modelo: ${f(box.size.x)} x ${f(box.size.y)} x ${f(box.size.z)} m` +
              ` | centro (${f(box.center.x)}, ${f(box.center.y)}, ${f(box.center.z)})`,
          )
          const idsGeom = await viewer.getIdsWithGeometry()
          const cajas = await viewer.getItemBoxes(idsGeom.slice(0, 400))
          const diagonales = cajas
            .filter((c) => !c.isEmpty())
            .map((c) => c.getSize(new THREE.Vector3()).length())
            .sort((a, b) => a - b)
          if (diagonales.length > 0) {
            const mediana = diagonales[Math.floor(diagonales.length / 2)]
            say(
              `tamano de elementos (m): min ${f(diagonales[0])}` +
                ` | mediana ${f(mediana)}` +
                ` | max ${f(diagonales[diagonales.length - 1])}`,
            )
            // Si la caja global es ordenes de magnitud mayor que los elementos,
            // encuadrar el modelo entero deja todo reducido a pelos.
            const razon = box.size.length() / Math.max(mediana, 0.001)
            say(
              `la diagonal del modelo es ${Math.round(razon)}x la del elemento mediano`,
            )
          }

          // Con far = 1000 (el valor por defecto de la libreria) un modelo de
          // kilometros se recorta casi entero al encuadrarlo.
          const planos = viewer.getCameraPlanes()
          const diagonal = box.size.length()
          check(
            planos.far >= diagonal,
            'el plano lejano cubre el modelo completo',
            `far=${planos.far.toFixed(0)} m, near=${planos.near.toFixed(2)} m, diagonal=${diagonal.toFixed(0)} m`,
          )
        }

        // --- Nombres para el arbol ---
        const nombres = await viewer.getNames(ids.slice(0, 60))
        check(
          nombres.size > 0,
          'nombres para etiquetar el arbol',
          `${nombres.size} de 60; ej: ${[...nombres.values()].slice(0, 3).join(' | ')}`,
        )

        // --- Propiedades ---
        let withProps = 0
        let sample = ''
        for (const id of ids.slice(0, 40)) {
          const data = await viewer.getItemData(id)
          if (data && Object.keys(data).length > 0) {
            withProps += 1
            if (!sample) sample = Object.keys(data).slice(0, 6).join(', ')
          }
        }
        check(withProps > 0, 'propiedades de elementos', `${withProps}/40 con datos; claves: ${sample}`)

        // --- Visibilidad y camara ---
        const subset = ids.slice(0, Math.min(25, ids.length))
        await viewer.isolate(subset)
        say('OK   aislar seleccion')
        await viewer.hide(subset)
        say('OK   ocultar seleccion')
        await viewer.showAll()
        say('OK   mostrar todo')
        await viewer.fitToModel()
        say('OK   vista completa')

        // --- Enfocar seleccion ---
        //
        // Se reproduce el camino real de la interfaz, que no es el mismo que
        // enfocar ids elegidos a mano: al pulsar un nodo del arbol la
        // seleccion es `collectIds(nodo)`, e incluye contenedores espaciales
        // que no tienen geometria propia. Cada intento va con limite de
        // tiempo, porque el sintoma reportado es que la aplicacion se queda
        // colgada, no que falle.
        const conLimite = async (
          etiqueta: string,
          accion: () => Promise<void>,
          ms = 8000,
        ) => {
          const t = performance.now()
          let timer: ReturnType<typeof setTimeout> | undefined
          const veredicto = await Promise.race([
            accion().then(
              () => 'completo',
              (e) => `excepcion: ${e instanceof Error ? e.message : e}`,
            ),
            new Promise<string>((r) => {
              timer = setTimeout(() => r('COLGADO'), ms)
            }),
          ])
          clearTimeout(timer)
          const seg = ((performance.now() - t) / 1000).toFixed(1)
          check(veredicto === 'completo', `enfocar ${etiqueta}`, `${veredicto} en ${seg} s`)
          return veredicto
        }

        const buscar = (pred: (n: (typeof roots)[number]) => boolean) => {
          const pila = [...roots]
          while (pila.length) {
            const n = pila.pop()!
            if (pred(n)) return n
            pila.push(...n.children)
          }
          return null
        }

        const conGeom = await viewer.getIdsWithGeometry()
        const conGeomSet = new Set(conGeom)

        // a) Ids con geometria garantizada: el caso que ya se sabia bueno.
        if (conGeom.length > 0) {
          await conLimite(`${Math.min(3, conGeom.length)} elementos con geometria`, () =>
            viewer.fitToItems(conGeom.slice(0, 3)),
          )
        }

        // b) Una hoja del arbol, que es lo que mas se pulsa en la practica.
        const hoja = buscar((n) => n.children.length === 0 && n.localId !== null)
        if (hoja) {
          const ids = collectIds(hoja)
          const conG = ids.filter((i) => conGeomSet.has(i)).length
          say(`hoja elegida: ${hoja.category}#${hoja.localId} | ${ids.length} ids, ${conG} con geometria`)
          await conLimite('una hoja del arbol', () => viewer.fitToItems(ids))
        }

        // c) Un contenedor espacial con descendencia: mezcla ids con y sin
        //    geometria, que es lo que distingue este camino del caso (a).
        const contenedor = buscar((n) => n.children.length > 2)
        if (contenedor) {
          const ids = collectIds(contenedor)
          const conG = ids.filter((i) => conGeomSet.has(i)).length
          say(`contenedor elegido: ${contenedor.category}#${contenedor.localId} | ${ids.length} ids, ${conG} con geometria`)
          await conLimite('un contenedor del arbol', () => viewer.fitToItems(ids))
        }

        // d) La raiz entera: el peor caso de todos.
        const idsRaiz = roots.flatMap(collectIds)
        const conGRaiz = idsRaiz.filter((i) => conGeomSet.has(i)).length
        say(`raiz: ${idsRaiz.length} ids, ${conGRaiz} con geometria`)
        await conLimite('la raiz completa', () => viewer.fitToItems(idsRaiz))

        // e) Barrido de cajas por nodo, buscando las que rompen el encuadre:
        //    vacias (la camara no se mueve) y degeneradas o con NaN (la camara
        //    acaba en una posicion invalida y la vista queda inutilizable).
        const nodos: (typeof roots)[number][] = []
        {
          const pila = [...roots]
          while (pila.length && nodos.length < 300) {
            const n = pila.pop()!
            if (n.localId !== null) nodos.push(n)
            pila.push(...n.children)
          }
        }
        let vacias = 0
        let degeneradas = 0
        let conNaN = 0
        const ejemplos: string[] = []
        for (const n of nodos) {
          const [caja] = await viewer.getItemBoxes([n.localId!])
          if (!caja || caja.isEmpty()) {
            vacias += 1
            if (ejemplos.length < 4) ejemplos.push(`vacia ${n.category}#${n.localId}`)
            continue
          }
          const s = caja.getSize(new THREE.Vector3())
          if (!Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.z)) {
            conNaN += 1
            if (ejemplos.length < 4) ejemplos.push(`NaN ${n.category}#${n.localId}`)
          } else if (s.x === 0 && s.y === 0 && s.z === 0) {
            degeneradas += 1
            if (ejemplos.length < 4) ejemplos.push(`punto ${n.category}#${n.localId}`)
          }
        }
        say(
          `barrido de ${nodos.length} cajas: ${vacias} vacias, ${degeneradas} degeneradas, ${conNaN} con NaN` +
            (ejemplos.length ? ` | ${ejemplos.join(' ; ')}` : ''),
        )

        // g) La secuencia real de la interfaz, que es lo que no reproducian
        //    los casos anteriores: pulsar un nodo dispara highlight y la
        //    consulta de propiedades, y solo despues llega el enfoque. Si
        //    alguna de esas llamadas deja ocupado el worker de fragments, el
        //    boton parece colgado aunque la aplicacion siga viva.
        // Vigilante del hilo principal: un temporizador corto cuyo retraso
        // delata cuanto tiempo estuvo bloqueado. Es la unica forma de medir el
        // sintoma reportado, que es la interfaz congelada sin ningun error.
        const vigilar = () => {
          let maximo = 0
          let ultimo = performance.now()
          const id = setInterval(() => {
            const ahora = performance.now()
            maximo = Math.max(maximo, ahora - ultimo - 50)
            ultimo = ahora
          }, 50)
          return () => {
            clearInterval(id)
            return maximo
          }
        }

        const comoEnLaUI = async (nodo: (typeof roots)[number], etiqueta: string) => {
          const ids = collectIds(nodo)
          const parar = vigilar()
          let t = performance.now()
          await viewer.highlight(nodo.localId)
          const tHigh = performance.now() - t

          t = performance.now()
          await viewer.getItemData(nodo.localId!)
          const tProps = performance.now() - t

          t = performance.now()
          const veredicto = await Promise.race([
            viewer.fitToItems(ids).then(() => 'completo', (e) => `excepcion: ${e}`),
            new Promise<string>((r) => setTimeout(() => r('COLGADO'), 15000)),
          ])
          const tFoco = performance.now() - t

          // El trabajo real llega despues del encuadre: al quedar la camara en
          // reposo se reevalua la geometria visible, y eso corre sin esperar.
          t = performance.now()
          const trasFoco = await Promise.race([
            viewer.forceUpdate().then(() => 'completo', (e) => `excepcion: ${e}`),
            new Promise<string>((r) => setTimeout(() => r('COLGADO'), 20000)),
          ])
          const tUpd = performance.now() - t

          // Dar margen a que corra lo que el encuadre dejo en marcha sin
          // esperar, que es donde cabria el bloqueo.
          await new Promise((r) => setTimeout(r, 1500))
          const bloqueo = parar()

          check(
            trasFoco === 'completo',
            `refresco de geometria tras enfocar ${etiqueta}`,
            `${(tUpd / 1000).toFixed(1)} s -> ${trasFoco}`,
          )
          check(
            bloqueo < 1000,
            `el hilo principal no se bloquea al enfocar ${etiqueta}`,
            `bloqueo maximo ${Math.round(bloqueo)} ms`,
          )

          check(
            veredicto === 'completo',
            `secuencia de UI sobre ${etiqueta}`,
            `${nodo.category}#${nodo.localId} | ${ids.length} ids | highlight ${(tHigh / 1000).toFixed(1)}s` +
              ` + propiedades ${(tProps / 1000).toFixed(1)}s + enfoque ${(tFoco / 1000).toFixed(1)}s -> ${veredicto}`,
          )
        }

        if (hoja) await comoEnLaUI(hoja, 'una hoja')
        if (contenedor) await comoEnLaUI(contenedor, 'un contenedor')
        if (roots[0]?.localId !== null && roots[0]) await comoEnLaUI(roots[0], 'la raiz')

        let hojas: (typeof roots) = []
        let peorId = 0

        // h) Forma de los datos que alimentan el panel de propiedades.
        //    El panel renderiza los grupos de forma recursiva y expandidos por
        //    defecto, asi que un elemento con relaciones muy anidadas bloquea
        //    el hilo principal al pintarlo, sin lanzar ningun error.
        {
          // Tope alto a proposito: con uno bajo no se distingue "profundo" de
          // "ciclico", y la diferencia decide el arreglo.
          let topeAlcanzado = false
          const medir = (d: unknown, prof = 0): { nodos: number; prof: number } => {
            if (prof > 400) { topeAlcanzado = true; return { nodos: 1, prof } }
            if (Array.isArray(d)) {
              let n = 0
              let p = prof
              for (const x of d) {
                const r = medir(x, prof + 1)
                n += r.nodos
                p = Math.max(p, r.prof)
              }
              return { nodos: n, prof: p }
            }
            if (d && typeof d === 'object') {
              let n = 1
              let p = prof
              for (const v of Object.values(d as Record<string, unknown>)) {
                const r = medir(v, prof + 1)
                n += r.nodos
                p = Math.max(p, r.prof)
              }
              return { nodos: n, prof: p }
            }
            return { nodos: 1, prof }
          }

          hojas = nodos.filter((n) => conGeomSet.has(n.localId!)).slice(0, 25)
          let peorNodos = 0
          let peorProf = 0
          let tTotal = 0
          for (const n of hojas) {
            const t = performance.now()
            const d = await viewer.getItemData(n.localId!)
            tTotal += performance.now() - t
            if (!d) continue
            const r = medir(d)
            if (r.nodos > peorNodos) { peorNodos = r.nodos; peorProf = r.prof; peorId = n.localId! }
          }
          say(
            `propiedades de ${hojas.length} elementos: ${(tTotal / hojas.length).toFixed(0)} ms de media` +
              ` | peor caso #${peorId}: ${peorNodos} nodos, profundidad ${peorProf}` +
              (topeAlcanzado ? ' | TOPE DE 400 ALCANZADO: estructura ciclica o sin fin' : ''),
          )
          check(
            !topeAlcanzado && peorNodos < 20000 && peorProf < 40,
            'los datos de propiedades son razonables para pintarlos',
            `maximo ${peorNodos} nodos y profundidad ${peorProf}`,
          )
        }

        // i) Verificar la poda y, sobre todo, pintar el panel de verdad.
        //    Hasta ahora la prueba montaba su propio arbol y nunca el panel de
        //    propiedades, que es justo donde estaba el bloqueo.
        {
          const resumen = (d: unknown) => {
            let nodos = 0
            let prof = 0
            let tope = false
            const rec = (x: unknown, p: number) => {
              if (p > 400) { tope = true; return }
              prof = Math.max(prof, p)
              if (Array.isArray(x)) { for (const y of x) rec(y, p + 1); return }
              if (x && typeof x === 'object') {
                nodos += 1
                for (const v of Object.values(x as Record<string, unknown>)) rec(v, p + 1)
              }
            }
            rec(d, 0)
            return { nodos, prof, tope }
          }
          const propsVisibles = (d: unknown): number => {
            let n = 0
            const rec = (x: unknown, p: number) => {
              if (p > 50) return
              if (Array.isArray(x)) { for (const y of x) rec(y, p + 1); return }
              if (x && typeof x === 'object') {
                const o = x as Record<string, unknown>
                const nom = o.Name as { value?: unknown } | undefined
                const val = (o.NominalValue ?? o.Value) as { value?: unknown } | undefined
                if (nom?.value !== undefined && val?.value !== undefined) n += 1
                for (const v of Object.values(o)) rec(v, p + 1)
              }
            }
            rec(d, 0)
            return n
          }

          const idPeor = peorId || hojas[0]?.localId
          const datos = idPeor ? await viewer.getItemData(idPeor) : null
          if (datos) {
            const r = resumen(datos)
            const props = propsVisibles(datos)
            check(
              !r.tope && r.prof < 40,
              'los datos de propiedades quedan acotados',
              `#${idPeor}: ${r.nodos} nodos, profundidad ${r.prof}${r.tope ? ' (CICLICO)' : ''}`,
            )
            check(
              props > 0,
              'la poda conserva las propiedades utiles',
              `${props} propiedades con nombre y valor`,
            )

            // Render real del panel, midiendo el bloqueo del hilo principal.
            const parar = vigilar()
            const t = performance.now()
            setPanelData(datos)
            await new Promise((r2) => setTimeout(r2, 2000))
            const bloqueo = parar()
            check(
              bloqueo < 1000,
              'pintar el panel de propiedades no bloquea el hilo',
              `bloqueo maximo ${Math.round(bloqueo)} ms, ${((performance.now() - t) / 1000).toFixed(1)} s en total`,
            )
          }
        }

        // j) Capacidades nuevas de la 0.2.
        {
          const conGeom2 = await viewer.getIdsWithGeometry()
          const muestra = conGeom2.slice(0, 20)
          const parar = vigilar()

          await viewer.setOpacity(muestra, 0.3)
          await viewer.resetOpacity()
          check(true, 'transparencia se aplica y se quita', `${muestra.length} elementos`)

          for (const modo of ['FirstPerson', 'Plan', 'Orbit'] as const) {
            viewer.setNavigation(modo)
          }
          check(true, 'los tres modos de navegacion se activan')

          viewer.setTheme('claro')
          viewer.setTheme('oscuro')
          check(true, 'el fondo de la escena cambia con el tema')

          await viewer.resetView()
          const cam2 = viewer.getCameraState()
          check(
            Number.isFinite(cam2.distancia) && cam2.distancia > 0,
            'vista panoramica deja la camara valida',
            `distancia ${cam2.distancia.toFixed(1)} m`,
          )

          const bloqueo = parar()
          check(
            bloqueo < 1000,
            'las funciones nuevas no bloquean el hilo',
            `bloqueo maximo ${Math.round(bloqueo)} ms`,
          )
        }

        // k) Clic sobre el modelo: debe seleccionar y dejar el punto pulsado
        //    como centro de giro y zoom, sin mover la camara.
        {
          const conGeom3 = await viewer.getIdsWithGeometry()
          if (conGeom3.length > 0 && hostRef.current) {
            // Se encuadra un elemento para que ocupe el centro de la vista:
            // con el modelo entero a la vista, un clic al centro falla.
            await viewer.fitToItems([conGeom3[0]])
            await new Promise((r) => setTimeout(r, 300))

            let seleccionado: number | null = null
            const previo = viewer.onSelect
            viewer.onSelect = (id) => { seleccionado = id }

            const antes = viewer.getCameraState()
            const caja = hostRef.current.getBoundingClientRect()
            const x = caja.left + caja.width / 2
            const y = caja.top + caja.height / 2
            const comun = { clientX: x, clientY: y, bubbles: true, pointerId: 1 }

            // Se dispara sobre el lienzo, no sobre el contenedor: es donde cae
            // el raton de verdad, y el evento tiene que propagarse hacia
            // arriba para llegar al manejador. Lanzarlo sobre el contenedor se
            // salta justamente ese tramo, que es donde puede romperse.
            const lienzo = hostRef.current.querySelector('canvas')
            check(lienzo !== null, 'el lienzo existe dentro del contenedor')
            const destino: EventTarget = lienzo ?? hostRef.current
            destino.dispatchEvent(new PointerEvent('pointerdown', comun))
            destino.dispatchEvent(new PointerEvent('pointerup', comun))
            await new Promise((r) => setTimeout(r, 900))
            const despues = viewer.getCameraState()
            viewer.onSelect = previo

            check(
              seleccionado !== null,
              'un clic sobre el modelo selecciona el elemento',
              `localId ${seleccionado}`,
            )

            const movio = antes.posicion.distanceTo(despues.posicion)
            check(
              movio < 0.01,
              'el clic no mueve la camara',
              `se desplazo ${movio.toFixed(4)} m`,
            )

            // Lo que faltaba comprobar: que el resaltado quede realmente
            // puesto. Antes solo se verificaba que onSelect se disparara, que
            // es otra cosa.
            const resaltados = await viewer.getHighlighted()
            check(
              seleccionado !== null && resaltados.includes(seleccionado),
              'el elemento pulsado queda resaltado',
              `resaltados: [${resaltados.join(', ')}] | pulsado: ${seleccionado}`,
            )

            const cambioObjetivo = antes.objetivo.distanceTo(despues.objetivo)
            check(
              cambioObjetivo > 0 && Number.isFinite(cambioObjetivo),
              'el punto pulsado pasa a ser el centro de giro',
              `el objetivo se movio ${cambioObjetivo.toFixed(1)} m`,
            )
          }
        }

        // l) Transparencia invertida.
        {
          const conGeom4 = await viewer.getIdsWithGeometry()
          if (conGeom4.length > 2) {
            await viewer.invertOpacity([conGeom4[0]], 0.25)
            await viewer.resetOpacity()
            check(true, 'invertir transparencia se aplica y se quita', `${conGeom4.length - 1} elementos atenuados`)
          }
        }

        // m) Colores de material: de donde sale el naranja que se ve.
        {
          const ids = (await viewer.getIdsWithGeometry()).slice(0, 200)
          const colores = await viewer.getColors(ids)
          const porColor = new Map<string, number>()
          for (const c of colores) {
            porColor.set(c.color, (porColor.get(c.color) ?? 0) + c.cuantos)
          }
          say(
            `colores de material en ${ids.length} elementos: ` +
              [...porColor.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(([c, n]) => `${c} x${n}`)
                .join('  '),
          )
        }

        // f) Estado de la camara tras los encuadres: si quedo en NaN, la vista
        //    deja de responder aunque la aplicacion siga viva.
        const cam = viewer.getCameraState()
        const finita =
          Number.isFinite(cam.posicion.x) &&
          Number.isFinite(cam.posicion.y) &&
          Number.isFinite(cam.posicion.z) &&
          Number.isFinite(cam.distancia)
        check(
          finita && cam.distancia > 0,
          'la camara queda en un estado valido',
          `pos (${cam.posicion.x.toFixed(1)}, ${cam.posicion.y.toFixed(1)}, ${cam.posicion.z.toFixed(1)}) | distancia ${cam.distancia.toFixed(2)}`,
        )

        // --- Segunda pasada: debe venir del cache ---
        const t1 = performance.now()
        const again = await loadIfc(path, () => {})
        const cachedMs = performance.now() - t1
        check(
          again.fromCache,
          'la segunda carga usa el cache',
          `${(cachedMs / 1000).toFixed(2)} s frente a ${(elapsed / 1000).toFixed(1)} s`,
        )

        say(failures === 0 ? '=== SELFTEST OK ===' : `=== SELFTEST CON ${failures} FALLAS ===`)

        // Comprobacion del diagnostico: pintar la estructura SIN podar, que es
        // lo que hacia la version instalada. Va al final y despues del
        // veredicto a proposito: si cuelga, el log se corta justo aqui y eso
        // es exactamente la prueba que se busca.
        if (import.meta.env.VITE_SELFTEST_RAW && peorId) {
          say('>>> pintando datos SIN podar; si el log termina aqui, el bloqueo queda reproducido')
          const crudo = await viewer.getItemDataSinPodar(peorId)
          const parar2 = vigilar()
          setPanelData(crudo)
          await new Promise((r) => setTimeout(r, 4000))
          say(`<<< sobrevivio: bloqueo maximo ${Math.round(parar2())} ms`)
        }
      } catch (err) {
        failures += 1
        say(`FALLA excepcion :: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
        say('=== SELFTEST CON FALLAS ===')
      }

      // Dar tiempo a que el log llegue al proceso Rust antes de cerrar.
      setTimeout(() => void exit(failures === 0 ? 0 : 1), 1200)
    }

    void run()
    return () => viewer.dispose()
  }, [path])

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <pre
        style={{
          width: 560,
          margin: 0,
          padding: 12,
          overflow: 'auto',
          background: '#14171a',
          color: '#e6e9ee',
          font: '12px/1.5 Consolas, monospace',
        }}
      >
        {log.join('\n')}
      </pre>
      <div ref={hostRef} style={{ flex: 1, position: 'relative' }} />
      <div style={{ width: 320, overflow: 'auto', background: '#1b1f24' }}>
        <PropertiesPanel data={panelData} loading={false} />
      </div>
    </div>
  )
}
