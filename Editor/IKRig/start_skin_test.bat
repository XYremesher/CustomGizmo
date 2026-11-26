@echo off
setlocal
set PORT=8124
cd /d "%~dp0"

netstat -ano | findstr :%PORT% >nul
if %errorlevel%==0 (
    echo Port %PORT% is already in use - assuming the dev server is already running, skipping start.
) else (
    start "Peak Punchers Skin Test Server (%PORT%)" cmd /k python -m http.server %PORT%
    timeout /t 2 /nobreak >nul
)

start http://localhost:%PORT%/ProjectFiles/CharacterSkinTest.html
