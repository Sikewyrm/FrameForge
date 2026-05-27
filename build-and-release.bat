@echo off
setlocal enabledelayedexpansion
title FrameForge Build and Release
cd /d "%~dp0"

set GITHUB_REPO=Sikewyrm/FrameForge
set GITHUB_URL=https://github.com/Sikewyrm/FrameForge.git

echo ============================================
echo  FrameForge - Build and Release Installer
echo ============================================
echo.

:: Check gh is installed
where gh >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: GitHub CLI is not installed.
    echo Download from: https://cli.github.com/
    pause & exit /b 1
)

:: Read version from package.json automatically
for /f "delims=" %%v in ('node -e "process.stdout.write(require('./package.json').version)"') do set VERSION=%%v
if "!VERSION!"=="" (
    echo ERROR: Could not read version from package.json.
    pause & exit /b 1
)
set TAG=v!VERSION!

echo Version: !TAG! (set this in Settings before building)
echo.
set /p CONFIRM=Press Enter to build and release !TAG!, or Ctrl+C to cancel...
echo.

:: Initialize repo on GitHub if empty
gh api repos/%GITHUB_REPO%/commits >nul 2>&1
if %errorlevel% neq 0 (
    echo Repo is empty - creating initial commit...
    if not exist ".git" git init
    git remote remove origin >nul 2>&1
    git remote add origin %GITHUB_URL%
    echo # FrameForge > README.md
    echo Warframe companion app. Download the latest installer from the Releases tab. >> README.md
    git add README.md
    git commit -m "Initial commit"
    git branch -M main
    git push -u origin main
    del README.md
)

:: Push source code to GitHub before building
echo Pushing source code to GitHub...
git add -A
git commit -m "Release !TAG!" 2>nul || echo Nothing new to commit.
git pull origin main --rebase
if !errorlevel! neq 0 (
    echo ERROR: git pull failed. Resolve conflicts manually and try again.
    pause & exit /b 1
)
git push origin main
if !errorlevel! neq 0 (
    echo ERROR: git push failed. Check your remote and credentials.
    pause & exit /b 1
)
echo.

:: Build
echo Building FrameForge !TAG! - this takes 5-15 minutes...
echo.
call pnpm tauri build
if %errorlevel% neq 0 (
    echo.
    echo BUILD FAILED - see errors above.
    pause & exit /b 1
)

:: Find the installer
set EXE_PATH=
for /r "src-tauri\target\release\bundle\nsis" %%f in (*setup.exe) do set EXE_PATH=%%f

if "!EXE_PATH!"=="" (
    echo ERROR: Installer not found after build.
    pause & exit /b 1
)

echo.
echo Found: !EXE_PATH!
echo.
echo Uploading FrameForge !TAG! to GitHub...
gh release create !TAG! "!EXE_PATH!" --repo %GITHUB_REPO% --title "FrameForge !TAG!" --notes "FrameForge !TAG! - Windows installer" --latest

if %errorlevel% neq 0 (
    echo.
    echo Upload failed. Run: gh auth login
    pause & exit /b 1
)

echo.
echo ============================================
echo  Done! Share this link:
echo  https://github.com/%GITHUB_REPO%/releases/latest
echo ============================================
pause
