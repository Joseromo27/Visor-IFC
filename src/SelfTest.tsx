// Prueba de humo del flujo completo, sin intervencion del usuario.
//
// Existe porque la parte critica de la aplicacion — puente de lectura por
// trozos, conversion en el worker, cache en disco, montaje de la escena — solo
// se puede ejercitar dentro del WebView de Tauri, donde no hay forma de
// automatizar clics. Se activa con VITE_SELFTEST_PATH; en un build normal esa
// variable no existe y este componente nunca se monta.

import { useEffect, useRef, useState } from 'react'
import { exit } from '@tauri-apps/plugin-process'

import { loadIfc } from './lib/conversion'
import { buildDisplayTree, collectIds, countNodes } from './lib/tree'
import { Viewer } from './viewer/Viewer'

const line = (ok: boolean, label: string, detail = '') =>
  `${ok ? 'OK  ' : 'FALLA'} ${label}${detail ? ` :: ${detail}` : ''}`

export default function SelfTest({ path }: { path: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [log, setLog] = useState<string[]>([])

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
    </div>
  )
}
