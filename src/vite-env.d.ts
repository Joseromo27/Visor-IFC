/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Ruta a un .ifc para la prueba de humo. Ver src/SelfTest.tsx. */
  readonly VITE_SELFTEST_PATH?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
