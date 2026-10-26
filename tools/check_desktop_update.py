"""Transactional update regression tests, using synthetic packages only."""
from pathlib import Path
import hashlib
import json
import os
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import update_desktop as updater


class Updates(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.install = self.root / 'product'

    def tearDown(self):
        self.temp.cleanup()

    def package(self, version):
        payload = self.root / ('payload-' + version)
        payload.mkdir()
        (payload / '_internal').mkdir()
        (payload / '_internal/runtime.bin').write_bytes(b'owned runtime')
        (payload / 'RelicReconstruction.exe').write_text(version)
        updater.write_manifest(payload, version)
        path = self.root / (version + '.zip')
        with zipfile.ZipFile(path, 'w') as archive:
            for file in payload.rglob('*'):
                if file.is_file():
                    archive.write(file, 'RelicReconstruction/' + file.relative_to(payload).as_posix())
        return path, updater.digest(path)

    def apply(self, version, **kwargs):
        path, checksum = self.package(version)
        return updater.install(path, self.install, checksum, verifier=lambda p: None, **kwargs)

    def current(self):
        return (self.install / updater.CURRENT / 'RelicReconstruction.exe').read_text()

    def test_first_install_update_and_rollback_preserve_workspace_models(self):
        for folder in ('桌面版工作区', '平台源码/models'):
            path = self.install / folder
            path.mkdir(parents=True)
            (path / 'private-data.txt').write_text('do not touch')
        self.apply('0.11.0')
        self.apply('0.12.0')
        self.assertEqual(self.current(), '0.12.0')
        updater.rollback(self.install, verifier=lambda p: None)
        self.assertEqual(self.current(), '0.11.0')
        for folder in ('桌面版工作区', '平台源码/models'):
            self.assertEqual((self.install / folder / 'private-data.txt').read_text(), 'do not touch')
        self.assertFalse(list(self.install.glob('_更新暂存-*')))

    def test_failed_promotion_rolls_back(self):
        self.apply('0.11.0')
        def fail_once(source, target):
            if Path(source).name == 'payload':
                raise OSError('simulated locked destination')
            os.replace(source, target)
        with self.assertRaises(OSError):
            self.apply('0.12.0', replace=fail_once)
        self.assertEqual(self.current(), '0.11.0')
        self.assertFalse(list(self.install.glob('_更新暂存-*')))

    def test_failed_post_move_check_rolls_back(self):
        self.apply('0.11.0')
        package, checksum = self.package('0.12.0')
        def verify(path):
            if path.name == updater.CURRENT:
                raise OSError('post relocation failure')
        with self.assertRaises(OSError):
            updater.install(package, self.install, checksum, verifier=verify)
        self.assertEqual(self.current(), '0.11.0')

    def test_wrong_zip_hash_keeps_current(self):
        self.apply('0.11.0')
        package, _ = self.package('0.12.0')
        with self.assertRaises(ValueError):
            updater.install(package, self.install, '0' * 64, verifier=lambda p: None)
        self.assertEqual(self.current(), '0.11.0')

    def test_manifest_tamper_rejected(self):
        package, _ = self.package('0.11.0')
        with zipfile.ZipFile(package, 'a') as archive:
            archive.writestr('RelicReconstruction/unlisted.txt', 'bad')
        with self.assertRaisesRegex(ValueError, '文件清单'):
            updater.install(package, self.install, updater.digest(package), verifier=lambda p: None)
        self.assertFalse((self.install / updater.CURRENT).exists())

    def test_path_traversal_windows_device_and_case_duplicate(self):
        for bad in ('RelicReconstruction/../../outside.txt', 'RelicReconstruction/C:/outside',
                    'RelicReconstruction/CON.txt', 'RelicReconstruction/evil.'):
            package = self.root / ('bad-' + hashlib.sha256(bad.encode()).hexdigest()[:6] + '.zip')
            with zipfile.ZipFile(package, 'w') as archive:
                archive.writestr(bad, 'bad')
            with self.assertRaises(ValueError):
                updater.install(package, self.install, updater.digest(package), verifier=lambda p: None)
        package, _ = self.package('0.11.0')
        with zipfile.ZipFile(package, 'a') as archive:
            archive.writestr('RelicReconstruction/relicreconstruction.EXE', 'bad')
        with self.assertRaisesRegex(ValueError, '重复路径'):
            updater.install(package, self.install, updater.digest(package), verifier=lambda p: None)

    def test_foreign_current_directory_not_overwritten(self):
        current = self.install / updater.CURRENT
        current.mkdir(parents=True)
        (current / 'photo.jpg').write_bytes(b'private')
        with self.assertRaises(ValueError):
            self.apply('0.11.0')
        self.assertEqual((current / 'photo.jpg').read_bytes(), b'private')

    def test_symlink_entry_rejected(self):
        package = self.root / 'link.zip'
        with zipfile.ZipFile(package, 'w') as archive:
            info = zipfile.ZipInfo('RelicReconstruction/external')
            info.create_system = 3
            info.external_attr = (0o120777 << 16)
            archive.writestr(info, '../../workspace')
        with self.assertRaisesRegex(ValueError, '链接'):
            updater.install(package, self.install, updater.digest(package), verifier=lambda p: None)

    def test_embedded_workspace_is_preserved_and_update_rejected(self):
        self.apply('0.11.0')
        personal = self.install / updater.CURRENT / 'workspace'
        personal.mkdir()
        (personal / 'photo.jpg').write_bytes(b'private')
        with self.assertRaisesRegex(ValueError, '工作区或模型'):
            self.apply('0.12.0')
        self.assertEqual(self.current(), '0.11.0')
        self.assertEqual((personal / 'photo.jpg').read_bytes(), b'private')

    def test_rollback_recovers_interrupted_promotion(self):
        self.apply('0.11.0')
        os.replace(self.install / updater.CURRENT, self.install / updater.BACKUP)
        updater.rollback(self.install, verifier=lambda p: None)
        self.assertEqual(self.current(), '0.11.0')


if __name__ == '__main__':
    unittest.main(verbosity=2)
