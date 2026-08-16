@echo off
cd /d "%~dp0"
echo Iniciando o PromoShop...
start "PromoShop - Servidor" /min cmd /c "npm start"
timeout /t 3 /nobreak >nul
start "" "http://localhost:3001"
exit
