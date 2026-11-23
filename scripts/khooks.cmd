@echo off
setlocal DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0KHooks.exe" "%~dp0resources\cli\khooks.mjs" %*
exit /b %errorlevel%
