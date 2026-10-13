@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================================
echo   GaussRoom 高斯房间
echo.
echo   启动后请用浏览器打开： http://127.0.0.1:8123/
echo   关闭本窗口即停止服务。
echo ============================================================
echo.

node tools\workbench\server.mjs

echo.
echo 服务已停止。
pause
