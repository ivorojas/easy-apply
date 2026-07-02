@echo off
rem Easy Apply - actualizacion manual (plan B si no instalaste el actualizador).
rem Baja la ultima version del repo. Despues toca "Recargar extension" en el
rem popup de Easy Apply (o el boton de recarga en chrome://extensions).
cd /d "%~dp0"
git pull --ff-only
echo.
echo Listo. Ahora toca "Recargar extension" en el popup de Easy Apply.
pause
