@echo off
rem Easy Apply - instala el actualizador de un boton. Correr una sola vez.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
pause
