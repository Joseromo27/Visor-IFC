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
- Los controles de camara nacen con la distancia al objetivo acotada **entre 1
  y 300 metros**. Encuadrar un corredor de kilometros exige poner la camara a
  miles de metros, y el encuadre se recortaba a 300: la vista panoramica
  mostraba un trozo del proyecto. Ver [Zoom y vista
  panoramica](#zoom-y-vista-panoramica).

Se pueden montar varios IFC a la vez, cada uno en su posicion real, para ver
como se cruzan las disciplinas. Ver [Varios modelos a la
vez](#varios-modelos-a-la-vez).

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

## Varios modelos a la vez

"Anadir IFC..." monta otro archivo junto a los abiertos, en vez de reemplazarlos
(tambien vale soltar varios de golpe en la ventana). Cada archivo aparece como
una fila propia en el arbol, con un ojo para apagarlo y ver que hay debajo.

Lo unico delicado aqui es la georreferencia.

El camino habitual es dejar que web-ifc acerque cada archivo al origen
(`COORDINATE_TO_ORIGIN`, activado por defecto) y deshacer ese desplazamiento al
montarlo, con el dato que el conversor anota aparte. El dato es correcto, pero
el paso de deshacerlo es facil de equivocar y **el error no se nota**: con la
resta en sentido contrario, dos de los modelos de Orbital Sur quedaban a 277 m
en vez de a 2108, que es una separacion perfectamente creible para dos
disciplinas de la misma obra. Solo al montar el archivo de 741 MB, donde el
mismo fallo daba 26 km, se hizo visible.

Lo que se hace en su lugar es no reposicionar nada: el worker fija
`COORDINATE_TO_ORIGIN: false`, con lo que la geometria llega en las coordenadas
absolutas del proyecto y **todos los archivos de un mismo encargo comparten
sistema sin tocarlos**; no queda ningun desplazamiento que interpretar.
`Viewer.coordinar` solo les resta a todos el mismo vector, el centro del primer
modelo montado, para acercarlos al origen: una obra chilena esta a unos 3,3
millones de metros del cero y a esa distancia la camara y el raton trabajan con
numeros incomodos. Al ser la misma resta para todos, las posiciones relativas
quedan intactas y la alineacion sale exacta por construccion, ademas de poderse
contrastar contra el propio IFC.

Hay que apagar ademas `distanceThreshold`, que es la red de seguridad del
reposicionamiento: el serializador **descarta en silencio** todo elemento a mas
de 100 km del origen, y una obra chilena esta a unos 3270 km. Con el umbral
puesto, el modelo carga con su arbol completo y sin un solo elemento que
dibujar; de ahi el aviso explicito cuando un archivo se abre sin geometria.

Trabajar tan lejos del origen no cuesta precision. Fragments guarda la posicion
de cada elemento en doble precision (`writeFloat64` en su `Transform`; solo las
direcciones van en float32), los vertices son locales a cada geometria, y a cada
malla se le pone su matriz en vez de hornear la posicion en el buffer. Three.js
compone `padre × malla` en coma flotante de 64 bits antes de subir nada a la
GPU, y como el padre resta justo el origen comun, lo que llega a la tarjeta son
numeros pequenos: el residuo de la cancelacion queda en torno a 0,3 mm.

La transformacion se escribe en `model.object`, que es lo que miran el dibujado,
el rayo y las cajas, asi que la seleccion sigue cayendo donde se ve el elemento.

Como los `localId` solo son unicos dentro de su archivo, desde aqui todo el
visor identifica un elemento con `Ref = { modelId, localId }`.

## La barra: visualizacion y medicion

La barra tenia trece controles en una sola fila y ya no se leia. Los archivos
quedan arriba, porque son el punto de partida, y debajo hay una **cinta
siempre desplegada** con los grupos a la vista: visibilidad, transparencia,
vistas, camara, entregable y medicion, cada uno con su rotulo debajo como en
AutoCAD.

La cinta se mide y se adapta al ancho de la ventana en tres escalones: con
sitio van los rotulos largos, al estrecharse se acortan y, cuando ya no cabe
ningun grupo entero, se repliega a los menus desplegables de la version
anterior. El ancho necesario se calcula sumando el de los hijos que no encogen,
y cada escalon recuerda el umbral en el que entro para no oscilar entre dos
disposiciones al arrastrar el borde de la ventana.

Primero fueron dos menus desplegables, y duraron una version. Trabajando de
verdad con un modelo abierto casi todo es aislar, ocultar y transparentar una
y otra vez, y con los menus cada accion costaba abrir el panel antes. Se pierde
una franja de alto fija y se gana un clic en cada operacion.

### Vistas predeterminadas

Planta, inferior, las cuatro laterales e isometrica, encuadradas en la
seleccion — o en todo lo montado si no hay nada elegido.

Lo delicado es cual es el "arriba", y la primera version lo tuvo mal. **La
vertical de la escena es +Y, no +Z**: el IFC viene con Z hacia arriba, pero
web-ifc lo rota al convertir — `makeRotationX(-PI/2)` premultiplicado al
emplazamiento absoluto —, de modo que dentro del visor Y es la cota y Z es el
norte cambiado de signo. Se comprobo contra el propio archivo: el IFC de
canales mide 13,5 km en X, 13,0 km en Y y solo 536 m en Z, y en la escena esos
536 m son los de Y.

Dando por buena la vertical equivocada, las vistas no fallaban: salian sin
sentido. La "frontal" dejaba la camara debajo de la obra y mostraba el fondo, y
la "inferior" salia del reves. Peor aun, cada vista le fijaba el `up` a la
camara, asi que despues de usar una la orbita giraba sobre un plano torcido.

Ahora las vistas se piden en coordenadas esfericas a camera-controls
(`rotateTo` con acimut y polar) y **no se toca el `up` de la camara**, que es
la vertical de la escena y ya era la correcta. Mirando en vertical, la
direccion de la vista y el `up` se vuelven paralelos y la orientacion queda
indefinida, asi que planta e inferior llevan un margen de 0,0001 rad — seis
milesimas de grado — para no caer en ese caso limite.

La prueba no mira si "se ve bien", mira desde donde mira la camara: en planta
la camara tiene que estar por encima del techo del elemento, en inferior por
debajo de su suelo, en frontal a su misma cota, y el `up` tiene que seguir
siendo (0, 1, 0) al terminar. Con la version anterior, la frontal pasaba una
comprobacion de "direccion horizontal" estando debajo de la obra; por eso la
comprobacion ahora es de que lado, no de que eje.

### Elementos similares

A partir del elemento elegido se ofrecen dos criterios con su cuenta antes de
aplicar nada: mismo nombre o misma categoria IFC. Ver el numero antes importa:
en el modelo de canales, "ZAPATA DESAGUE IZQUIERDA MODULO 1" da 79 elementos
por nombre y 593 por categoria, porque Istram exporta casi todo como
`IFCBUILDINGELEMENTPROXY`. Ocultar por categoria sin ver esa cifra parece que
borra medio proyecto.

Hubo un tercer criterio, "nombre y categoria a la vez". Se quito tras probarlo:
el nombre ya es mas restrictivo que la categoria, asi que la interseccion
devolvia practicamente lo mismo que el nombre solo (69 frente a 79 en ese
ejemplo) y lo unico que anadia era una opcion mas que leer.

El nombre se compara sin el numero de orden del final ("MARCO 1" y "MARCO 2"
son la misma familia). Los nombres ya estaban resueltos: las reglas de color
los piden todos al montar el modelo, asi que buscar parecidos no vuelve a
pagarlos. Las categorias si se consultan a peticion, la primera vez que hacen
falta.

### Medir distancias

Dos clics, con enganche a vertice, arista o cara. Mientras se mide, el clic no
selecciona y el cursor pasa a cruz.

`raycastWithSnapping` no devuelve un punto sino **todos** los candidatos bajo
el rayo a la vez — vertices, aristas y la cara —, asi que hay que elegir. No
sirve el mas cercano a la camara: lo que se quiere es el que se ve mas cerca
del cursor, de modo que se comparan proyectados a pantalla, en pixeles, con
ventaja para el vertice sobre la arista y para la arista sobre la cara. Si
ninguno cae dentro de la tolerancia se usa el punto donde el rayo toca la
geometria, que es preferible a no poder medir.

Las lineas y los puntos van en la escena, sin prueba de profundidad para que no
queden enterrados en lo que estan midiendo; las cifras van en HTML encima del
lienzo, recolocadas proyectando el punto medio en cada fotograma, porque un
rotulo en 3D se deforma con la camara justo cuando hay que leerlo. Como los
modelos solo llevan restado el origen comun, un desplazamiento igual para
todos, las distancias son las reales del proyecto sin ninguna conversion.

Lo que la prueba verifica no es que salga un numero, sino que los dos puntos
caigan **dentro de la caja del elemento al que se apunto**: el fallo que no
avisa es que el enganche devuelva coordenadas de otro sistema, donde la cifra
seguiria pareciendo razonable y estaria medida a kilometros de donde se pulso.

No hizo falta subir @thatopen a 3.6 ni traer `components-front`: el enganche
(`raycastWithSnapping`) y el volumen por elemento (`MeasurementUtils`) ya
estaban en las versiones instaladas, y evitarlo ahorro invalidar el cache de
conversion de todos los modelos.

### Seleccion por ventana

Manteniendo Mayusculas —o con el boton "Ventana" fijado, para no tener que
sujetar la tecla— arrastrar dibuja un rectangulo y se queda con todo lo que
toca. Marcar elementos de uno en uno era el cuello de botella para preparar un
entregable.

La ventana atrapa lo que **toca**, no solo lo que encierra entero
(`fullyIncluded: false`). En obra lineal casi nada cabe completo en pantalla y
exigirlo haria que una ventana sobre un muro de 200 m no atrapara nada. A
cambio, un barrido amplio se trae mas de lo que uno espera, y por eso lo que se
va a quitar se revisa en una lista antes de exportar.

Los eventos de puntero se escuchan **en fase de captura sobre el contenedor y
se detienen ahi**: camera-controls escucha en el lienzo, que esta por debajo, y
si el evento le llega empieza a orbitar mientras se dibuja el rectangulo. La
prueba lo comprueba midiendo que la camara no se haya movido ni un centimetro
al terminar el arrastre.

### Zoom y vista panoramica

La rueda de camera-controls es geometrica: cada tic multiplica por un factor
fijo la distancia al objetivo. El paso vale, por tanto, lo que valga esa
distancia, de modo que **donde este el objetivo es lo que decide si la
navegacion se siente bien**. Con el objetivo en el centro del proyecto —que es
donde lo deja un encuadre general— uno avanza a razon de cientos de metros
mientras mira un sumidero a dos.

El objetivo se ancla por eso en lo que hay bajo el cursor, reutilizando el
punto que ya resuelve el seguimiento del cursor en vez de tirar un rayo nuevo:
el rayo nuevo tarda decenas de milisegundos y llegaba con el zoom ya en marcha,
y como `setOrbitPoint` reescribe la distancia al objetivo de golpe, aterrizar a
mitad de un gesto cortaba en seco la animacion en curso. El anclaje va ademas
**en fase de captura**, antes que la libreria: escuchando despues, el primer
tic de cada gesto se daba siempre con la distancia vieja.

Lo que estaba detras de los saltos, sin embargo, eran los limites que
@thatopen le pone a la camara, y que **rehace cada vez que se cambia de modo de
navegacion**: objetivo entre 1 y 300 m, con `infinityDolly` para que la rueda
siga haciendo algo mas alla de ese tope. Pasado el tope, `infinityDolly` deja
de acercar la camara y lo que hace es empujar el objetivo: el paso dejaba de
ser una fraccion de lo que uno tiene delante y pasaba a serlo de los 300 m del
tope, asi que a dos metros de un muro un tic lo atravesaba. Y el mismo tope
recortaba el encuadre general, que en el modelo de canales necesita 15.827 m.

`Viewer.ajustarControles` pone el tope en cuatro veces la diagonal de lo
montado — holgado para encuadrarlo entero, que necesita cerca de una, y dentro
del plano lejano, que se calcula a cinco —, baja la distancia minima de 6 m a
1 cm y apaga `infinityDolly`. Se reaplica al montar, al desmontar y despues de
cada cambio de modo. En **primera persona no se tocan**: ese modo esta
construido justamente sobre el tope fijo y `infinityDolly`, que es como la
rueda hace avanzar.

Tambien se apaga `dollyToCursor`, el seguimiento lateral del cursor de la
libreria. El zoom acerca en linea recta hacia donde mira la camara y la
referencia que sale del cursor es la profundidad, no la direccion. Se pierde
que el punto apuntado quede clavado bajo el puntero; se gana que el avance sea
el mismo siempre.

Las medidas, girando la rueda tic a tic desde la vista general: 2930, 2392,
1948, 1588, 1293, 1053, 858, 698, 569, 463, 377 y 308 metros, un factor
constante de 0,82 y ningun repunte. La prueba comprueba las dos cosas por
separado: que ningun tic se coma mas de la mitad de la distancia al objetivo, y
que de un tic al siguiente el paso nunca crezca. El encuadre no se comprueba
por la distancia sino proyectando las ocho esquinas de la caja del modelo, que
es lo unico que distingue "encuadra" de "la libreria recorto la distancia y no
lo dijo".

## Entregable depurado

Un modelo exportado puede traer algo que no deberia ir: una obra de arte mal
disenada, un elemento duplicado. Corregirlo en el software de origen y volver a
exportar cuesta horas. Esto permite escribir **una copia del IFC sin esos
elementos** para entregarla ya, y no sustituye a corregir el modelo de origen.

Se marcan elementos con "Excluir seleccion" —del arbol, del modelo, por ventana
o por similares—, se revisan en una lista agrupada por archivo y se exporta uno
a uno. Los excluidos se ven en el modelo en rojo, o naranja si ademas estan
seleccionados, porque fiarse de recordar que se marco hace diez minutos no es
forma de preparar lo que se le manda a un cliente.

El filtro esta en Rust (`src-tauri/src/depurar.rs`) y trabaja sobre el texto
STEP, no sobre el modelo cargado: lo que se entrega tiene que ser el archivo
original menos lo pedido, no una reserializacion. Indexa las entidades
respetando cadenas entrecomilladas y comentarios, localiza los `GlobalId`
marcados y **arrastra en cascada las relaciones**: si una `IFCREL*` referencia
el elemento en un campo escalar, se va entera; si lo referencia dentro de una
lista, se reescribe la lista sin el, y solo se va si queda vacia. Las entidades
que no cambian se copian byte a byte, y en la cabecera queda un comentario con
la fecha, el archivo de origen y los GUID retirados.

Si aparece un caso que el filtro no sabe resolver, **no escribe nada** y lo
dice. Un filtro de texto que se equivoca se lleva por delante una relacion
compartida y tumba elementos que nadie marco, y eso mirando el visor no se ve.

La prueba no comprueba que salga un archivo: vuelve a convertir el depurado y
compara el conjunto de GUID con el del original menos los pedidos — en el
modelo de canales, 1311 elementos, faltan 0 y sobran 0.

El archivo **no se encoge**: la geometria que se queda huerfana al retirar un
elemento sigue dentro. Quitarla exige recorrer el grafo entero y es un trabajo
aparte; el entregable sale correcto, no mas pequeno.

## Cerrar y volver a abrir

"Cerrar todo" quita los modelos montados y deja el visor vacio. Abrir otro
archivo a continuacion dejaba la aplicacion muerta: la ventana seguia viva — se
podia mover, e incluso cambiar el tema desde "Opciones" — pero el resto de la
barra quedaba apagada, porque sus botones se desactivan mientras hay una carga
en curso y esa carga no terminaba nunca.

La espera forzada de fragments (`update(true)`) se resuelve cuando el worker
devuelve un aviso de fin sellado con un numero de secuencia igual o mayor al de
la ultima peticion enviada. Al quitar el ultimo modelo, la libreria le pide al
worker que lo borre y **acto seguido termina el worker**, asi que ese aviso no
llega jamas. No hay sintoma intermedio: la promesa simplemente no se resuelve.

Toda actualizacion pasa ahora por `Viewer.actualizar`, que no llama a la
libreria cuando no queda ningun modelo montado — sin modelos no hay nada que
actualizar — y que ademas limita la espera: una actualizacion que no vuelve
podra retrasar lo que se ve, pero no dejar la aplicacion inservible.

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

Con `-Ui` se monta `<App />` de verdad en vez del banco de humo, y se le dan
clics reales al lienzo. Existe porque la prueba de humo armaba su propio
arranque del visor: daba verde mientras el panel de propiedades congelaba la
ventana, y volvio a darlo con un clic desplazado el ancho del panel lateral.
Con `-SelfTest2` se anade un segundo IFC y se comprueba el montaje multiple.

```powershell
.\scripts\dev.ps1 -Ui -SelfTest 'C:\ruta\troncal.ifc' -SelfTest2 'C:\ruta\drenaje.ifc'
```

Lo que esa parte comprueba no es que se vean dos cosas, sino las dos formas en
que esto se rompe sin avisar: que el segundo modelo caiga lejos de su sitio, y
que el rayo deje de cuadrar en un modelo desplazado. La primera version de la
comprobacion exigia solo que el desplazamiento no fuese cero, cosa que cumple
igual de bien un error de miles de kilometros; ahora exige que la distancia
entre centros quepa dentro de la diagonal del modelo mayor, que es lo que acabo
delatando el problema de la georreferencia.

La prueba de interfaz cierra y vuelve a abrir el archivo pulsando los botones
de verdad, porque el cuelgue de "Cerrar todo" no se veia de otra forma: el
visor hacia su trabajo, y lo que quedaba atascado era la espera posterior. Mide
aparte que descargar y actualizar vuelvan con el visor vacio, ya que desde
fuera el sintoma — la barra entera apagada — no dice en que llamada se quedo.

La referencia independiente con la que se contrasto todo esto sale de los
propios IFC, sin pasar por la libreria: sumando el origen del `IfcSite` a los
emplazamientos de los elementos, los centros reales de los tres archivos de
Orbital Sur caen a menos de 200 m entre si.

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
  UiTest.tsx                    prueba sobre la interfaz real, con clics
  CargaTest.tsx                 prueba de capacidad: monta todos los IFC de una
                                carpeta y mide memoria y tiempos
  components/ModelTree.tsx      arbol jerarquico, montado de forma perezosa
  components/PropertiesPanel.tsx  property sets del elemento seleccionado
  components/Toolbar.tsx        fila superior: archivos y opciones
  components/Cinta.tsx          cinta desplegada con los grupos de trabajo
  components/PanelSimilares.tsx eleccion de criterio para buscar parecidos
  components/CapaMediciones.tsx rotulos de las medidas, encima del lienzo
  components/PanelEntregable.tsx  revision y exportacion del IFC depurado
  lib/bridge.ts                 protocolo del SharedArrayBuffer
  lib/conversion.ts             dialogo, cache y orquestacion del worker
  lib/tree.ts                   aplanado del arbol espacial, una raiz por archivo
  lib/log.ts                    reenvio de la consola del WebView al log de Rust
  lib/updater.ts                actualizacion automatica
  viewer/Viewer.ts              escena, camara, seleccion, visibilidad,
                                coordinacion entre modelos, vistas y medicion
  workers/ifcConverter.worker.ts  conversion IFC -> Fragments
src-tauri/
  src/commands.rs               metadatos, ruta de cache y lectura por trozos
  src/depurar.rs                filtro STEP: copia el IFC sin unos elementos
  src/lib.rs                    registro de plugins
scripts/copy-assets.mjs         copia los .wasm y el worker a public/
scripts/dev.ps1                 entorno del toolchain portable en Windows
```
