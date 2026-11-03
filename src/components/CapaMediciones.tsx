// Etiquetas de las mediciones, encima del lienzo.
//
// Las lineas y los puntos los dibuja three.js dentro de la escena, pero el
// texto no: una etiqueta rotulada en 3D se deforma con la camara y acaba
// ilegible justo cuando hace falta leerla. Se pinta en HTML y se recoloca
// proyectando el punto medio de cada medida en cada fotograma.
//
// El bucle solo corre cuando hay algo que mostrar; con el visor sin medidas no
// hay ningun temporizador vivo.

import { useEffect, useRef, useState } from 'react'

import type { EtiquetaMedicion, Viewer } from '../viewer/Viewer'

interface Props {
  viewer: Viewer | null
  /** Para despertar el bucle cuando cambian las medidas o el modo. */
  activo: boolean
}

export function CapaMediciones({ viewer, activo }: Props) {
  const [etiquetas, setEtiquetas] = useState<EtiquetaMedicion[]>([])
  const pedido = useRef(0)

  useEffect(() => {
    if (!viewer || !activo) return

    let vivo = true
    const paso = () => {
      if (!vivo) return
      // Las posiciones vienen en coordenadas de ventana, que es como cruzan
      // todos los puntos entre el visor y la interfaz. Hay que recortar al
      // lienzo: una medida que queda fuera de cuadro proyecta igualmente, y
      // su rotulo apareceria flotando sobre el arbol o las propiedades.
      const lienzo = document
        .querySelector('.canvas-host canvas')
        ?.getBoundingClientRect()
      const dentro = viewer
        .getEtiquetas()
        .filter(
          (e) =>
            !lienzo ||
            (e.x >= lienzo.left &&
              e.x <= lienzo.right &&
              e.y >= lienzo.top &&
              e.y <= lienzo.bottom),
        )
      setEtiquetas(dentro)
      pedido.current = requestAnimationFrame(paso)
    }
    paso()

    return () => {
      vivo = false
      cancelAnimationFrame(pedido.current)
    }
  }, [viewer, activo])

  // Al apagarse quedan las ultimas etiquetas en el estado; no se limpian
  // desde el efecto, simplemente no se pintan.
  if (!activo || etiquetas.length === 0) return null

  return (
    <div className="capa-medidas">
      {etiquetas.map((e) => (
        <span
          key={e.provisional ? 'en-curso' : e.id}
          className={`medida-etiqueta${e.provisional ? ' is-provisional' : ''}`}
          style={{ left: `${e.x}px`, top: `${e.y}px` }}
        >
          {e.texto}
        </span>
      ))}
    </div>
  )
}
