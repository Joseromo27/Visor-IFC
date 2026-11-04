// Herramientas de trabajo sobre el modelo, agrupadas.
//
// Se adapta al ancho de la ventana en tres pasos, y esto es lo unico
// complicado del componente:
//
//   completa -> compacta -> menus
//
// Mientras quepa, todo esta a la vista como en AutoCAD, que es como se trabaja
// comodo: casi todo lo que se hace con un modelo abierto es aislar, ocultar y
// transparentar una y otra vez, y con los menus cada accion costaba abrir el
// panel antes. Al encoger la ventana se aprietan los controles y se acortan
// los rotulos; cuando ya no caben ni asi, se repliegan en dos desplegables en
// vez de dejar la barra con desplazamiento horizontal, que es peor que un
// menu: hay que arrastrarla para encontrar un boton que no se ve.
//
// Los grupos se definen una sola vez y las dos disposiciones los reutilizan,
// para que no puedan quedar descuadradas.

import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { MenuBarra } from './MenuBarra'
import { ETIQUETAS_NAVEGACION, type Navegacion } from '../lib/settings'
import {
  ETIQUETAS_VISTA,
  formatearDistancia,
  type Medicion,
  type ModoVisor,
  type Vista,
} from '../viewer/Viewer'

/** Dos filas de cuatro: las seis ortogonales mas la isometrica. */
const VISTAS: Vista[] = [
  'planta',
  'frontal',
  'izquierda',
  'isometrica',
  'inferior',
  'posterior',
  'derecha',
]

type ModoBarra = 'completa' | 'compacta' | 'menus'

interface Props {
  ocupado: boolean
  hayModelo: boolean
  haySeleccion: boolean
  haySeleccionUnica: boolean

  opacidad: number
  navegacion: Navegacion
  modo: ModoVisor
  mediciones: Medicion[]

  onAislar: () => void
  onOcultar: () => void
  onMostrarTodo: () => void
  onEnfocarSeleccion: () => void
  onVistaPanoramica: () => void
  onVista: (vista: Vista) => void
  onBuscarSimilares: () => void
  onTransparentar: () => void
  onInvertirTransparencia: () => void
  onQuitarTransparencia: () => void
  onCambiarOpacidad: (valor: number) => void
  onCambiarNavegacion: (modo: Navegacion) => void
  onCambiarModo: (modo: ModoVisor) => void
  onBorrarMedicion: (id: number) => void
  onBorrarMediciones: () => void
  onExcluir: () => void
  onAbrirEntregable: () => void
  excluidos: number
}

type Grupo = { clave: string; titulo: string; contenido: ReactNode }

/**
 * Contenido de cada grupo. `compacta` solo cambia los rotulos: la diferencia
 * de tamano la pone el CSS, que es donde se puede ajustar sin tocar logica.
 */
function construirGrupos(p: Props, compacta: boolean): Grupo[] {
  const inactivo = !p.hayModelo || p.ocupado
  const sinSeleccion = !p.haySeleccion || inactivo
  const midiendo = p.modo === 'medir'
  const et = (largo: string, corto: string) => (compacta ? corto : largo)

  return [
    {
      clave: 'visibilidad',
      titulo: 'Visibilidad',
      contenido: (
        <>
          <button
            className="btn"
            onClick={p.onAislar}
            disabled={sinSeleccion}
            title="Deja visible solo lo seleccionado"
          >
            Aislar
          </button>
          <button className="btn" onClick={p.onOcultar} disabled={sinSeleccion}>
            Ocultar
          </button>
          <button className="btn" onClick={p.onMostrarTodo} disabled={inactivo}>
            {et('Mostrar todo', 'Mostrar')}
          </button>
          <button
            className={`btn${p.modo === 'ventana' ? ' is-activo' : ''}`}
            onClick={() =>
              p.onCambiarModo(p.modo === 'ventana' ? 'seleccion' : 'ventana')
            }
            disabled={inactivo}
            title="Selecciona varios arrastrando un rectangulo. Tambien sirve mantener Mayusculas mientras arrastras"
          >
            Ventana
          </button>
          <button
            className="btn"
            onClick={p.onBuscarSimilares}
            disabled={!p.haySeleccionUnica || inactivo}
            title={
              p.haySeleccionUnica
                ? 'Busca los elementos parecidos al elegido para aislarlos u ocultarlos'
                : 'Elige un elemento en el modelo o en el arbol'
            }
          >
            {et('Similares...', 'Similares')}
          </button>
        </>
      ),
    },
    {
      clave: 'transparencia',
      titulo: 'Transparencia',
      contenido: (
        <>
          <button
            className="btn"
            onClick={p.onTransparentar}
            disabled={sinSeleccion}
            title="Aplica la transparencia elegida a la seleccion"
          >
            {et('Transparentar', 'Aplicar')}
          </button>
          <button
            className="btn"
            onClick={p.onInvertirTransparencia}
            disabled={sinSeleccion}
            title="Deja translucido todo menos la seleccion, para verla en su contexto"
          >
            Invertir
          </button>
          <button
            className="btn"
            onClick={p.onQuitarTransparencia}
            disabled={inactivo}
            title="Devuelve todos los elementos a opacidad completa"
          >
            Quitar
          </button>
          <label className="deslizador" title="Nivel de opacidad">
            <input
              type="range"
              min={5}
              max={95}
              step={5}
              value={Math.round(p.opacidad * 100)}
              onChange={(e) => p.onCambiarOpacidad(Number(e.target.value) / 100)}
              disabled={inactivo}
              aria-label="Nivel de opacidad"
            />
            <span className="deslizador-valor">
              {Math.round(p.opacidad * 100)}%
            </span>
          </label>
        </>
      ),
    },
    {
      clave: 'vistas',
      titulo: 'Vistas',
      contenido: (
        <div className="cinta-rejilla">
          {VISTAS.map((vista) => (
            <button
              key={vista}
              className="btn"
              onClick={() => p.onVista(vista)}
              disabled={inactivo}
              title={
                p.haySeleccion
                  ? `${ETIQUETAS_VISTA[vista]} de la seleccion`
                  : `${ETIQUETAS_VISTA[vista]} de todo lo montado`
              }
            >
              {ETIQUETAS_VISTA[vista]}
            </button>
          ))}
        </div>
      ),
    },
    {
      clave: 'camara',
      titulo: 'Camara',
      contenido: (
        <>
          <button
            className="btn"
            onClick={p.onEnfocarSeleccion}
            disabled={sinSeleccion}
            title="Encuadra la camara en la seleccion"
          >
            {et('Enfocar seleccion', 'Enfocar')}
          </button>
          <button
            className="btn"
            onClick={p.onVistaPanoramica}
            disabled={inactivo}
            title="Muestra todo el modelo, sin transparencias ni resaltados, y encuadra la vista"
          >
            {et('Vista panoramica', 'Panoramica')}
          </button>
          <label className="selector" title="Modo de navegacion de la camara">
            <select
              value={p.navegacion}
              onChange={(e) =>
                p.onCambiarNavegacion(e.target.value as Navegacion)
              }
              disabled={inactivo}
            >
              {(Object.keys(ETIQUETAS_NAVEGACION) as Navegacion[]).map((m) => (
                <option key={m} value={m}>
                  {ETIQUETAS_NAVEGACION[m]}
                </option>
              ))}
            </select>
          </label>
        </>
      ),
    },
    {
      clave: 'entregable',
      titulo: 'Entregable',
      contenido: (
        <>
          <button
            className="btn"
            onClick={p.onExcluir}
            disabled={sinSeleccion}
            title="Marca la seleccion para que no salga en el entregable"
          >
            {et('Excluir seleccion', 'Excluir')}
          </button>
          <button
            className="btn"
            onClick={p.onAbrirEntregable}
            disabled={inactivo}
            title="Revisa lo marcado y exporta el IFC sin esos elementos"
          >
            {p.excluidos > 0 ? `Revisar (${p.excluidos})` : 'Revisar'}
          </button>
        </>
      ),
    },
    {
      clave: 'medicion',
      titulo: 'Medicion',
      contenido: (
        <>
          <button
            className={`btn${midiendo ? ' is-activo' : ''}`}
            onClick={() => p.onCambiarModo(midiendo ? 'seleccion' : 'medir')}
            disabled={inactivo}
            title="Dos clics: engancha a vertices, aristas y caras"
          >
            {midiendo ? et('Terminar de medir', 'Terminar') : et('Medir distancia', 'Medir')}
          </button>
          <button
            className="btn"
            onClick={p.onBorrarMediciones}
            disabled={p.mediciones.length === 0}
            title="Quita todas las medidas tomadas"
          >
            {et('Borrar todas', 'Borrar')}
          </button>

          {/* La lista ocupa su sitio aunque este vacia: si apareciera y
              desapareciera, el ancho que necesita la barra cambiaria con cada
              medida y la disposicion bailaria sola. */}
          <ul className="lista-medidas">
            {p.mediciones.length === 0 ? (
              <li className="lista-vacia">Sin medidas</li>
            ) : (
              p.mediciones.map((m, i) => (
                <li key={m.id}>
                  <span className="medida-indice">{i + 1}</span>
                  <span className="medida-valor">
                    {formatearDistancia(m.distancia)}
                  </span>
                  <button
                    className="btn btn-small"
                    data-mantener="si"
                    onClick={() => p.onBorrarMedicion(m.id)}
                    title="Borrar esta medida"
                    aria-label={`Borrar la medida ${i + 1}`}
                  >
                    ×
                  </button>
                </li>
              ))
            )}
          </ul>
        </>
      ),
    },
  ]
}

/**
 * Ancho que necesita la cinta, quepa o no.
 *
 * No vale `scrollWidth`: cuando el contenido cabe, devuelve el ancho
 * disponible y no el necesario, con lo que al encoger la ventana se
 * replegaria antes de tiempo. Los grupos no se estiran (`flex: 0 0 auto`),
 * asi que la suma de sus anchos es el dato real.
 */
function anchoNecesario(el: HTMLElement): number {
  const estilo = getComputedStyle(el)
  const relleno =
    parseFloat(estilo.paddingLeft) + parseFloat(estilo.paddingRight)
  let total = 0
  for (const hijo of el.children) {
    total += (hijo as HTMLElement).getBoundingClientRect().width
  }
  return total + relleno
}

export function Cinta(props: Props) {
  const caja = useRef<HTMLDivElement>(null)
  /** Ancho necesario de cada disposicion, medido la primera vez que se usa. */
  const necesario = useRef({ completa: 0, compacta: 0 })
  const [modo, setModo] = useState<ModoBarra>('completa')
  const [tic, setTic] = useState(0)

  useLayoutEffect(() => {
    const el = caja.current
    if (!el) return
    const observador = new ResizeObserver(() => setTic((t) => t + 1))
    observador.observe(el)
    return () => observador.disconnect()
  }, [])

  // Decide la disposicion. Las medidas se guardan y no dependen del ancho
  // disponible, de modo que la decision no se retroalimenta: no hay forma de
  // que entre dos modos se quede oscilando.
  useLayoutEffect(() => {
    const el = caja.current
    if (!el) return
    const disponible = el.clientWidth
    if (disponible <= 0) return

    if (modo === 'completa') necesario.current.completa = anchoNecesario(el)
    else if (modo === 'compacta') necesario.current.compacta = anchoNecesario(el)

    const { completa, compacta } = necesario.current
    let siguiente: ModoBarra
    if (completa > 0 && disponible >= completa) siguiente = 'completa'
    else if (compacta === 0) siguiente = 'compacta' // falta medirla
    else if (disponible >= compacta) siguiente = 'compacta'
    else siguiente = 'menus'

    if (siguiente !== modo) setModo(siguiente)
  }, [modo, tic, props.mediciones.length])

  const grupos = construirGrupos(props, modo === 'compacta')
  const inactivo = !props.hayModelo || props.ocupado

  if (modo === 'menus') {
    const visualizacion = grupos.filter((g) => g.clave !== 'medicion')
    const medicion = grupos.filter((g) => g.clave === 'medicion')
    return (
      <div className="cinta is-menus" ref={caja}>
        <MenuBarra
          etiqueta="Visualizacion"
          disabled={inactivo}
          titulo="Que se ve y desde donde"
        >
          {visualizacion.map((g) => (
            <section className="menu-grupo" key={g.clave}>
              <h4 className="menu-titulo">{g.titulo}</h4>
              <div className="cinta-controles">{g.contenido}</div>
            </section>
          ))}
        </MenuBarra>
        <MenuBarra
          etiqueta="Medicion"
          activo={props.modo === 'medir'}
          disabled={inactivo}
          titulo="Herramientas de medida"
        >
          {medicion.map((g) => (
            <section className="menu-grupo" key={g.clave}>
              <div className="cinta-controles">{g.contenido}</div>
            </section>
          ))}
        </MenuBarra>
      </div>
    )
  }

  return (
    <div
      className={`cinta${modo === 'compacta' ? ' is-compacta' : ''}`}
      ref={caja}
    >
      {grupos.map((g) => (
        <section className="cinta-grupo" key={g.clave}>
          <div className="cinta-controles">{g.contenido}</div>
          <h4 className="cinta-titulo">{g.titulo}</h4>
        </section>
      ))}
    </div>
  )
}
