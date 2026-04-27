@echo off
setlocal enabledelayedexpansion
title FrameForge — Build ^& Release
cd /d "%~dp0"

echo ============================================
echo  FrameForge — Build ^& GitHub Release
echo ============================================
echo.

:: ── Ask for version ──────────────────────────────────────────────────────────
set /p VERSION="Enter version (e.g. 0.3.0): "
if "%VERSION%"=="" (
    echo No version entered. Aborting.
    pause & exit /b 1
)
set TAG=v%VERSION%

:: ── Update version in tauri.conf.json ────────────────────────────────────────
echo Updating version to %VERSION% in tauri.conf.json...
powershell -Command "(Get-Content 'src-tauri\tauri.conf.json') -replace '\"version\": \"[^\"]+\"', '\"version\": \"%VERSION%\"' | Set-Content 'src-tauri\tauri.conf.json'"
powershell -Command "(Get-Content 'package.json') -replace '\"version\": \"[^\"]+\"', '\"version\": \"%VERSION%\"' | Set-Content 'package.json'"

:: ── Build ─────────────────────────────────────────────────────────────────────
echo.
echo Building FrameForge %TAG% (this takes 5-15 minutes)...
echo.
call npm run tauri build
if %errorlevel% neq 0 (
    echo.
    echo BUILD FAILED. Fix the errors above and try again.
    pause & exit /b 1
)

:: ── Find the installer ────────────────────────────────────────────────────────
set EXE_PATH=
for /r "src-tauri\target\release\bundle\nsis" %%f in (*setup.exe) do set EXE_PATH=%%f
set MSI_PATH=
for /r "src-tauri\target\release\bundle\msi" %%f in (*.msi) do set MSI_PATH=%%f

if "%EXE_PATH%"=="" (
    echo Could not find installer. Check src-tauri\target\release\bundle\
    pause & exit /b 1
)

echo.
echo Build complete!
echo   Installer: %EXE_PATH%
if not "%MSI_PATH%"=="" echo   MSI:       %MSI_PATH%

:: ── Git tag ───────────────────────────────────────────────────────────────────
echo.
echo Creating git tag %TAG%...
git add package.json src-tauri\tauri.conf.json
git commit -m "chore: bump version to %VERSION%"
git tag %TAG%
git push
git push origin %TAG%

:: ── GitHub Release ────────────────────────────────────────────────────────────
echo.
echo Publishing GitHub Release %TAG%...
set NOTES=FrameForge %TAG%^

^
Changes in this release:^
- See commit history for details.

if not "%MSI_PATH%"=="" (
    gh release create %TAG% "%EXE_PATH%" "%MSI_PATH%" --title "FrameForge %TAG%" --notes "FrameForge %TAG% — Windows installer" --latest
) else (
    gh release create %TAG% "%EXE_PATH%" --title "FrameForge %TAG%" --notes "FrameForge %TAG% — Windows installer" --latest
)

if %errorlevel% neq 0 (
    echo.
    echo GitHub release failed. Is 'gh' installed and authenticated?
    echo Install: https://cli.github.com/
    echo Auth:    gh auth login
    pause & exit /b 1
)

echo.
echo ============================================
echo  Done! FrameForge %TAG% released on GitHub.
echo ============================================
pause
