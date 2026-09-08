@echo off
chcp 936 >nul 2>&1
title 录制工具 v1.0
set TOOL_DIR=%~dp0
echo.
echo  ========================================================
echo    录制工具 v1.0  -  UI自动化录制
echo  ========================================================
echo.
rem 杀掉占用19832端口的旧node进程
taskkill /f /im node.exe >nul 2>&1
timeout /t 1 >nul
rem 检测系统版本选择对应 Node.js
set NODE_CMD=%TOOL_DIR%node-win10\node.exe
ver | findstr /i /c:"6.2" >nul 2>&1 && set NODE_CMD=%TOOL_DIR%node-win2012\node.exe
ver | findstr /i /c:"6.3" >nul 2>&1 && set NODE_CMD=%TOOL_DIR%node-win2012\node.exe
if not exist "%NODE_CMD%" (
    echo  [错误] 未找到 Node.js，请联系管理员
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('%NODE_CMD% --version') do set NODE_VER=%%v
echo  Node.js 版本: %NODE_VER%
echo  正在启动...
echo.
"%NODE_CMD%" "%TOOL_DIR%server.js"
echo.
echo  服务已停止，按任意键关闭窗口...
pause >nul
