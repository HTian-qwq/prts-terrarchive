@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\prts-terrarchive-portable\test-desktop.ps1" -PluginPath "%~dp0." %*
if errorlevel 1 pause
