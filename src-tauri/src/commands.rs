// Comandos nativos que el frontend necesita para trabajar con archivos grandes.
//
// La lectura por trozos vive aqui en vez de usar el plugin de filesystem
// porque `read_chunk` devuelve los bytes crudos por el canal binario de la IPC:
// para un IFC de ~1 GB eso evita serializar cientos de megabytes a JSON.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
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

/// Ruta del archivo de cache para una clave dada, creando la carpeta si hace
/// falta. La union de rutas se hace aqui y no en el frontend para no tener que
/// codificar el separador de cada sistema operativo en TypeScript.
#[tauri::command]
pub fn cache_path(app: tauri::AppHandle, key: String) -> Result<String, String> {
    // La clave viene de un hash hexadecimal, pero se valida igual: es lo unico
    // que separa esta ruta de un salto fuera de la carpeta de cache.
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

    Ok(dir.join(format!("{key}.frag")).to_string_lossy().into_owned())
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
