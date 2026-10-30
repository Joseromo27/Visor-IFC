// Convierte el arbol espacial que entrega fragments en algo mostrable.
//
// `getSpatialStructure` devuelve dos tipos de nodo alternados: nodos de
// agrupacion, que llevan la categoria pero no `localId`, y nodos de entidad,
// que llevan `localId` pero no categoria. Pintar eso tal cual produce una fila
// "sin categoria" por cada elemento del modelo. Aqui se funden ambos en un
// unico nodo por entidad, que es la jerarquia que la gente espera ver:
// proyecto > sitio > edificio o instalacion > piso o tramo > elementos.
//
// Desde que se pueden montar varios IFC a la vez, cada nodo lleva ademas a que
// modelo pertenece: los `localId` solo son unicos dentro de su archivo.

import type { SpatialTreeItem } from '@thatopen/fragments'

import type { Ref } from '../viewer/Viewer'

export interface TreeNode {
  modelId: string
  localId: number | null
  category: string
  children: TreeNode[]
  /** Cierto en la fila que representa el archivo entero. */
  esModelo?: boolean
}

const SIN_CATEGORIA = 'Sin categoria'

function flattenEntity(
  node: SpatialTreeItem,
  category: string,
  modelId: string,
): TreeNode {
  const children: TreeNode[] = []

  for (const child of node.children ?? []) {
    const esAgrupacion = child.localId === null && child.category !== null
    if (esAgrupacion) {
      for (const entity of child.children ?? []) {
        children.push(
          flattenEntity(entity, child.category ?? SIN_CATEGORIA, modelId),
        )
      }
    } else {
      // Forma inesperada: conservar el nodo en vez de descartar la rama.
      children.push(flattenEntity(child, child.category ?? category, modelId))
    }
  }

  return {
    modelId,
    localId: node.localId,
    category: node.category ?? category,
    children,
  }
}

/** Aplana el arbol crudo. Devuelve una lista porque un IFC admite mas de un proyecto. */
export function buildDisplayTree(
  raw: SpatialTreeItem | null,
  modelId: string,
): TreeNode[] {
  if (!raw) return []

  const rootCategory = raw.category ?? SIN_CATEGORIA

  // La raiz es un nodo de agrupacion: sus hijos son los IfcProject.
  if (raw.localId === null && raw.children?.length) {
    return raw.children.map((child) =>
      flattenEntity(child, rootCategory, modelId),
    )
  }

  return [flattenEntity(raw, rootCategory, modelId)]
}

/**
 * Envuelve el arbol de un modelo en una fila con el nombre del archivo.
 *
 * Con varios IFC montados, dos ramas "IfcProject > Obra" identicas no dicen de
 * donde sale cada una. La fila de archivo tambien da donde colgar mostrar u
 * ocultar el modelo entero.
 */
export function modelRoot(
  modelId: string,
  nombre: string,
  raw: SpatialTreeItem | null,
): TreeNode {
  return {
    modelId,
    localId: null,
    category: nombre,
    children: buildDisplayTree(raw, modelId),
    esModelo: true,
  }
}

/** Las referencias de un nodo y toda su descendencia. */
export function collectRefs(node: TreeNode): Ref[] {
  const refs: Ref[] = []
  const stack: TreeNode[] = [node]
  while (stack.length) {
    const current = stack.pop()!
    if (current.localId !== null) {
      refs.push({ modelId: current.modelId, localId: current.localId })
    }
    stack.push(...current.children)
  }
  return refs
}

/** Cuenta total de nodos, para diagnosticos. */
export function countNodes(nodes: TreeNode[]): number {
  let total = 0
  const stack = [...nodes]
  while (stack.length) {
    const current = stack.pop()!
    total += 1
    stack.push(...current.children)
  }
  return total
}
