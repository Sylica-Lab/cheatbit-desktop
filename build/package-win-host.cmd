@echo off
setlocal

set "ROOT=%~dp0.."
set "NODE_EXE=C:\nvm4w\nodejs\node.exe"
set "NODE_ENV=production"
pushd "%ROOT%"

call "%NODE_EXE%" "%ROOT%\node_modules\rimraf\dist\esm\bin.mjs" dist dist-electron
if errorlevel 1 goto :fail

call "%NODE_EXE%" "%ROOT%\node_modules\vite\bin\vite.js" build
if errorlevel 1 goto :fail

call "%NODE_EXE%" "%ROOT%\node_modules\typescript\bin\tsc" -p tsconfig.electron.json
if errorlevel 1 goto :fail

call "%NODE_EXE%" "%ROOT%\node_modules\electron-builder\cli.js" build --win
if errorlevel 1 goto :fail

popd
exit /b 0

:fail
set "ERR=%ERRORLEVEL%"
popd
exit /b %ERR%
