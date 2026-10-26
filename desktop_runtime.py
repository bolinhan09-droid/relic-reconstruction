"""Process ownership and readiness for the local desktop shell.

All process actions are restricted to handles created by this launcher. A PID,
port number, window title or stale lock file alone is never a kill permission.
"""
from __future__ import annotations

import ctypes
import hashlib
import json
import os
from pathlib import Path
import threading
import time
import urllib.request
import uuid

APP_VERSION = '0.11.7'


def default_workspace(base, frozen):
    """Installed builds share external data even when the EXE is opened directly.

An ordinary extracted portable ZIP retains its documented adjacent workspace.
Only our verified fixed installation marker changes that convention.
"""
    base = Path(base).resolve()
    if frozen and base.name == '当前版本':
        try:
            marker = base / '.relic-install.json'
            if marker.stat().st_size <= 4096:
                record = json.loads(marker.read_text(encoding='utf-8'))
                if (record.get('application') == 'relic-reconstruction'
                        and record.get('installRoot') == str(base.parent)):
                    return base.parent / '桌面版工作区'
        except (OSError, ValueError, AttributeError):
            pass
    return base / 'workspace'


def workspace_key(workspace):
    return hashlib.sha256(os.path.normcase(str(Path(workspace).resolve())).encode('utf-8')).hexdigest()


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def process_identity(pid):
    """Include creation time so a recycled Windows PID cannot become an owner."""
    if os.name != 'nt':
        try:
            return Path(f'/proc/{int(pid)}/stat').read_text().split(') ', 1)[1].split()[19]
        except (OSError, ValueError, IndexError):
            return None
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x1000, False, int(pid))
    if not handle:
        return None
    try:
        code = wintypes.DWORD()
        if not kernel.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value != 259:
            return None
        values = [wintypes.FILETIME() for _ in range(4)]
        if not kernel.GetProcessTimes(handle, *(ctypes.byref(value) for value in values)):
            return None
        return str((values[0].dwHighDateTime << 32) | values[0].dwLowDateTime)
    finally:
        kernel.CloseHandle(handle)


class WorkspaceLease:
    def __init__(self, workspace, port):
        self.workspace = Path(workspace).resolve()
        self.runtime = self.workspace / 'runtime'
        self.runtime.mkdir(parents=True, exist_ok=True)
        self.path = self.runtime / 'desktop-instance.json'
        self.file = None
        self.owned = False
        self.record = dict(application='relic-reconstruction', version=APP_VERSION,
                           workspace=workspace_key(workspace), pid=os.getpid(),
                           created=process_identity(os.getpid()), nonce=uuid.uuid4().hex,
                           port=port, state='starting')

    def acquire(self):
        self.file = (self.runtime / 'desktop.lock').open('a+b')
        if self.file.seek(0, 2) == 0:
            self.file.write(b'\0')
            self.file.flush()
        self.file.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.file.close()
            self.file = None
            return False
        self.owned = True
        self.update()
        return True

    def update(self, **fields):
        self.record.update(fields)
        atomic_json(self.path, self.record)

    def existing(self):
        try:
            record = json.loads(self.path.read_text(encoding='utf-8'))
            if (record.get('application') == 'relic-reconstruction'
                    and record.get('workspace') == workspace_key(self.workspace)
                    and record.get('created')
                    and process_identity(record.get('pid')) == record['created']):
                return record
        except (OSError, ValueError, TypeError):
            pass
        return None

    def close(self):
        if self.owned:
            try:
                current = json.loads(self.path.read_text(encoding='utf-8'))
                if current.get('nonce') == self.record['nonce']:
                    self.path.unlink(missing_ok=True)
            except (OSError, ValueError):
                pass
        if self.file:
            self.file.close()
        self.file = None
        self.owned = False


def focus_process(pid):
    """Focus only a visible top-level window owned by the verified shell PID."""
    if os.name != 'nt':
        return False
    from ctypes import wintypes
    user = ctypes.WinDLL('user32', use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user.IsWindowVisible.argtypes = [wintypes.HWND]
    user.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user.SetForegroundWindow.argtypes = [wintypes.HWND]
    found = []

    @callback_type
    def visit(handle, _):
        owner = wintypes.DWORD()
        user.GetWindowThreadProcessId(handle, ctypes.byref(owner))
        if owner.value == pid and user.IsWindowVisible(handle):
            found.append(handle)
        return True

    user.EnumWindows(visit, 0)
    for handle in found:
        user.ShowWindow(handle, 9)
        user.SetForegroundWindow(handle)
    return bool(found)


class OwnedProcessJob:
    """Windows closes every owned descendant even after a shell crash."""
    def __init__(self):
        self.handle = None
        if os.name != 'nt':
            return
        from ctypes import wintypes

        class Basic(ctypes.Structure):
            _fields_ = [('ProcessTime', ctypes.c_int64), ('JobTime', ctypes.c_int64),
                        ('Flags', wintypes.DWORD), ('MinimumWorkingSetSize', ctypes.c_size_t),
                        ('MaximumWorkingSetSize', ctypes.c_size_t), ('ActiveProcessLimit', wintypes.DWORD),
                        ('Affinity', ctypes.c_size_t), ('PriorityClass', wintypes.DWORD),
                        ('SchedulingClass', wintypes.DWORD)]

        class IO(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in
                        ('ReadOperationCount', 'WriteOperationCount', 'OtherOperationCount',
                         'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount')]

        class Extended(ctypes.Structure):
            _fields_ = [('Basic', Basic), ('IO', IO), ('ProcessMemoryLimit', ctypes.c_size_t),
                        ('JobMemoryLimit', ctypes.c_size_t), ('PeakProcessMemoryUsed', ctypes.c_size_t),
                        ('PeakJobMemoryUsed', ctypes.c_size_t)]

        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        self.kernel.CreateJobObjectW.restype = wintypes.HANDLE
        self.kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        self.kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        self.kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.kernel.OpenProcess.restype = wintypes.HANDLE
        self.kernel.IsProcessInJob.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.handle = self.kernel.CreateJobObjectW(None, None)
        if not self.handle:
            raise OSError(ctypes.get_last_error(), '无法建立桌面进程保护')
        limits = Extended()
        limits.Basic.Flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            code = ctypes.get_last_error()
            self.close()
            raise OSError(code, '无法设置桌面进程保护')

    def add(self, process):
        if self.handle and not self.kernel.AssignProcessToJobObject(self.handle, int(process._handle)):
            raise OSError(ctypes.get_last_error(), '无法保护本机服务，请关闭旧版后重试')

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None

    def contains(self, pid):
        if not self.handle:
            return False
        from ctypes import wintypes
        handle = self.kernel.OpenProcess(0x1000, False, int(pid))
        if not handle:
            return False
        try:
            answer = wintypes.BOOL()
            return bool(self.kernel.IsProcessInJob(handle, self.handle, ctypes.byref(answer)) and answer.value)
        finally:
            self.kernel.CloseHandle(handle)


def parent_watchdog(pid, created):
    # Also covers the short interval between child creation and Job assignment.
    def watch():
        while process_identity(pid) == created:
            time.sleep(.5)
        os._exit(73)
    threading.Thread(target=watch, daemon=True, name='desktop-parent-watch').start()


def request_json(port, path='/api/desktop/identity', timeout=1):
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f'http://127.0.0.1:{port}{path}', timeout=timeout) as response:
            return json.load(response)
    except Exception:
        return None


def matching_identity(value, record, child_pid):
    return bool(isinstance(value, dict)
                and value.get('application') == 'relic-reconstruction'
                and value.get('version') == record['version']
                and value.get('workspace') == record['workspace']
                and value.get('nonce') == record['nonce']
                and value.get('parentPid') == record['pid']
                and value.get('pid') == child_pid)


class StartupNotice:
    """Tiny native feedback, independent of the slow WebView2 initialization."""
    def __init__(self, enabled=True):
        self.enabled = enabled and os.name == 'nt'
        self.handle = None
        self.done = threading.Event()
        if self.enabled:
            threading.Thread(target=self._show, daemon=True, name='desktop-startup').start()

    def _show(self):
        from ctypes import wintypes
        user = ctypes.WinDLL('user32', use_last_error=True)
        user.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR,
                                       wintypes.DWORD, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                       ctypes.c_int, wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE,
                                       ctypes.c_void_p]
        user.CreateWindowExW.restype = wintypes.HWND
        user.DestroyWindow.argtypes = [wintypes.HWND]
        user.PeekMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND,
                                     wintypes.UINT, wintypes.UINT, wintypes.UINT]
        user.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
        x = max(0, (user.GetSystemMetrics(0) - 380) // 2)
        y = max(0, (user.GetSystemMetrics(1) - 100) // 2)
        self.handle = user.CreateWindowExW(0x80, 'STATIC', '正在打开遗迹重构…\n正在准备本机工作区',
                                          0x90000000 | 0x00800000 | 1 | 0x200,
                                          x, y, 380, 100, None, None, None, None)
        message = wintypes.MSG()
        while not self.done.wait(.03):
            while user.PeekMessageW(ctypes.byref(message), None, 0, 0, 1):
                user.TranslateMessage(ctypes.byref(message))
                user.DispatchMessageW(ctypes.byref(message))
        if self.handle:
            user.DestroyWindow(self.handle)
            self.handle = None

    def close(self):
        self.done.set()
