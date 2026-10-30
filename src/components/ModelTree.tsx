// Arbol jerarquico de los modelos montados.
//
// Solo se montan los nodos expandidos, y cada nivel se pagina: un IFC grande
// puede traer cientos de miles de elementos y montarlos todos congela el
// WebView. Los nombres se piden al abrir cada nodo, no de golpe, por la misma
// razon: consultarlos para todo el modelo tarda mas que la propia conversion.
//
// La primera fila de cada rama es el archivo. Con varios IFC montados, dos
// ramas "IfcProject > Obra" identicas no dicen de donde sale cada una.

import { memo, useEffect, useState } from 'react'

import type { TreeNode } from '../lib/tree'
import { claveRef, mismaRef, type Ref } from '../viewer/Viewer'

const PAGE = 100

/** Hasta que profundidad nace abierto el arbol. Cuenta desde la fila del
 *  archivo, asi que deja a la vista proyecto y sitio, como antes de que
 *  existiera esa fila. */
const ABIERTO_HASTA = 3

interface NodeProps {
  node: TreeNode
  depth: number
  selected: Ref | null
  names: Map<string, string>
  ocultos: Set<string>
  onSelect: (node: TreeNode) => void
  onExpand: (refs: Ref[]) => void
  onAlternarModelo: (modelId: string) => void
}

const TreeRow = memo(function TreeRow({
  node,
  depth,
  selected,
  names,
  ocultos,
  onSelect,
  onExpand,
  onAlternarModelo,
}: NodeProps) {
  const [open, setOpen] = useState(depth < ABIERTO_HASTA)
  const [shown, setShown] = useState(PAGE)

  const children = node.children
  const hasChildren = children.length > 0
  const ref =
    node.localId !== null
      ? { modelId: node.modelId, localId: node.localId }
      : null
  const isSelected = mismaRef(ref, selected)
  const oculto = ocultos.has(node.modelId)

  // Pedir los nombres de los hijos visibles cuando el nodo esta abierto.
  useEffect(() => {
    if (!open || !hasChildren) return
    const pending = children
      .slice(0, shown)
      .filter((c) => c.localId !== null)
      .map((c) => ({ modelId: c.modelId, localId: c.localId as number }))
      .filter((r) => !names.has(claveRef(r)))
    if (pending.length > 0) onExpand(pending)
  }, [open, shown, children, hasChildren, names, onExpand])

  const name = ref ? names.get(claveRef(ref)) : undefined
  const label = name ? `${name}` : node.category
  const suffix = name ? node.category : null

  return (
    <li>
      <div
        className={
          `tree-row${isSelected ? ' is-selected' : ''}` +
          `${node.esModelo ? ' tree-row-modelo' : ''}` +
          `${node.esModelo && oculto ? ' is-oculto' : ''}`
        }
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        <button
          type="button"
          className="tree-toggle"
          onClick={() => setOpen((v) => !v)}
          disabled={!hasChildren}
          aria-label={open ? 'Contraer' : 'Expandir'}
        >
          {hasChildren ? (open ? '▾' : '▸') : '·'}
        </button>
        <button
          type="button"
          className="tree-label"
          onClick={() => onSelect(node)}
          title={suffix ? `${label} (${suffix})` : label}
        >
          {label}
          {suffix && <span className="tree-type">{suffix}</span>}
          {hasChildren && <span className="tree-count">{children.length}</span>}
        </button>
        {node.esModelo && (
          <button
            type="button"
            className="tree-ojo"
            onClick={() => onAlternarModelo(node.modelId)}
            title={oculto ? 'Mostrar este modelo' : 'Ocultar este modelo'}
            aria-label={oculto ? 'Mostrar este modelo' : 'Ocultar este modelo'}
          >
            {oculto ? '🚫' : '👁'}
          </button>
        )}
      </div>

      {open && hasChildren && (
        <ul>
          {children.slice(0, shown).map((child, i) => (
            <TreeRow
              key={child.localId ?? `${depth}-${i}`}
              node={child}
              depth={depth + 1}
              selected={selected}
              names={names}
              ocultos={ocultos}
              onSelect={onSelect}
              onExpand={onExpand}
              onAlternarModelo={onAlternarModelo}
            />
          ))}
          {children.length > shown && (
            <li>
              <button
                type="button"
                className="tree-more"
                style={{ marginLeft: `${(depth + 1) * 14 + 8}px` }}
                onClick={() => setShown((v) => v + PAGE)}
              >
                Mostrar {Math.min(PAGE, children.length - shown)} mas
                <span className="tree-count">
                  {children.length - shown} restantes
                </span>
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  )
})

interface Props {
  roots: TreeNode[]
  selected: Ref | null
  names: Map<string, string>
  ocultos: Set<string>
  onSelect: (node: TreeNode) => void
  onExpand: (refs: Ref[]) => void
  onAlternarModelo: (modelId: string) => void
}

export function ModelTree({
  roots,
  selected,
  names,
  ocultos,
  onSelect,
  onExpand,
  onAlternarModelo,
}: Props) {
  if (roots.length === 0) {
    return (
      <p className="panel-empty">Abre un archivo IFC para ver su estructura.</p>
    )
  }

  return (
    <ul className="tree">
      {roots.map((node, i) => (
        <TreeRow
          key={node.esModelo ? node.modelId : (node.localId ?? i)}
          node={node}
          depth={0}
          selected={selected}
          names={names}
          ocultos={ocultos}
          onSelect={onSelect}
          onExpand={onExpand}
          onAlternarModelo={onAlternarModelo}
        />
      ))}
    </ul>
  )
}
