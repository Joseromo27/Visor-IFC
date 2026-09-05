# Visor IFC

Visor de modelos IFC de escritorio. Abre archivos grandes, los convierte a
Fragments y los muestra en 3D con arbol jerarquico y consulta de propiedades.

Soporta IFC4 e **IFC4X3** (obra lineal). Esto ultimo no sale gratis: el
ecosistema That Open asume edificacion por defecto y hay dos cosas que corregir
para que un modelo de kilometros se comporte.

- El conversor solo serializa las clases que conoce, y su lista no incluye los
  contenedores espaciales de infraestructura. Sin `IfcFacility`, el arbol de un
  modelo de carretera se queda en el sitio y no muestra ni un elemento aunque
  el modelo tenga miles. Ver `CLASES_ESPACIALES_IFC4X3` en
  `src/workers/ifcConverter.worker.ts`.
- Las camaras nacen con `far = 1000` metros. Un corredor vial mide kilometros:
  al encuadrarlo entero la camara queda a mas de 10 km y **todo lo que pasa de
  1000 m se recorta**, con lo que el visor muestra dos hilos sueltos en vez del
  modelo. `Viewer.adjustCameraPlanes` recalcula `near` y `far` a partir de la
  caja del modelo cada vez que se carga uno.

Tauri 2 (Rust + WebView del sistema) con un frontend React + Vite + TypeScript
sobre `@thatopen/components`, `@thatopen/fragments`, `web-ifc` y Three.js.

## Como funciona la carga

Un IFC de ~1 GB no cabe comodamente en la memoria del WebView, asi que el
recorrido evita materializarlo entero:

1. El archivo se elige con el dialogo nativo del sistema operativo (o
   arrastrandolo a la ventana). Nunca se usa `<input type="file">`, asi que
   siempre se trabaja con la ruta real en disco.
2. Se calcula una clave de cache con ruta + tamano + fecha de modificacion. Si
   ya existe el `.frag` correspondiente, se carga directo y la apertura es
   practicamente instantanea.
3. Si no hay cache, la conversion corre en un Web Worker. El worker no lee el
   disco: pide trozos al hilo principal a traves de un `SharedArrayBuffer`,
   bloqueandose con `Atomics.wait` mientras llegan. Esto es necesario porque
   web-ifc exige un callback de lectura **sincrono** (`(offset, size) =>
   Uint8Array`) mientras que el acceso a disco de Tauri es asincrono. El
   resultado es que solo unas decenas de MB estan vivas a la vez.
4. Los Fragments resultantes se guardan en la carpeta de datos de la
   aplicacion, no en IndexedDB.

El puente por trozos necesita aislamiento de origen cruzado (COOP/COEP),
configurado en `vite.config.ts` para desarrollo y en `tauri.conf.json` para
produccion. Si no estuviera disponible, la aplicacion recurre a leer el archivo
completo: sirve para modelos chicos, pero con ~1 GB es probable que agote la
memoria.

## Rendimiento medido

Medido en un i7-11800H con 15,6 GB de RAM, sobre un IFC4X3 de **741,6 MB** de
obra lineal (855 elementos con geometria, mallas muy densas).

| Escenario | Tiempo | Pico de memoria del WebView |
| --- | --- | --- |
| Primera apertura, con conversion | 54 s | ~4,5 GB |
| Aperturas siguientes, desde cache | 1,0 s | ~1,1 GB |

Los Fragments resultantes ocupan 103,6 MB en disco.

Lo que hay que saber de esas cifras:

- **El pico de 4,5 GB es transitorio y se paga una sola vez por archivo.** A
  partir de la segunda apertura el modelo entra desde el cache y el consumo se
  queda en torno a 1,1 GB, que es el coste real del uso diario.
- **Para convertir hace falta holgura de RAM.** Con 8 GB totales la conversion
  probablemente termine, pero paginando; con 4 GB no. Ver un modelo ya
  convertido, en cambio, va comodo en cualquier equipo moderno.
- Un equipo puede saltarse la conversion copiando el `.frag` ya generado a
  `%LOCALAPPDATA%\cl.len.visorifc\cache-fragments` de otra maquina, siempre que
  el IFC este en la misma ruta y con la misma fecha de modificacion: la clave
  de cache se calcula con esos datos.

Se probo bajar `MEMORY_LIMIT` de web-ifc de 2 GB a 1 GB: el pico solo baja de
~4,75 GB a ~4,58 GB, un 3-4 %. **El pico es inherente a la conversion, no a ese
ajuste**, asi que se dejo el valor por defecto en vez de fijar una constante
interna de la libreria. Si hiciera falta apretar mas, los knobs son
`MEMORY_LIMIT`, `TAPE_SIZE` y `CIRCLE_SEGMENTS` (este ultimo reduce la
teselacion de superficies curvas, con perdida de calidad visual), todos vía
`importer.webIfcSettings` en `src/workers/ifcConverter.worker.ts`.

Con `raw: true` el `.frag` no va comprimido: pesa mas en disco pero abre mucho
mas rapido, que es justamente para lo que existe el cache.

## Requisitos de desarrollo

- Node.js 20 o superior
- Rust estable
- Un compilador de C++ con el SDK de Windows

En un equipo **sin permisos de administrador**, los tres se pueden instalar de
forma portable. Ver [`docs/entorno-sin-admin.md`](docs/entorno-sin-admin.md).

## Comandos

```bash
npm install          # instala dependencias y copia los .wasm a public/
npm run tauri:dev    # aplicacion de escritorio en modo desarrollo
npm run tauri:build  # instaladores para el sistema operativo actual
npm run build        # solo el frontend
npx tsc -b           # verificacion de tipos
```

En el equipo con toolchain portable conviene usar el script, que resuelve solo
las rutas de MSVC y el resto del entorno:

```powershell
.\scripts\dev.ps1          # modo desarrollo
.\scripts\dev.ps1 -Build   # instaladores firmados
```

## Prueba de humo

El flujo completo — lectura por trozos, conversion, cache, escena, arbol,
propiedades, visibilidad y camara — se puede ejercitar sin tocar la interfaz:

```powershell
.\scripts\dev.ps1 -SelfTest 'C:\ruta\al\modelo.ifc'
```

Equivale a fijar `VITE_SELFTEST_PATH` antes de `npm run tauri:dev`. La
aplicacion ejecuta la secuencia, escribe el resultado en el log y se cierra con
codigo distinto de cero si algo falla. En un build normal esa variable no existe
y el componente no se incluye.

Referencia con un IFC4X3 de 32 MB y 1351 elementos con geometria, sobre un
i7-11800H: conversion en 7-9 s, reapertura desde cache en 0,1 s, arbol de 1639
nodos.

Todo lo que ocurre dentro del WebView se reenvia al log de Rust
(`src/lib/log.ts`), que en Windows queda en
`%LOCALAPPDATA%\cl.len.visorifc\logs`. Es la unica forma de diagnosticar un
fallo en el equipo de otra persona: la ventana de Tauri no tiene consola.

## Distribucion y actualizaciones

Los instaladores los genera GitHub Actions
([`.github/workflows/release.yml`](.github/workflows/release.yml)) al empujar
una etiqueta `v*`: `.msi` y `.exe` para Windows, `.dmg` para macOS,
`.AppImage` y `.deb` para Linux. macOS y Linux no se pueden compilar desde
Windows, por eso el release se arma en CI.

La instalacion en Windows es **por usuario** (`installMode: currentUser`), de
modo que no hace falta ser administrador ni para instalar ni para actualizar.

El cache de Fragments vive en `%LOCALAPPDATA%\cl.len.visorifc\cache-fragments`.
La clave incluye `CONVERTER_VERSION` (`src/lib/conversion.ts`): **hay que subirla
al cambiar cualquier opcion de conversion**, o los usuarios seguiran abriendo
modelos generados con la configuracion anterior.

La aplicacion consulta al abrir el feed
`https://github.com/Joseromo27/Visor-IFC/releases/latest/download/latest.json`
y ofrece actualizar. Para que funcione, el repositorio necesita dos secretos:

| Secreto | Contenido |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | contenido completo de `visor-ifc.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | contenido de `visor-ifc.password` |

Ambos archivos estan en la carpeta `.tauri` del perfil del usuario.

La clave publica correspondiente ya esta en `src-tauri/tauri.conf.json`. **Ni la
clave privada ni su contrasena deben entrar al repositorio**: si se pierden,
ninguna version futura podra firmarse de forma que las instalaciones existentes
la acepten, y habria que redistribuir el instalador a mano.

La clave se genero **con contrasena** deliberadamente. PowerShell no puede
exportar una variable de entorno vacia — asignarle `''` la borra —, asi que con
una clave sin contrasena el CLI de Tauri no encuentra
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` y el build se cuelga en un prompt
interactivo que en CI nadie responde.

Para publicar una version:

```bash
npm version patch          # actualiza package.json
# actualizar tambien "version" en src-tauri/tauri.conf.json
git push --follow-tags
```

El workflow deja el release en borrador para revisarlo antes de publicarlo.

## Estructura

```
src/
  App.tsx                       interfaz principal
  SelfTest.tsx                  prueba de humo del flujo completo
  components/ModelTree.tsx      arbol jerarquico, montado de forma perezosa
  components/PropertiesPanel.tsx  property sets del elemento seleccionado
  lib/bridge.ts                 protocolo del SharedArrayBuffer
  lib/conversion.ts             dialogo, cache y orquestacion del worker
  lib/tree.ts                   aplanado del arbol espacial de fragments
  lib/log.ts                    reenvio de la consola del WebView al log de Rust
  lib/updater.ts                actualizacion automatica
  viewer/Viewer.ts              escena, camara, seleccion y visibilidad
  workers/ifcConverter.worker.ts  conversion IFC -> Fragments
src-tauri/
  src/commands.rs               metadatos, ruta de cache y lectura por trozos
  src/lib.rs                    registro de plugins
scripts/copy-assets.mjs         copia los .wasm y el worker a public/
scripts/dev.ps1                 entorno del toolchain portable en Windows
```
