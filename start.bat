@echo off
chcp 65001 >nul
echo ================================================
echo   板块竞价监控系统 - 启动服务
echo ================================================
echo.
echo [1] 正在启动本地服务...
echo     访问地址: http://localhost:8080
echo     按 Ctrl+C 停止服务
echo.

cd /d "%~dp0"
python server.py
pause
