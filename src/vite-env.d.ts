/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Ruta a un .ifc para la prueba de humo. Ver src/SelfTest.tsx. */
  readonly VITE_SELFTEST_PATH?: string
  /** Pinta las propiedades sin podar, para reproducir el bloqueo. */
  readonly VITE_SELFTEST_RAW?: string
  /** Monta la interfaz real y la maneja desde el DOM. Ver src/UiTest.tsx. */
  readonly VITE_SELFTEST_UI?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
