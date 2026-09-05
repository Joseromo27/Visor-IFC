# Arranca la aplicacion en modo desarrollo con el toolchain portable.
#
# Node, MSVC y Rust estan instalados bajo el perfil del usuario porque el
# equipo no tiene permisos de administrador (ver docs/entorno-sin-admin.md).
# Este script fija PATH, INCLUDE y LIB para que cargo encuentre el linker.
#
# Uso:
#   .\scripts\dev.ps1                      # aplicacion normal
#   .\scripts\dev.ps1 -SelfTest "C:\m.ifc" # prueba de humo y salida
#   .\scripts\dev.ps1 -Build               # instaladores de release

[CmdletBinding()]
param(
  [string] $SelfTest,
  [switch] $Build
)

$ErrorActionPreference = 'Stop'

$tools = "$env:USERPROFILE\devtools"
$msvc = "$tools\msvc"

if (-not (Test-Path $msvc)) {
  throw "No se encontro el toolchain MSVC en $msvc. Ver docs/entorno-sin-admin.md"
}

# Detectar las versiones instaladas en vez de fijarlas: portable-msvc.py
# descarga la ultima disponible y cambia con el tiempo.
$vcVersion = (Get-ChildItem "$msvc\VC\Tools\MSVC" -Directory | Sort-Object Name -Descending | Select-Object -First 1).Name
$sdkVersion = (Get-ChildItem "$msvc\Windows Kits\10\Lib" -Directory | Sort-Object Name -Descending | Select-Object -First 1).Name

$vc = "$msvc\VC\Tools\MSVC\$vcVersion"
$sdk = "$msvc\Windows Kits\10"

$env:Path = @(
  "$env:USERPROFILE\.cargo\bin"
  "$vc\bin\Hostx64\x64"
  "$sdk\bin\$sdkVersion\x64"
  "$sdk\bin\$sdkVersion\x64\ucrt"
  "$tools\nodejs"
  $env:Path
) -join ';'

$env:INCLUDE = @(
  "$vc\include"
  "$sdk\Include\$sdkVersion\ucrt"
  "$sdk\Include\$sdkVersion\shared"
  "$sdk\Include\$sdkVersion\um"
  "$sdk\Include\$sdkVersion\winrt"
  "$sdk\Include\$sdkVersion\cppwinrt"
) -join ';'

$env:LIB = @(
  "$vc\lib\x64"
  "$sdk\Lib\$sdkVersion\ucrt\x64"
  "$sdk\Lib\$sdkVersion\um\x64"
) -join ';'

Write-Host "MSVC $vcVersion | Windows SDK $sdkVersion" -ForegroundColor DarkGray

Push-Location (Split-Path $PSScriptRoot -Parent)
try {
  if ($Build) {
    # Firma de las actualizaciones. Sin la clave, el build igual produce
    # instaladores, pero sin las firmas ni el latest.json que necesita el
    # actualizador.
    #
    # La clave tiene contrasena a proposito. PowerShell no puede exportar una
    # variable de entorno vacia — asignarle '' la borra —, asi que con una
    # clave sin contrasena el CLI de Tauri no encuentra
    # TAURI_SIGNING_PRIVATE_KEY_PASSWORD y se queda esperando en un prompt que
    # nunca se responde.
    $keyPath = "$env:USERPROFILE\.tauri\visor-ifc.key"
    $passPath = "$env:USERPROFILE\.tauri\visor-ifc.password"

    if ((Test-Path $keyPath) -and (Test-Path $passPath)) {
      $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $keyPath -Raw
      $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content $passPath -Raw).Trim()
    } else {
      Write-Warning "Falta $keyPath o $passPath; los artefactos saldran sin firmar y sin latest.json."
    }
    npm run tauri build
  } else {
    if ($SelfTest) {
      if (-not (Test-Path -LiteralPath $SelfTest)) {
        throw "No existe el archivo IFC: $SelfTest"
      }
      $env:VITE_SELFTEST_PATH = (Resolve-Path -LiteralPath $SelfTest).Path
      Write-Host "Prueba de humo sobre $env:VITE_SELFTEST_PATH" -ForegroundColor DarkGray
    }
    npm run tauri dev
  }
} finally {
  Pop-Location
}
