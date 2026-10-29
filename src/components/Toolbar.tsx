// Barra de herramientas.
//
// Vive aparte porque App ya coordinaba carga, seleccion, arbol, propiedades y
// actualizaciones; sumarle los controles de transparencia, navegacion y
// ajustes la volvia imposible de leer.

import { ETIQUETAS_NAVEGACION, type Navegacion } from '../lib/settings'

interface Props {
  ocupado: boolean
  hayModelo: boolean
  haySeleccion: boolean

  opacidad: number
  navegacion: Navegacion

  onAbrir: () => void
  onAislar: () => void
  onOcultar: () => void
  onMostrarTodo: () => void
  onEnfocarSeleccion: () => void
  onVistaPanoramica: () => void
  onTransparentar: () => void
  onInvertirTransparencia: () => void
  onQuitarTransparencia: () => void
  onCambiarOpacidad: (valor: number) => void
  onCambiarNavegacion: (modo: Navegacion) => void
  onAbrirAjustes: () => void
}

export function Toolbar({
  ocupado,
  hayModelo,
  haySeleccion,
  opacidad,
  navegacion,
  onAbrir,
  onAislar,
  onOcultar,
  onMostrarTodo,
  onEnfocarSeleccion,
  onVistaPanoramica,
  onTransparentar,
  onInvertirTransparencia,
  onQuitarTransparencia,
  onCambiarOpacidad,
  onCambiarNavegacion,
  onAbrirAjustes,
}: Props) {
  return (
    <>
      <button className="btn btn-primary" onClick={onAbrir} disabled={ocupado}>
        Abrir IFC...
      </button>

      <span className="toolbar-sep" />

      <button
        className="btn"
        onClick={onAislar}
        disabled={!haySeleccion || ocupado}
        title="Deja visible solo lo seleccionado"
      >
        Aislar
      </button>
      <button
        className="btn"
        onClick={onOcultar}
        disabled={!haySeleccion || ocupado}
      >
        Ocultar
      </button>
      <button
        className="btn"
        onClick={onMostrarTodo}
        disabled={!hayModelo || ocupado}
      >
        Mostrar todo
      </button>

      <span className="toolbar-sep" />

      <div className="grupo-opacidad">
        <button
          className="btn"
          onClick={onTransparentar}
          disabled={!haySeleccion || ocupado}
          title="Aplica la transparencia elegida a la seleccion"
        >
          Transparentar
        </button>
        <button
          className="btn"
          onClick={onInvertirTransparencia}
          disabled={!haySeleccion || ocupado}
          title="Deja translucido todo menos la seleccion, para verla en su contexto"
        >
          Invertir
        </button>
        <label className="deslizador" title="Nivel de opacidad">
          <input
            type="range"
            min={5}
            max={95}
            step={5}
            value={Math.round(opacidad * 100)}
            onChange={(e) => onCambiarOpacidad(Number(e.target.value) / 100)}
            disabled={ocupado}
            aria-label="Nivel de opacidad"
          />
          <span className="deslizador-valor">{Math.round(opacidad * 100)}%</span>
        </label>
        <button
          className="btn"
          onClick={onQuitarTransparencia}
          disabled={!hayModelo || ocupado}
          title="Devuelve todos los elementos a opacidad completa"
        >
          Quitar
        </button>
      </div>

      <span className="toolbar-sep" />

      <button
        className="btn"
        onClick={onEnfocarSeleccion}
        disabled={!haySeleccion || ocupado}
        title="Encuadra la camara en la seleccion"
      >
        Enfocar seleccion
      </button>
      <button
        className="btn"
        onClick={onVistaPanoramica}
        disabled={!hayModelo || ocupado}
        title="Muestra todo el modelo, sin transparencias ni resaltados, y encuadra la vista"
      >
        Vista panoramica
      </button>

      <span className="toolbar-sep" />

      <label className="selector" title="Modo de navegacion de la camara">
        <select
          value={navegacion}
          onChange={(e) => onCambiarNavegacion(e.target.value as Navegacion)}
          disabled={!hayModelo || ocupado}
        >
          {(Object.keys(ETIQUETAS_NAVEGACION) as Navegacion[]).map((modo) => (
            <option key={modo} value={modo}>
              {ETIQUETAS_NAVEGACION[modo]}
            </option>
          ))}
        </select>
      </label>

      <span className="toolbar-spacer" />

      <button className="btn" onClick={onAbrirAjustes} title="Opciones">
        Opciones
      </button>
    </>
  )
}
