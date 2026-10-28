@echo off
chcp 65001 >nul
node "%~dp0scripts\import.mjs" %*
echo.
pause
