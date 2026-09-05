// Copia a public/ los binarios que web-ifc y fragments cargan en tiempo de
// ejecucion. Se hace en postinstall para que las versiones copiadas siempre
// coincidan con las de node_modules: el worker de fragments valida que su
// version sea igual a la de la libreria.
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const assets = [
  // Solo la compilacion de un solo hilo: el worker de conversion fuerza ese
  // modo a proposito (ver src/workers/ifcConverter.worker.ts), asi que
  // web-ifc-mt.wasm nunca se pide y solo sumaria peso al ejecutable.
  ['node_modules/web-ifc/web-ifc.wasm', 'public/wasm/web-ifc.wasm'],
  // Version minificada: todo dist/ acaba incrustado en el binario de Tauri.
  [
    'node_modules/@thatopen/fragments/dist/Worker/worker.min.mjs',
    'public/fragments-worker.mjs',
  ],
]

for (const [from, to] of assets) {
  const dest = resolve(root, to)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(resolve(root, from), dest)
  console.log(`copiado  ${from}  ->  ${to}`)
}
