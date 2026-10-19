@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONUTF8=1
where py >nul 2>nul
if errorlevel 1 (
  python -m venv .venv
) else (
  py -3 -m venv .venv
)
if errorlevel 1 goto failed
".venv\Scripts\python.exe" -m pip install -r requirements-desktop.txt
if errorlevel 1 goto failed
echo 安装完成。以后双击 start-desktop.cmd 即可打开独立窗口。
pause
exit /b 0
:failed
echo 安装未完成。需要 Windows 10/11 x64、Python 3.10-3.12 x64 和联网安装依赖。
echo 已有免安装 Windows 发布包时，无需安装 Python，直接运行 RelicReconstruction.exe。
pause
exit /b 1
