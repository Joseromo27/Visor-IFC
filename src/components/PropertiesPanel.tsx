// Panel de propiedades del elemento seleccionado.
//
// `getItemsData` devuelve una estructura libre: las claves son atributos
// simples (`{value, type}`) o listas de entidades relacionadas (los property
// sets llegan por `IsDefinedBy`). Se recorre de forma generica en vez de
// asumir un esquema fijo, porque cada exportador de IFC produce combinaciones
// distintas.

import { useState } from 'react'
import type { ItemData } from '@thatopen/fragments'

type Attribute = { value: unknown; type?: string }

const isAttribute = (v: unknown): v is Attribute =>
  typeof v === 'object' && v !== null && 'value' in v && !Array.isArray(v)

const isGroup = (v: unknown): v is ItemData[] => Array.isArray(v)

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Si' : 'No'
  if (typeof value === 'number') {
    // Recortar el ruido de coma flotante sin perder precision util.
    return Number.isInteger(value) ? String(value) : value.toFixed(3)
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** Nombre legible de una entidad relacionada, para el titulo de la seccion. */
function groupTitle(entry: ItemData, fallback: string): string {
  for (const key of ['Name', 'LongName', 'Description']) {
    const candidate = entry[key]
    if (isAttribute(candidate) && candidate.value) {
      return String(candidate.value)
    }
  }
  return fallback
}

function Rows({ data }: { data: ItemData }) {
  const rows = Object.entries(data).filter(([, v]) => isAttribute(v))

  if (rows.length === 0) {
    return <p className="panel-empty">Sin atributos.</p>
  }

  return (
    <dl className="props">
      {rows.map(([key, v]) => (
        <div className="props-row" key={key}>
          <dt title={key}>{key}</dt>
          <dd title={formatValue((v as Attribute).value)}>
            {formatValue((v as Attribute).value)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function Group({ title, entries }: { title: string; entries: ItemData[] }) {
  const [open, setOpen] = useState(true)

  return (
    <section className="props-group">
      <button
        type="button"
        className="props-group-head"
        onClick={() => setOpen((v) => !v)}
      >
        <span>{open ? '▾' : '▸'}</span>
        {title}
        <span className="tree-count">{entries.length}</span>
      </button>
      {open &&
        entries.map((entry, i) => (
          <div className="props-subgroup" key={i}>
            <h4>{groupTitle(entry, `${title} ${i + 1}`)}</h4>
            <Rows data={entry} />
            {Object.entries(entry)
              .filter(([, v]) => isGroup(v))
              .map(([key, v]) => (
                <Group key={key} title={key} entries={v as ItemData[]} />
              ))}
          </div>
        ))}
    </section>
  )
}

interface Props {
  data: ItemData | null
  loading: boolean
}

export function PropertiesPanel({ data, loading }: Props) {
  if (loading) return <p className="panel-empty">Cargando propiedades…</p>
  if (!data) {
    return (
      <p className="panel-empty">
        Selecciona un elemento en el modelo o en el arbol.
      </p>
    )
  }

  const groups = Object.entries(data).filter(([, v]) => isGroup(v))

  return (
    <div className="props-wrap">
      <h4>Atributos</h4>
      <Rows data={data} />
      {groups.map(([key, v]) => (
        <Group key={key} title={key} entries={v as ItemData[]} />
      ))}
    </div>
  )
}
