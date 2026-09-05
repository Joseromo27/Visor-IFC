# Visor IFC

Visor de modelos IFC4 de escritorio. Abre archivos grandes (probado con el
objetivo de ~1 GB), los convierte a Fragments y los muestra en 3D con arbol
jerarquico y consulta de propiedades.

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

## Prueba de humo

El flujo completo — lectura por trozos, conversion, cache, escena, arbol,
propiedades, visibilidad y camara — se puede ejercitar sin tocar la interfaz:

```bash
VITE_SELFTEST_PATH="C:/ruta/al/modelo.ifc" npm run tauri:dev
```

En PowerShell:

```powershell
$env:VITE_SELFTEST_PATH = 'C:\ruta\al\modelo.ifc'; npm run tauri:dev
```

La aplicacion ejecuta la secuencia, escribe el resultado en el log y se cierra
con codigo distinto de cero si algo falla. En un build normal esa variable no
existe y el componente no se incluye.

## Distribucion y actualizaciones

Los instaladores los genera GitHub Actions
([`.github/workflows/release.yml`](.github/workflows/release.yml)) al empujar
una etiqueta `v*`: `.msi` y `.exe` para Windows, `.dmg` para macOS,
`.AppImage` y `.deb` para Linux. macOS y Linux no se pueden compilar desde
Windows, por eso el release se arma en CI.

La instalacion en Windows es **por usuario** (`installMode: currentUser`), de
modo que no hace falta ser administrador ni para instalar ni para actualizar.

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
  lib/updater.ts                actualizacion automatica
  viewer/Viewer.ts              escena, camara, seleccion y visibilidad
  workers/ifcConverter.worker.ts  conversion IFC -> Fragments
src-tauri/
  src/commands.rs               metadatos, ruta de cache y lectura por trozos
  src/lib.rs                    registro de plugins
scripts/copy-assets.mjs         copia los .wasm y el worker a public/
```
