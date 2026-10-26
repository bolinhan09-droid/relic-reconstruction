"""Install a verified desktop ZIP into one fixed application directory.

This helper is deliberately outside 当前版本. It never migrates or deletes the
workspace, models, photos or credentials. Only directories carrying our install
ownership marker can be replaced or removed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid
import zipfile

APP = 'relic-reconstruction'
CURRENT = '当前版本'
BACKUP = '上一版本'
MARKER = '.relic-install.json'
MANIFEST = 'desktop-release.json'
MAX_TOTAL = 2 * 1024 ** 3


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def load_small_json(path):
    if Path(path).stat().st_size > 4 * 1024 * 1024:
        raise ValueError('校验文件过大')
    value = json.loads(Path(path).read_text(encoding='utf-8-sig'))
    if not isinstance(value, dict):
        raise ValueError('校验文件格式无效')
    return value


def safe_parts(name):
    if '\\' in name or '\x00' in name or ':' in name or name.startswith('/'):
        raise ValueError('压缩包包含无效路径')
    parts = PurePosixPath(name).parts
    if not parts or any(p in {'.', '..'} or p.endswith(('.', ' ')) for p in parts):
        raise ValueError('压缩包包含路径穿越')
    reserved = {'CON', 'PRN', 'AUX', 'NUL', *(f'COM{i}' for i in range(1, 10)), *(f'LPT{i}' for i in range(1, 10))}
    if any(p.split('.', 1)[0].upper() in reserved for p in parts):
        raise ValueError('压缩包包含保留设备名')
    return parts


def write_manifest(package, version):
    package = Path(package)
    files = {p.relative_to(package).as_posix(): digest(p) for p in sorted(package.rglob('*'))
             if p.is_file() and p.name not in {MANIFEST, MARKER}}
    (package / MANIFEST).write_text(json.dumps(dict(application=APP, version=version, files=files),
                                               ensure_ascii=False, indent=2), encoding='utf-8')


def unpack_verified(package, target, expected_hash):
    if not re.fullmatch(r'[0-9a-fA-F]{64}', expected_hash or ''):
        raise ValueError('缺少有效 SHA256 校验值，请把发布页的 SHA256.json 放在 ZIP 旁边')
    if digest(package).lower() != expected_hash.lower():
        raise ValueError('ZIP 校验失败，文件可能未下载完整，请重新下载')
    with zipfile.ZipFile(package) as bundle:
        entries = bundle.infolist()
        if not entries or len(entries) > 12000 or sum(x.file_size for x in entries) > MAX_TOTAL:
            raise ValueError('压缩包大小或文件数不符合桌面发布包')
        names = set()
        for info in entries:
            parts = safe_parts(info.filename.rstrip('/'))
            if parts[0] != 'RelicReconstruction' or len(parts) < 2:
                if info.is_dir() and parts == ('RelicReconstruction',):
                    continue
                raise ValueError('请选择 Windows 桌面发布包，不是源码包')
            relative = '/'.join(parts[1:])
            lowered = relative.casefold()
            if lowered in names:
                raise ValueError('压缩包包含重复路径')
            names.add(lowered)
            mode = (info.external_attr >> 16) & 0xFFFF
            if stat.S_ISLNK(mode) or (info.external_attr & 0x400):
                raise ValueError('压缩包不能包含链接或重解析点')
            if parts[1].lower() in {'workspace', 'data', 'models', 'runtime', '.git', '桌面版工作区'}:
                raise ValueError('发布包不应包含用户工作区或模型')
            destination = target.joinpath(*parts[1:])
            if info.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(info) as src, destination.open('wb') as dst:
                    shutil.copyfileobj(src, dst)
    manifest = load_small_json(target / MANIFEST)
    if manifest.get('application') != APP or not re.fullmatch(r'\d+\.\d+\.\d+', str(manifest.get('version', ''))):
        raise ValueError('发布包身份或版本无效')
    files = manifest.get('files')
    if not isinstance(files, dict) or not files or len(files) > 12000:
        raise ValueError('发布包缺少文件清单')
    actual = {p.relative_to(target).as_posix() for p in target.rglob('*') if p.is_file() and p.name != MANIFEST}
    if actual != set(files):
        raise ValueError('发布包的文件清单不匹配')
    for relative, wanted in files.items():
        safe_parts(relative)
        if not isinstance(wanted, str) or digest(target / relative) != wanted:
            raise ValueError('发布包中的文件校验失败：' + relative)
    if not (target / 'RelicReconstruction.exe').is_file() or not (target / '_internal').is_dir():
        raise ValueError('不是完整的 Windows 桌面发布包')
    return manifest


def owned_directory(path, root):
    path, root = Path(path), Path(root).resolve()
    if path.parent.resolve() != root or path.is_symlink():
        return False
    try:
        if getattr(path.stat(), 'st_file_attributes', 0) & 0x400:
            return False
        value = load_small_json(path / MARKER)
        return value.get('application') == APP and value.get('installRoot') == str(root)
    except (OSError, ValueError):
        return False


def remove_owned(path, root):
    if path.exists():
        if not owned_directory(path, root):
            raise ValueError('目录不属于本安装器，已保留：' + str(path))
        shutil.rmtree(path)


def mark_owned(path, root, version):
    (path / MARKER).write_text(json.dumps(dict(application=APP, version=version, installRoot=str(root)),
                                         ensure_ascii=False), encoding='utf-8')


class InstallLock:
    def __init__(self, path):
        self.path = Path(path)
        self.file = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.file = self.path.open('a+b')
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
            raise ValueError('程序或另一个更新任务正在运行，请先保存并关闭窗口') from None
        return self

    def __exit__(self, *_):
        self.file.close()


def self_check(application):
    report = application / '.update-self-check.json'
    try:
        environment = {key: value for key, value in os.environ.items()
                       if key not in {'RELIC_DATA_DIR', 'RELIC_DESKTOP_INSTANCE'}}
        result = subprocess.run([str(application / 'RelicReconstruction.exe'),
                                 '--self-check-report', str(report)],
                                cwd=application, stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                env=environment,
                                timeout=30, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        data = load_small_json(report)
        manifest = load_small_json(application / MANIFEST)
        if result.returncode or data.get('application') != APP or not data.get('ok') or data.get('version') != manifest['version']:
            raise ValueError('新版程序自检未通过，当前版本未更改')
    finally:
        report.unlink(missing_ok=True)


def install(package, root, expected_hash, *, verifier=self_check, replace=os.replace):
    root = Path(root).resolve()
    if root == Path(root.anchor) or root == Path.home().resolve():
        raise ValueError('安装位置必须是独立的产品文件夹')
    root.mkdir(parents=True, exist_ok=True)
    current, backup = root / CURRENT, root / BACKUP
    with InstallLock(root / '程序更新' / 'update.lock'):
        for folder in (current, backup):
            if folder.exists() and not owned_directory(folder, root):
                raise ValueError('已有目录缺少安装标记，已保留，请先把旧版收进归档：' + str(folder))
            if folder.exists() and any((folder / name).exists()
                                       for name in ('workspace', 'data', 'models', 'runtime', '桌面版工作区')):
                raise ValueError('程序目录内发现工作区或模型，请先移到独立目录并保留路径配置：' + str(folder))
        stage = root / ('_更新暂存-' + uuid.uuid4().hex)
        stage.mkdir()
        mark_owned(stage, root, 'staging')
        moved = False
        promoted = False
        try:
            # Unpack into an empty child so our own marker is not part of manifest verification.
            payload = stage / 'payload'
            payload.mkdir()
            manifest = unpack_verified(package, payload, expected_hash)
            verifier(payload)
            mark_owned(payload, root, manifest['version'])
            remove_owned(backup, root)
            if current.exists():
                replace(current, backup)
                moved = True
            try:
                replace(payload, current)
                promoted = True
                # An additional self-check after relocation catches path-sensitive builds.
                verifier(current)
            except Exception:
                if promoted:
                    remove_owned(current, root)
                if moved:
                    replace(backup, current)
                raise
            return dict(ok=True, version=manifest['version'], current=str(current),
                        rollbackAvailable=backup.exists())
        finally:
            remove_owned(stage, root)


def rollback(root, *, verifier=self_check):
    root = Path(root).resolve()
    current, backup = root / CURRENT, root / BACKUP
    with InstallLock(root / '程序更新' / 'update.lock'):
        if not owned_directory(backup, root) or (current.exists() and not owned_directory(current, root)):
            raise ValueError('没有可回退的完整安装')
        verifier(backup)
        if not current.exists():
            # Also recover an interrupted rename transaction without requiring
            # the user to move program directories by hand.
            os.replace(backup, current)
            return dict(ok=True, version=load_small_json(current / MANIFEST)['version'], current=str(current))
        temporary = root / ('_更新暂存-' + uuid.uuid4().hex)
        os.replace(current, temporary)
        try:
            os.replace(backup, current)
            os.replace(temporary, backup)
        except Exception:
            if current.exists() and not backup.exists():
                os.replace(current, backup)
            if temporary.exists() and not current.exists():
                os.replace(temporary, current)
            raise
        return dict(ok=True, version=load_small_json(current / MANIFEST)['version'], current=str(current))


def choose_package():
    if os.name != 'nt':
        return Path(input('新版本 ZIP 路径：').strip().strip('"'))
    import ctypes
    from ctypes import wintypes

    class OpenFileName(ctypes.Structure):
        _fields_ = [('lStructSize', wintypes.DWORD), ('hwndOwner', wintypes.HWND),
                    ('hInstance', wintypes.HINSTANCE), ('lpstrFilter', wintypes.LPCWSTR),
                    ('lpstrCustomFilter', wintypes.LPWSTR), ('nMaxCustFilter', wintypes.DWORD),
                    ('nFilterIndex', wintypes.DWORD), ('lpstrFile', wintypes.LPWSTR),
                    ('nMaxFile', wintypes.DWORD), ('lpstrFileTitle', wintypes.LPWSTR),
                    ('nMaxFileTitle', wintypes.DWORD), ('lpstrInitialDir', wintypes.LPCWSTR),
                    ('lpstrTitle', wintypes.LPCWSTR), ('Flags', wintypes.DWORD),
                    ('nFileOffset', wintypes.WORD), ('nFileExtension', wintypes.WORD),
                    ('lpstrDefExt', wintypes.LPCWSTR), ('lCustData', wintypes.LPARAM),
                    ('lpfnHook', ctypes.c_void_p), ('lpTemplateName', wintypes.LPCWSTR),
                    ('pvReserved', ctypes.c_void_p), ('dwReserved', wintypes.DWORD),
                    ('FlagsEx', wintypes.DWORD)]
    buffer = ctypes.create_unicode_buffer(32768)
    dialog = OpenFileName()
    dialog.lStructSize = ctypes.sizeof(dialog)
    dialog.lpstrFilter = 'Windows 桌面发布包 (*.zip)\0*.zip\0\0'
    dialog.lpstrFile = ctypes.cast(buffer, wintypes.LPWSTR)
    dialog.nMaxFile = len(buffer)
    dialog.lpstrTitle = '选择新版 RelicReconstruction-Windows-x64.zip'
    dialog.Flags = 0x1000 | 0x800 | 0x8
    if ctypes.windll.comdlg32.GetOpenFileNameW(ctypes.byref(dialog)):
        return Path(buffer.value)
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--install-root', type=Path, required=True)
    parser.add_argument('--data-dir', type=Path)
    parser.add_argument('--package', type=Path)
    parser.add_argument('--sha256')
    parser.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    workspace = (args.data_dir or args.install_root / '桌面版工作区').resolve()
    package = args.package
    if not args.rollback and package is None:
        package = choose_package()
        if package is None:
            return 0
    expected = args.sha256
    if not args.rollback and not expected:
        checksum_path = package.parent / 'SHA256.json'
        if checksum_path.is_file():
            expected = load_small_json(checksum_path).get(package.name)
        if not expected:
            raise ValueError('请同时下载发布页的 SHA256.json，并放在 ZIP 旁边，再运行更新')
    # Hold the desktop lock throughout replacement; never stop another process.
    with InstallLock(workspace / 'runtime' / 'desktop.lock'):
        result = rollback(args.install_root) if args.rollback else install(package, args.install_root, expected)
    print(json.dumps(result, ensure_ascii=False))
    if os.name == 'nt' and not args.package:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, '更新完成，继续使用原来的“打开遗迹重构”入口即可',
                                        '遗迹重构', 0x40)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main() or 0)
    except Exception as exc:
        print('更新未完成：' + str(exc), file=sys.stderr)
        if os.name == 'nt':
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, '更新未完成\n\n' + str(exc) +
                                            '\n\n已安装版本和工作区保留', '遗迹重构', 0x10)
        sys.exit(1)
