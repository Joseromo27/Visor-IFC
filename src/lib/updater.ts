// Actualizacion automatica contra el feed de releases de GitHub.
//
// La comprobacion es silenciosa a proposito: si no hay red, o el feed todavia
// no existe, la aplicacion tiene que abrir igual.

import { relaunch } from '@tauri-apps/plugin-process'
import { check } from '@tauri-apps/plugin-updater'

export interface UpdateInfo {
  version: string
  notes?: string
  install: (onProgress: (fraction: number | null) => void) => Promise<void>
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const update = await check()
    if (!update) return null

    return {
      version: update.version,
      notes: update.body,
      install: async (onProgress) => {
        let total = 0
        let downloaded = 0

        await update.downloadAndInstall((event) => {
          switch (event.event) {
            case 'Started':
              total = event.data.contentLength ?? 0
              onProgress(total > 0 ? 0 : null)
              break
            case 'Progress':
              downloaded += event.data.chunkLength
              onProgress(total > 0 ? downloaded / total : null)
              break
            case 'Finished':
              onProgress(1)
              break
          }
        })

        await relaunch()
      },
    }
  } catch (err) {
    console.warn('No se pudo comprobar actualizaciones', err)
    return null
  }
}
