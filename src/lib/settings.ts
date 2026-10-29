// Preferencias de la aplicacion, guardadas entre sesiones.
//
// Van en localStorage y no en un archivo del sistema: son preferencias de
// interfaz, no datos del proyecto, y el WebView las conserva en el perfil de
// la aplicacion. Si la lectura falla por lo que sea, se cae a los valores por
// defecto en vez de romper el arranque.

export type Tema = 'oscuro' | 'claro'
export type Navegacion = 'Orbit' | 'FirstPerson' | 'Plan'

export interface Ajustes {
  tema: Tema
  navegacion: Navegacion
  /** Opacidad que aplica el control de transparencia, de 0 a 1. */
  opacidad: number
  /** Si la camara vuelve a encuadrar todo al abrir un modelo. */
  encuadrarAlAbrir: boolean
}

export const AJUSTES_POR_DEFECTO: Ajustes = {
  tema: 'oscuro',
  navegacion: 'Orbit',
  opacidad: 0.3,
  encuadrarAlAbrir: true,
}

export const ETIQUETAS_NAVEGACION: Record<Navegacion, string> = {
  Orbit: 'Orbitar',
  FirstPerson: 'Primera persona',
  Plan: 'Planta',
}

const CLAVE = 'visor-ifc:ajustes'

export function leerAjustes(): Ajustes {
  try {
    const crudo = localStorage.getItem(CLAVE)
    if (!crudo) return { ...AJUSTES_POR_DEFECTO }
    const guardado = JSON.parse(crudo) as Partial<Ajustes>

    // Se valida campo a campo: un ajuste guardado por una version anterior
    // puede traer valores que ya no existen, y no debe dejar la app en un
    // estado imposible.
    return {
      tema: guardado.tema === 'claro' ? 'claro' : 'oscuro',
      navegacion:
        guardado.navegacion === 'FirstPerson' || guardado.navegacion === 'Plan'
          ? guardado.navegacion
          : 'Orbit',
      opacidad:
        typeof guardado.opacidad === 'number' &&
        guardado.opacidad >= 0 &&
        guardado.opacidad <= 1
          ? guardado.opacidad
          : AJUSTES_POR_DEFECTO.opacidad,
      encuadrarAlAbrir:
        typeof guardado.encuadrarAlAbrir === 'boolean'
          ? guardado.encuadrarAlAbrir
          : AJUSTES_POR_DEFECTO.encuadrarAlAbrir,
    }
  } catch {
    return { ...AJUSTES_POR_DEFECTO }
  }
}

export function guardarAjustes(ajustes: Ajustes) {
  try {
    localStorage.setItem(CLAVE, JSON.stringify(ajustes))
  } catch {
    // Que no se puedan guardar las preferencias no justifica interrumpir nada.
  }
}

/** Aplica el tema al documento. El CSS cuelga de `data-tema` en la raiz. */
export function aplicarTema(tema: Tema) {
  document.documentElement.dataset.tema = tema
}
