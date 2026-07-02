# Easy Apply - instala el actualizador de un botón (native messaging host).
# Correr UNA sola vez (doble click a instalar.bat). No necesita admin: usa HKCU.

$ErrorActionPreference = 'Stop'

$updaterDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$hostBat = Join-Path $updaterDir 'host.bat'
$manifestPath = Join-Path $updaterDir 'com.easyapply.updater.json'
$extensionId = 'abgfpmgoacojapfgchfgmbhilckahgcl'

# Manifiesto del host con la ruta absoluta de esta máquina.
$manifest = [ordered]@{
    name            = 'com.easyapply.updater'
    description     = 'Actualizador de Easy Apply (git pull en el repo local)'
    path            = $hostBat
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$extensionId/")
}
$manifest | ConvertTo-Json | Out-File -FilePath $manifestPath -Encoding utf8

# Registrar el host para Chrome, Edge y Chromium (HKCU, sin admin).
$regPaths = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.easyapply.updater',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.easyapply.updater',
    'HKCU:\Software\Chromium\NativeMessagingHosts\com.easyapply.updater'
)
foreach ($rp in $regPaths) {
    New-Item -Path $rp -Force | Out-Null
    Set-ItemProperty -Path $rp -Name '(Default)' -Value $manifestPath
}

Write-Host ''
Write-Host '=========================================================='
Write-Host ' Easy Apply: actualizador instalado.'
Write-Host ' Desde ahora, el boton "Actualizar ahora" del popup baja la'
Write-Host ' ultima version de GitHub y recarga la extension sola.'
Write-Host ' (Si Chrome estaba abierto, cerralo y abrilo una vez.)'
Write-Host '=========================================================='
