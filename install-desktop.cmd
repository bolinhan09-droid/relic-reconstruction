@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONUTF8=1
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -c "import sys,struct;sys.exit(0 if sys.version_info[0] == 3 and sys.version_info[1] in (10,11,12) and struct.calcsize('P') == 8 else 1)" >nul 2>nul
  if errorlevel 1 goto incompatible
  goto install
)
where py >nul 2>nul
if not errorlevel 1 (
  for %%V in (3.12 3.11 3.10) do (
    py -%%V -c "import struct,sys;sys.exit(0 if struct.calcsize('P') == 8 else 1)" >nul 2>nul
    if not errorlevel 1 (
      py -%%V -m venv .venv
      if errorlevel 1 goto failed
      goto install
    )
  )
)
python -c "import sys,struct;sys.exit(0 if sys.version_info[0] == 3 and sys.version_info[1] in (10,11,12) and struct.calcsize('P') == 8 else 1)" >nul 2>nul
if errorlevel 1 goto failed
python -m venv .venv
if errorlevel 1 goto failed
:install
".venv\Scripts\python.exe" -m pip install -r requirements-desktop.txt
if errorlevel 1 goto failed
echo 安装完成。以后双击 start-desktop.cmd 即可打开独立窗口。
pause
exit /b 0
:incompatible
echo 现有 .venv 不是 Python 3.10-3.12 x64。请先将 .venv 改名备份，再重新安装。
pause
exit /b 1
:failed
echo 安装未完成。需要 Windows 10/11 x64、Python 3.10-3.12 x64 和联网安装依赖。
echo 已有免安装 Windows 发布包时，无需安装 Python，直接运行 RelicReconstruction.exe。
pause
exit /b 1
