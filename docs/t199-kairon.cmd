@echo off
setlocal
set "KAIRON_NODE=C:\nvm4w\nodejs\node.exe"
if not exist "%KAIRON_NODE%" set "KAIRON_NODE=node"
"%KAIRON_NODE%" "%~dp0t199-kairon-with-secrets.mjs" %*
exit /b %ERRORLEVEL%
