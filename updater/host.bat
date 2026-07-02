@echo off
rem Easy Apply - lanza el native messaging host en Python.
where python >nul 2>nul
if %errorlevel%==0 (
  python "%~dp0host.py" %*
) else (
  py "%~dp0host.py" %*
)
