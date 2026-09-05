# Visor IFC

Visor de modelos IFC de escritorio. Abre archivos grandes, los convierte a
Fragments y los muestra en 3D con arbol jerarquico y consulta de propiedades.

Soporta IFC4 e **IFC4X3** (obra lineal). Esto ultimo no sale gratis: el
conversor de `@thatopen/fragments` viene configurado para edificacion y hay que
anadirle los contenedores espaciales de infraestructura, o el arbol de un modelo
de carretera se queda en el sitio y no muestra ni un elemento. Ver
`CLASES_ESPACIALES_IFC4X3` en `src/workers/ifcConverter.worker.ts`.

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
| `TAURI_SIGNING_PRIVATE_KEY` | contenido de la clave privada generada con `npm run tauri signer generate` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | su contrasena, o vacio si se genero sin una |

La clave publica correspondiente ya esta en `src-tauri/tauri.conf.json`. **La
clave privada no debe entrar al repositorio**: si se pierde, ninguna version
futura podra firmarse de forma que las instalaciones existentes la acepten.

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
