# Entorno de desarrollo sin permisos de administrador

Tauri compila codigo Rust nativo, asi que necesita Node, Rust y un compilador de
C++ con el SDK de Windows. El instalador oficial de Visual Studio Build Tools
exige privilegios de administrador; estas instrucciones consiguen lo mismo sin
ellos, instalando todo bajo el perfil del usuario.

Verificado en Windows 11 Pro con una cuenta que solo pertenece a
`BUILTIN\Usuarios`.

Todo queda en `%USERPROFILE%\devtools` y `%USERPROFILE%\.cargo`. Para desinstalar
basta con borrar esas dos carpetas y limpiar las variables de entorno.

## 1. Node.js portable

```powershell
$tools = "$env:USERPROFILE\devtools"
New-Item -ItemType Directory -Force -Path $tools | Out-Null

$idx = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
$ver = ($idx | Where-Object { $_.lts -ne $false } | Select-Object -First 1).version

$zip = "$env:TEMP\node-$ver-win-x64.zip"
Invoke-WebRequest "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip" -OutFile $zip -UseBasicParsing
Expand-Archive $zip -DestinationPath $tools -Force
Move-Item "$tools\node-$ver-win-x64" "$tools\nodejs" -Force
Remove-Item $zip
```

## 2. MSVC y Windows SDK portables

Se usa `portable-msvc.py`, que descarga los paquetes oficiales de Microsoft y
los extrae sin pasar por el instalador de Visual Studio. Requiere Python.

```powershell
$tools = "$env:USERPROFILE\devtools"
Invoke-WebRequest 'https://gist.githubusercontent.com/mmozeiko/7f3162ec2988e81e56d5c4e22cde9977/raw/portable-msvc.py' -OutFile "$tools\portable-msvc.py" -UseBasicParsing

Push-Location $tools
python .\portable-msvc.py --accept-license --vs 2022 --host x64 --target x64
Pop-Location
```

Descarga unos 460 MB y ocupa alrededor de 1,2 GB. Deja el toolchain en
`devtools\msvc` junto con un `setup_x64.bat` que indica las rutas exactas de la
version instalada.

## 3. Rust

```powershell
Invoke-WebRequest 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe' -OutFile "$env:TEMP\rustup-init.exe" -UseBasicParsing
cmd /c "%TEMP%\rustup-init.exe -y --default-host x86_64-pc-windows-msvc --default-toolchain stable --profile minimal --no-modify-path"
```

`rustup-init` avisa `installing msvc toolchain without its prerequisites`. Es
esperado: no encuentra Visual Studio en el registro porque el toolchain es
portable, y funciona igual una vez configuradas las variables del paso 4.

> **No ejecutar el instalador con `2>&1` en PowerShell 5.1.** Esa redireccion
> convierte el aviso de stderr en un error de PowerShell y, con
> `$ErrorActionPreference = 'Stop'`, corta el proceso a medio camino. Queda un
> `rustup.exe` truncado que crashea con `0xC0000005` y parece un binario
> manipulado por el antivirus. Por eso arriba se invoca a traves de `cmd`.

## 4. Variables de entorno

Ajustar las versiones a las que dejo el paso 2 (ver `devtools\msvc\setup_x64.bat`).

```powershell
$m    = "$env:USERPROFILE\devtools\msvc"
$vc   = "$m\VC\Tools\MSVC\14.44.35207"
$sdk  = "$m\Windows Kits\10"
$sdkv = "10.0.26100.0"

$add = @(
  "$env:USERPROFILE\.cargo\bin",
  "$vc\bin\Hostx64\x64",
  "$sdk\bin\$sdkv\x64",
  "$sdk\bin\$sdkv\x64\ucrt",
  "$env:USERPROFILE\devtools\nodejs"
)

$cur = [Environment]::GetEnvironmentVariable('Path','User')
foreach ($p in $add) { if ($cur -notlike "*$p*") { $cur = "$cur;$p" } }
[Environment]::SetEnvironmentVariable('Path', $cur, 'User')

[Environment]::SetEnvironmentVariable('INCLUDE', (@(
  "$vc\include",
  "$sdk\Include\$sdkv\ucrt",
  "$sdk\Include\$sdkv\shared",
  "$sdk\Include\$sdkv\um",
  "$sdk\Include\$sdkv\winrt",
  "$sdk\Include\$sdkv\cppwinrt"
) -join ';'), 'User')

[Environment]::SetEnvironmentVariable('LIB', (@(
  "$vc\lib\x64",
  "$sdk\Lib\$sdkv\ucrt\x64",
  "$sdk\Lib\$sdkv\um\x64"
) -join ';'), 'User')
```

Hay que abrir una terminal nueva para que tomen efecto.

## 5. Comprobacion

```powershell
node -v
cargo --version

# El enlace es lo que realmente falla si MSVC no esta bien configurado.
Set-Content "$env:TEMP\t.rs" 'fn main(){ println!("ok"); }'
rustc "$env:TEMP\t.rs" -o "$env:TEMP\t.exe"; & "$env:TEMP\t.exe"
```

Si el ultimo comando imprime `ok`, el entorno esta listo para `npm run tauri:dev`.

## Notas

- **WebView2** ya viene con Windows 11. En Windows 10 puede faltar; el
  instalador de la aplicacion lo descarga solo.
- **Antivirus corporativo**: Kaspersky Endpoint Security ralentiza bastante los
  builds de Rust al analizar cada archivo objeto. Si se puede, conviene pedir
  una exclusion para `src-tauri\target` y `%USERPROFILE%\.cargo`.
- **Espacio en disco**: contar con unos 10 GB libres entre el toolchain,
  `node_modules` y el directorio `target` de Rust.
