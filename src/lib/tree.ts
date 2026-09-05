// Convierte el arbol espacial que entrega fragments en algo mostrable.
//
// `getSpatialStructure` devuelve dos tipos de nodo alternados: nodos de
// agrupacion, que llevan la categoria pero no `localId`, y nodos de entidad,
// que llevan `localId` pero no categoria. Pintar eso tal cual produce una fila
// "sin categoria" por cada elemento del modelo. Aqui se funden ambos en un
// unico nodo por entidad, que es la jerarquia que la gente espera ver:
// proyecto > sitio > edificio o instalacion > piso o tramo > elementos.

import type { SpatialTreeItem } from '@thatopen/fragments'

export interface TreeNode {
  localId: number | null
  category: string
  children: TreeNode[]
}

const SIN_CATEGORIA = 'Sin categoria'

function flattenEntity(node: SpatialTreeItem, category: string): TreeNode {
  const children: TreeNode[] = []

  for (const child of node.children ?? []) {
    const esAgrupacion = child.localId === null && child.category !== null
    if (esAgrupacion) {
      for (const entity of child.children ?? []) {
        children.push(flattenEntity(entity, child.category ?? SIN_CATEGORIA))
      }
    } else {
      // Forma inesperada: conservar el nodo en vez de descartar la rama.
      children.push(flattenEntity(child, child.category ?? category))
    }
  }

  return {
    localId: node.localId,
    category: node.category ?? category,
    children,
  }
}

/** Aplana el arbol crudo. Devuelve una lista porque un IFC admite mas de un proyecto. */
export function buildDisplayTree(raw: SpatialTreeItem | null): TreeNode[] {
  if (!raw) return []

  const rootCategory = raw.category ?? SIN_CATEGORIA

  // La raiz es un nodo de agrupacion: sus hijos son los IfcProject.
  if (raw.localId === null && raw.children?.length) {
    return raw.children.map((child) => flattenEntity(child, rootCategory))
  }

  return [flattenEntity(raw, rootCategory)]
}

/** Los localId de un nodo y toda su descendencia. */
export function collectIds(node: TreeNode): number[] {
  const ids: number[] = []
  const stack: TreeNode[] = [node]
  while (stack.length) {
    const current = stack.pop()!
    if (current.localId !== null) ids.push(current.localId)
    stack.push(...current.children)
  }
  return ids
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
