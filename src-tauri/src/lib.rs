// Punto de entrada de la aplicacion de escritorio.
//
// El grueso de la logica vive en el frontend (React + web-ifc). Aqui solo se
// arma el shell nativo: plugins de dialogo, filesystem, actualizador y log.

mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        // El log va siempre: cuando un modelo de ~1 GB falla en el equipo de
        // alguien mas, el archivo de log es la unica pista disponible.
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("visor-ifc".into()),
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .invoke_handler(tauri::generate_handler![
            commands::file_info,
            commands::cache_path,
            commands::read_chunk,
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar la aplicacion");
}
