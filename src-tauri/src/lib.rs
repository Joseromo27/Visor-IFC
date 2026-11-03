// Punto de entrada de la aplicacion de escritorio.
//
// El grueso de la logica vive en el frontend (React + web-ifc). Aqui solo se
// arma el shell nativo: plugins de dialogo, filesystem, actualizador y log.

mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Una sola ventana. Va antes que ningun otro plugin, como pide el propio
    // plugin: si una segunda instancia arranca, este callback corre en la que
    // ya estaba y la nueva se cierra sola. Sin esto, abrir tres IFC desde el
    // escritorio levantaria tres procesos, cada uno con su copia del modelo.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        use tauri::{Emitter, Manager};

        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(ruta) = commands::ifc_en_argumentos(argv) {
                // Se guarda ademas de avisar: si la ventana esta recargando
                // justo en ese momento, el evento se pierde y la ruta no.
                if let Some(estado) = app.try_state::<commands::ArchivoPendiente>() {
                    if let Ok(mut guardia) = estado.0.lock() {
                        *guardia = Some(ruta.clone());
                    }
                }
                let _ = app.emit("abrir-ifc", ruta);
            }

            // Traer al frente la ventana que ya estaba: si no, el doble clic
            // parece no hacer nada cuando la aplicacion esta minimizada.
            if let Some(ventana) = app.get_webview_window("main") {
                let _ = ventana.unminimize();
                let _ = ventana.set_focus();
            }
        }));
    }

    builder = builder
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
        // Lo que Windows paso al arrancar, si se abrio con doble clic sobre
        // un .ifc o con "Abrir con".
        .manage(commands::ArchivoPendiente(std::sync::Mutex::new(
            commands::ifc_en_argumentos(std::env::args()),
        )))
        .invoke_handler(tauri::generate_handler![
            commands::file_info,
            commands::cache_path,
            commands::cache_has,
            commands::cache_read,
            commands::read_chunk,
            commands::archivo_pendiente,
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar la aplicacion");
}
