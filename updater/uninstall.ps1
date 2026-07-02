# Easy Apply - desinstala el actualizador (borra las claves de registro).
$ErrorActionPreference = 'SilentlyContinue'
$regPaths = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.easyapply.updater',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.easyapply.updater',
    'HKCU:\Software\Chromium\NativeMessagingHosts\com.easyapply.updater'
)
foreach ($rp in $regPaths) {
    if (Test-Path $rp) { Remove-Item -Path $rp -Recurse -Force -Confirm:$false }
}
Write-Host 'Actualizador de Easy Apply desinstalado.'
