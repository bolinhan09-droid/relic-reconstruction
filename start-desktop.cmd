@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".venv\Scripts\pythonw.exe" (
  echo 首次运行，请先双击 install-desktop.cmd 安装环境。
  pause
  exit /b 1
)
start "" ".venv\Scripts\pythonw.exe" "desktop.py"
