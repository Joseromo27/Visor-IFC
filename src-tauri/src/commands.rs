// Comandos nativos que el frontend necesita para trabajar con archivos grandes.
//
// La lectura por trozos vive aqui en vez de usar el plugin de filesystem
// porque `read_chunk` devuelve los bytes crudos por el canal binario de la IPC:
// para un IFC de ~1 GB eso evita serializar cientos de megabytes a JSON.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::ipc::Response;
use tauri::Manager;

#[derive(Serialize)]
pub struct FileInfo {
    /// Tamano en bytes.
    pub size: u64,
    /// Fecha de modificacion en milisegundos desde epoch. `null` si el sistema
    /// de archivos no la expone.
    pub modified_ms: Option<u64>,
    /// Nombre del archivo sin la ruta.
    pub name: String,
}

/// Metadatos usados para construir la clave de cache de un IFC.
#[tauri::command]
pub fn file_info(path: String) -> Result<FileInfo, String> {
    let p = Path::new(&path);
    let meta = fs::metadata(p).map_err(|e| format!("No se pudo leer '{path}': {e}"))?;

    if !meta.is_file() {
        return Err(format!("'{path}' no es un archivo"));
    }

    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);

    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());

    Ok(FileInfo {
        size: meta.len(),
        modified_ms,
        name,
    })
}

/// Ruta del archivo de cache para una clave dada. La necesita el frontend
/// para escribir el resultado de la conversion.
#[tauri::command]
pub fn cache_path(app: tauri::AppHandle, key: String) -> Result<String, String> {
    Ok(ruta_cache(&app, &key)?.to_string_lossy().into_owned())
}

/// Ruta del archivo de cache, con la carpeta ya creada.
///
/// La union de rutas se hace aqui y no en el frontend para no codificar el
/// separador de cada sistema operativo en TypeScript. La clave viene de un
/// hash hexadecimal, pero se valida igual: es lo unico que separa esta ruta de
/// un salto fuera de la carpeta de cache.
fn ruta_cache(app: &tauri::AppHandle, key: &str) -> Result<PathBuf, String> {
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("Clave de cache invalida: '{key}'"));
    }

    let dir: PathBuf = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("No se pudo resolver la carpeta de datos: {e}"))?
        .join("cache-fragments");

    fs::create_dir_all(&dir)
        .map_err(|e| format!("No se pudo crear '{}': {e}", dir.display()))?;

    Ok(dir.join(format!("{key}.frag")))
}

/// Indica si hay Fragments cacheados para esa clave.
///
/// Lo resuelve el lado nativo y no el plugin de filesystem porque el alcance
/// del plugin rechaza estas mismas rutas en cuanto el archivo existe: la
/// comprobacion devuelve `false` sin problema mientras no hay nada, y falla
/// con "forbidden path" justo despues de crearlo, de modo que reabrir un
/// modelo ya convertido reventaba.
#[tauri::command]
pub fn cache_has(app: tauri::AppHandle, key: String) -> Result<bool, String> {
    Ok(ruta_cache(&app, &key)?.is_file())
}

/// Lee los Fragments cacheados. Devuelve un buffer vacio si no hay nada.
#[tauri::command]
pub fn cache_read(app: tauri::AppHandle, key: String) -> Result<Response, String> {
    let ruta = ruta_cache(&app, &key)?;
    if !ruta.is_file() {
        return Ok(Response::new(Vec::new()));
    }
    let datos = fs::read(&ruta)
        .map_err(|e| format!("No se pudo leer el cache '{}': {e}", ruta.display()))?;
    Ok(Response::new(datos))
}

/// Lee `len` bytes desde `offset`. Devuelve menos bytes al llegar al final del
/// archivo, y un buffer vacio si `offset` ya esta pasado el final.
#[tauri::command]
pub fn read_chunk(path: String, offset: u64, len: u32) -> Result<Response, String> {
    let mut file =
        fs::File::open(&path).map_err(|e| format!("No se pudo abrir '{path}': {e}"))?;

    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("No se pudo posicionar en {offset}: {e}"))?;

    let mut buf = vec![0u8; len as usize];
    let mut filled = 0usize;

    // `read` puede devolver menos bytes de los pedidos sin que sea EOF.
    while filled < buf.len() {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break, // EOF
            Ok(n) => filled += n,
            Err(e) => return Err(format!("Error leyendo '{path}': {e}")),
        }
    }

    buf.truncate(filled);
    Ok(Response::new(buf))
}

/// Ruta de un IFC que el sistema operativo quiere abrir.
///
/// Windows entrega el archivo como argumento de linea de comandos, tanto al
/// hacer doble clic como con "Abrir con". No se puede avisar al frontend por
/// un evento sin mas: en el arranque en frio la ventana todavia no escucha
/// cuando el proceso ya conoce la ruta, asi que se guarda aqui y el frontend
/// la recoge al montarse.
pub struct ArchivoPendiente(pub Mutex<Option<String>>);

/// Entrega la ruta pendiente y la olvida. Devuelve `null` si no hay ninguna.
#[tauri::command]
pub fn archivo_pendiente(estado: tauri::State<ArchivoPendiente>) -> Option<String> {
    estado.0.lock().ok().and_then(|mut guardia| guardia.take())
}

/// Primer argumento que apunta a un .ifc existente.
///
/// Se filtra por extension y por que el archivo exista, en vez de tomar el
/// segundo argumento sin mirar: en desarrollo el ejecutable recibe argumentos
/// propios de Tauri, y una ruta inventada haria fallar la carga nada mas
/// arrancar.
pub fn ifc_en_argumentos<I>(args: I) -> Option<String>
where
    I: IntoIterator<Item = String>,
{
    args.into_iter().skip(1).find(|arg| {
        !arg.starts_with('-')
            && Path::new(arg)
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("ifc"))
            && Path::new(arg).is_file()
    })
}

#[cfg(test)]
mod pruebas {
    use super::ifc_en_argumentos;

    /// De esta funcion depende que el doble clic en Windows abra algo: lo que
    /// llega es la linea de comandos entera, no una ruta limpia.
    #[test]
    fn elige_el_ifc_de_la_linea_de_comandos() {
        let dir = std::env::temp_dir().join("visor-ifc-pruebas");
        std::fs::create_dir_all(&dir).unwrap();
        let modelo = dir.join("modelo.ifc");
        std::fs::write(&modelo, b"ISO-10303-21;").unwrap();
        let ruta = modelo.to_string_lossy().to_string();

        let arg = |v: &[&str]| {
            ifc_en_argumentos(v.iter().map(|s| s.to_string()).collect::<Vec<_>>())
        };

        // El caso real: el ejecutable y la ruta que entrega el explorador.
        assert_eq!(arg(&["visor-ifc.exe", &ruta]), Some(ruta.clone()));

        // Sin argumentos, arranque normal.
        assert_eq!(arg(&["visor-ifc.exe"]), None);

        // Las banderas no son rutas, y el propio ejecutable tampoco cuenta
        // aunque se llamara como el archivo.
        assert_eq!(arg(&["visor-ifc.exe", "--no-sandbox"]), None);

        // Una ruta que no existe no se intenta abrir: en desarrollo llegan
        // argumentos ajenos y una carga fallida al arrancar no se entiende.
        assert_eq!(arg(&["visor-ifc.exe", r"C:\no\existe\modelo.ifc"]), None);

        // Otro tipo de archivo se ignora, aunque exista.
        let otro = dir.join("datos.txt");
        std::fs::write(&otro, b"x").unwrap();
        assert_eq!(arg(&["visor-ifc.exe", &otro.to_string_lossy()]), None);

        // La extension puede venir en mayusculas.
        let gritado = dir.join("MODELO.IFC");
        std::fs::write(&gritado, b"ISO-10303-21;").unwrap();
        assert_eq!(
            arg(&["visor-ifc.exe", &gritado.to_string_lossy()]),
            Some(gritado.to_string_lossy().to_string())
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}

/// Resultado de quitar elementos de un IFC, para la interfaz.
#[derive(Serialize)]
pub struct InformeDepuracion {
    pub eliminados: usize,
    pub no_encontrados: Vec<String>,
    pub relaciones_eliminadas: usize,
    pub relaciones_reparadas: usize,
    pub lineas_borradas: usize,
    pub bytes_entrada: u64,
    pub bytes_salida: u64,
    pub bloqueos: Vec<String>,
}

/// Escribe una copia del IFC sin los elementos indicados.
///
/// Nunca toca el original: si el destino coincide con el origen se rechaza
/// antes de leer nada. Un entregable se genera al lado del archivo bueno, no
/// encima.
#[tauri::command]
pub fn depurar_ifc(
    origen: String,
    destino: String,
    guids: Vec<String>,
    nota: Option<String>,
) -> Result<InformeDepuracion, String> {
    if guids.is_empty() {
        return Err("No hay ningun elemento marcado para quitar".into());
    }

    let ruta_origen = Path::new(&origen);
    let ruta_destino = Path::new(&destino);
    if mismo_archivo(ruta_origen, ruta_destino) {
        return Err("El destino no puede ser el archivo original".into());
    }

    let datos = fs::read(ruta_origen)
        .map_err(|e| format!("No se pudo leer '{origen}': {e}"))?;

    let (informe, salida) = crate::depurar::depurar(&datos, &guids, nota.as_deref());

    if !informe.bloqueos.is_empty() {
        return Err(format!(
            "No se puede generar el archivo sin arriesgar a dejarlo invalido:\n{}",
            informe.bloqueos.join("\n")
        ));
    }

    let bytes = salida.ok_or_else(|| {
        "Ninguno de los elementos marcados esta en este archivo".to_string()
    })?;

    fs::write(ruta_destino, &bytes)
        .map_err(|e| format!("No se pudo escribir '{destino}': {e}"))?;

    Ok(InformeDepuracion {
        eliminados: informe.eliminados.len(),
        no_encontrados: informe.no_encontrados,
        relaciones_eliminadas: informe.relaciones_eliminadas,
        relaciones_reparadas: informe.relaciones_reparadas,
        lineas_borradas: informe.lineas_borradas,
        bytes_entrada: informe.bytes_entrada as u64,
        bytes_salida: informe.bytes_salida as u64,
        bloqueos: Vec::new(),
    })
}

/// Compara rutas sin exigir que el destino exista todavia.
fn mismo_archivo(a: &Path, b: &Path) -> bool {
    let normal = |p: &Path| -> PathBuf {
        p.canonicalize().unwrap_or_else(|_| {
            match (p.parent(), p.file_name()) {
                (Some(dir), Some(nombre)) => dir
                    .canonicalize()
                    .unwrap_or_else(|_| dir.to_path_buf())
                    .join(nombre),
                _ => p.to_path_buf(),
            }
        })
    };
    normal(a) == normal(b)
}
