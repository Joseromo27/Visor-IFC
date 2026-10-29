// Acota los datos de un elemento antes de que lleguen a la interfaz.
//
// `getItemsData` devuelve los property sets siguiendo relaciones, y esas
// relaciones vuelven sobre si mismas: para un muro corriente la estructura
// alcanza decenas de miles de nodos y no termina de bajar. El panel de
// propiedades pinta los grupos de forma recursiva, asi que recibir eso en
// crudo bloquea el hilo del WebView sin lanzar ningun error: la ventana sigue
// viva y se puede cerrar, pero la interfaz dentro no responde.
//
// No se puede evitar en origen pidiendo menos relaciones: con
// `relations: false` la estructura queda limpia pero sin una sola propiedad,
// porque los valores cuelgan un nivel mas abajo. Hay que traerlas y podar.

import type { ItemData } from '@thatopen/fragments'

export interface PodaInfo {
  /** Nodos conservados. */
  nodos: number
  /** Ramas cortadas por superar la profundidad maxima. */
  porProfundidad: number
  /** Ramas cortadas por volver sobre un objeto ya visitado. */
  porCiclo: number
  /** Ramas cortadas por agotar el presupuesto de nodos. */
  porPresupuesto: number
}

const esGrupo = (v: unknown): v is ItemData[] => Array.isArray(v)

/**
 * Devuelve una copia acotada de los datos.
 *
 * @param maxProfundidad Niveles de grupos anidados que se conservan. La cadena
 *   util es elemento > relacion > property set > propiedades, asi que con
 *   holgura basta para no perder nada que se muestre.
 * @param maxNodos Tope duro de seguridad, por si aparece una forma no prevista.
 */
export function podarItemData(
  data: ItemData,
  maxProfundidad = 8,
  maxNodos = 4000,
): { data: ItemData; info: PodaInfo } {
  const info: PodaInfo = {
    nodos: 0,
    porProfundidad: 0,
    porCiclo: 0,
    porPresupuesto: 0,
  }

  // Solo los ancestros de la rama actual: dos hermanos pueden apuntar
  // legitimamente al mismo property set y no es un ciclo.
  const enCamino = new Set<object>()

  const podar = (nodo: ItemData, profundidad: number): ItemData => {
    const salida: ItemData = {}
    info.nodos += 1

    for (const [clave, valor] of Object.entries(nodo)) {
      if (!esGrupo(valor)) {
        salida[clave] = valor
        continue
      }

      if (profundidad >= maxProfundidad) {
        info.porProfundidad += 1
        continue
      }
      if (info.nodos >= maxNodos) {
        info.porPresupuesto += 1
        continue
      }

      const hijos: ItemData[] = []
      for (const hijo of valor) {
        if (typeof hijo !== 'object' || hijo === null) continue
        if (enCamino.has(hijo)) {
          info.porCiclo += 1
          continue
        }
        if (info.nodos >= maxNodos) {
          info.porPresupuesto += 1
          break
        }
        enCamino.add(hijo)
        hijos.push(podar(hijo, profundidad + 1))
        enCamino.delete(hijo)
      }

      if (hijos.length > 0) salida[clave] = hijos
    }

    return salida
  }

  enCamino.add(data)
  const resultado = podar(data, 0)
  enCamino.delete(data)

  return { data: resultado, info }
}
