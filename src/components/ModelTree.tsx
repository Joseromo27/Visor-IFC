// Arbol jerarquico del modelo.
//
// Solo se montan los nodos expandidos, y cada nivel se pagina: un IFC grande
// puede traer cientos de miles de elementos y montarlos todos congela el
// WebView. Los nombres se piden al abrir cada nodo, no de golpe, por la misma
// razon: consultarlos para todo el modelo tarda mas que la propia conversion.

import { memo, useEffect, useState } from 'react'

import type { TreeNode } from '../lib/tree'

const PAGE = 100

interface NodeProps {
  node: TreeNode
  depth: number
  selected: number | null
  names: Map<number, string>
  onSelect: (node: TreeNode) => void
  onExpand: (ids: number[]) => void
}

const TreeRow = memo(function TreeRow({
  node,
  depth,
  selected,
  names,
  onSelect,
  onExpand,
}: NodeProps) {
  const [open, setOpen] = useState(depth < 2)
  const [shown, setShown] = useState(PAGE)

  const children = node.children
  const hasChildren = children.length > 0
  const isSelected = node.localId !== null && node.localId === selected

  // Pedir los nombres de los hijos visibles cuando el nodo esta abierto.
  useEffect(() => {
    if (!open || !hasChildren) return
    const pending = children
      .slice(0, shown)
      .map((c) => c.localId)
      .filter((id): id is number => id !== null && !names.has(id))
    if (pending.length > 0) onExpand(pending)
  }, [open, shown, children, hasChildren, names, onExpand])

  const name = node.localId !== null ? names.get(node.localId) : undefined
  const label = name ? `${name}` : node.category
  const suffix = name ? node.category : null

  return (
    <li>
      <div
        className={`tree-row${isSelected ? ' is-selected' : ''}`}
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
              onSelect={onSelect}
              onExpand={onExpand}
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
  selected: number | null
  names: Map<number, string>
  onSelect: (node: TreeNode) => void
  onExpand: (ids: number[]) => void
}

export function ModelTree({ roots, selected, names, onSelect, onExpand }: Props) {
  if (roots.length === 0) {
    return (
      <p className="panel-empty">Abre un archivo IFC para ver su estructura.</p>
    )
  }

  return (
    <ul className="tree">
      {roots.map((node, i) => (
        <TreeRow
          key={node.localId ?? i}
          node={node}
          depth={0}
          selected={selected}
          names={names}
          onSelect={onSelect}
          onExpand={onExpand}
        />
      ))}
    </ul>
  )
}
