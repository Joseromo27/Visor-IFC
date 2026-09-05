import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import SelfTest from './SelfTest.tsx'
import { forwardConsoleToRust } from './lib/log'
import './App.css'

forwardConsoleToRust()

// Ruta de prueba de humo. Vacia en cualquier build normal.
const selfTestPath = import.meta.env.VITE_SELFTEST_PATH as string | undefined

// La prueba de humo se monta fuera de StrictMode a proposito: el doble montaje
// de efectos en desarrollo la ejecutaria dos veces y llamaria a exit() dos
// veces sobre la misma ventana.
createRoot(document.getElementById('root')!).render(
  selfTestPath ? (
    <SelfTest path={selfTestPath} />
  ) : (
    <StrictMode>
      <App />
    </StrictMode>
  ),
)
