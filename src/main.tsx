import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import SelfTest from './SelfTest.tsx'
import UiTest from './UiTest.tsx'
import CargaTest from './CargaTest.tsx'
import { forwardConsoleToRust } from './lib/log'
import './App.css'

forwardConsoleToRust()

// Ruta de prueba de humo. Vacia en cualquier build normal.
const selfTestPath = import.meta.env.VITE_SELFTEST_PATH as string | undefined
const pruebaUi = !!import.meta.env.VITE_SELFTEST_UI

// Prueba de capacidad: lista de rutas separadas por `;`.
const rutasCarga = ((import.meta.env.VITE_SELFTEST_CARGA as string | undefined) ?? '')
  .split(';')
  .map((r) => r.trim())
  .filter(Boolean)

// La prueba de humo se monta fuera de StrictMode a proposito: el doble montaje
// de efectos en desarrollo la ejecutaria dos veces y llamaria a exit() dos
// veces sobre la misma ventana.
createRoot(document.getElementById('root')!).render(
  rutasCarga.length > 0 ? (
    <CargaTest rutas={rutasCarga} />
  ) : selfTestPath && pruebaUi ? (
    <UiTest path={selfTestPath} />
  ) : selfTestPath ? (
    <SelfTest path={selfTestPath} />
  ) : (
    <StrictMode>
      <App />
    </StrictMode>
  ),
)
