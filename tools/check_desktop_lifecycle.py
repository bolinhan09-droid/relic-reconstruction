"""Exercise real desktop backend ownership without touching user workspaces."""
from pathlib import Path
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from desktop_runtime import (process_identity, matching_identity, WorkspaceLease, OwnedProcessJob,
                             default_workspace)


def await_true(predicate, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(.1)
    raise AssertionError('timed out')


class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='relic-lifecycle-')
        self.workspace = Path(self.temp.name)
        self.children = []
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.port = sock.getsockname()[1]

    def tearDown(self):
        for process in self.children:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
        time.sleep(.2)
        self.temp.cleanup()

    def start(self, duration=60):
        log = (self.workspace / ('test-' + str(len(self.children)) + '.log')).open('wb')
        process = subprocess.Popen([sys.executable, str(ROOT / 'desktop.py'), '--data-dir',
                                    str(self.workspace), '--port', str(self.port),
                                    '--headless-seconds', str(duration)],
                                   cwd=ROOT, stdout=log, stderr=log,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        log.close()
        self.children.append(process)
        return process

    def ready(self):
        try:
            record = json.loads((self.workspace / 'runtime/desktop-instance.json').read_text(encoding='utf-8'))
            return record if record['state'] == 'ready' else None
        except (OSError, ValueError):
            return None

    def test_duplicate_and_clean_reopen(self):
        first = self.start(2.5)
        original = await_true(self.ready)
        second = self.start()
        self.assertEqual(second.wait(timeout=8), 0)
        self.assertEqual(self.ready()['nonce'], original['nonce'])
        self.assertEqual(first.wait(timeout=15), 0)
        await_true(lambda: process_identity(original['childPid']) is None)
        self.assertFalse((self.workspace / 'runtime/desktop-instance.json').exists())
        reopened = self.start(.5)
        latest = await_true(self.ready)
        self.assertNotEqual(latest['nonce'], original['nonce'])
        self.assertEqual(reopened.wait(timeout=15), 0)

    @unittest.skipUnless(os.name == 'nt', 'Windows process tree')
    def test_shell_crash_kills_backend_and_reopens(self):
        first = self.start()
        original = await_true(self.ready)
        # A Windows venv Popen PID is only its redirector. Crash the verified
        # real shell recorded by the lease, not just that redirector.
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.assertEqual(process_identity(original['pid']), original['created'])
        handle = kernel.OpenProcess(1, False, original['pid'])
        self.assertTrue(handle)
        try:
            self.assertTrue(kernel.TerminateProcess(handle, 79))
        finally:
            kernel.CloseHandle(handle)
        first.wait(timeout=8)
        await_true(lambda: process_identity(original['childPid']) is None)
        await_true(lambda: process_identity(original['backendPid']) is None)
        reopened = self.start(.5)
        newest = await_true(lambda: (r if (r := self.ready()) and r['nonce'] != original['nonce'] else None))
        self.assertNotEqual(newest['nonce'], original['nonce'])
        self.assertEqual(reopened.wait(timeout=15), 0)

    @unittest.skipUnless(os.name == 'nt', 'Windows process tree')
    def test_job_contains_descendants(self):
        job = OwnedProcessJob()
        external = subprocess.Popen([sys._base_executable, '-c', 'import time; time.sleep(90)'],
                                    creationflags=subprocess.CREATE_NO_WINDOW)
        self.children.append(external)
        try:
            code = ('import subprocess,sys,time; '
                    'p=subprocess.Popen([sys.executable,"-c","import time; time.sleep(90)"]); '
                    'print(p.pid,flush=True); time.sleep(90)')
            parent = subprocess.Popen([sys.executable, '-c', code], stdout=subprocess.PIPE, text=True,
                                      creationflags=subprocess.CREATE_NO_WINDOW)
            self.children.append(parent)
            job.add(parent)
            child_pid = int(parent.stdout.readline())
            parent.stdout.close()
            self.assertIsNotNone(process_identity(child_pid))
            job.close()
            await_true(lambda: process_identity(child_pid) is None)
            await_true(lambda: parent.poll() is not None)
            self.assertIsNone(external.poll(), 'unrelated shared model must stay alive')
        finally:
            job.close()

    def test_installed_default_workspace_is_external(self):
        current = self.workspace / '当前版本'
        current.mkdir()
        self.assertEqual(default_workspace(current, True), current / 'workspace')
        (current / '.relic-install.json').write_text(json.dumps({
            'application': 'relic-reconstruction', 'installRoot': str(self.workspace.resolve())}))
        self.assertEqual(default_workspace(current, True), self.workspace / '桌面版工作区')
        self.assertEqual(default_workspace(current, False), current / 'workspace')

    def test_self_check_never_writes_inherited_workspace(self):
        personal = self.workspace / 'must-not-create'
        environment = os.environ.copy()
        environment['RELIC_DATA_DIR'] = str(personal)
        environment['RELIC_DESKTOP_INSTANCE'] = '{"invalid":"inherited"}'
        for report, code in ((self.workspace / 'check.json', 0),
                             (self.workspace / 'missing-parent' / 'check.json', 1)):
            result = subprocess.run([sys.executable, str(ROOT / 'desktop.py'),
                                     '--self-check-report', str(report)],
                                    env=environment, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, timeout=20)
            self.assertEqual(result.returncode, code)
            self.assertFalse(personal.exists())

    def test_identity_rejects_wrong_workspace_nonce_version(self):
        lease = WorkspaceLease(self.workspace, self.port)
        self.assertTrue(lease.acquire())
        try:
            record = lease.record
            correct = dict(application=record['application'], version=record['version'],
                           workspace=record['workspace'], nonce=record['nonce'],
                           parentPid=record['pid'], pid=123)
            self.assertTrue(matching_identity(correct, record, 123))
            for key in ('nonce', 'workspace', 'version', 'parentPid', 'pid'):
                modified = dict(correct)
                modified[key] = 'wrong'
                self.assertFalse(matching_identity(modified, record, 123))
        finally:
            lease.close()

    def test_unknown_port_is_not_adopted_or_killed(self):
        with socket.socket() as occupied:
            occupied.bind(('127.0.0.1', self.port))
            occupied.listen()
            process = self.start()
            self.assertNotEqual(process.wait(timeout=10), 0)
            self.assertEqual(occupied.getsockname()[1], self.port)
            self.assertTrue((self.workspace / 'runtime/desktop-launcher.log').is_file())


if __name__ == '__main__':
    unittest.main(verbosity=2)
