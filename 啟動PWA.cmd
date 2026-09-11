@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "0906 任務計畫服務" /min node server.js
timeout /t 1 /nobreak >nul
start "" http://localhost:8765/
