"""Build a curated, personal-data-free Windows desktop/source distribution."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CODE = ['desktop.py', 'app.py', 'runtime_paths.py', 'local_models.py', 'cloud_provider.py',
        'co_design.py', 'brush_workflow.py', 'manual_workflow.py', 'quick_draft.py', 'garment_mapping.py',
        'garment_correspondence.py', 'garment_shape_matching.py', 'surface_workflow.py', 'cloth_surface.py']
DOCS = ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'LOCAL_MODELS.md', '.gitignore',
        'requirements.txt', 'requirements-desktop.txt', 'requirements-build.txt',
        'requirements-correspondence.txt', 'requirements-surface.txt',
        'requirements-lock-windows.txt', 'requirements-proximity.txt',
        'start-desktop.cmd', 'install-desktop.cmd']
RESOURCES = ['catalog.json', 'scenarios.json', 'story_sources.json', 'craft_knowledge.json', 'capabilities.json']


def copy_file(relative, stage):
    src, target = ROOT / relative, stage / relative
    if not src.is_file():
        raise FileNotFoundError('Missing release file: ' + relative)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, target)


def prepare(stage):
    for name in CODE + DOCS:
        copy_file(name, stage)
    for path in (ROOT / 'web').iterdir():
        if path.suffix.lower() in {'.js', '.css', '.html'}:
            copy_file(path.relative_to(ROOT).as_posix(), stage)
    # Explicit directories keep modular node code while excluding workspaces and caches.
    for folder, suffixes in [('node_studio', {'.py'}), ('web/node-studio', {'.js', '.css', '.html', '.svg'}), ('docs', {'.md', '.txt'})]:
        for path in (ROOT / folder).rglob('*'):
            if path.is_file() and path.suffix.lower() in suffixes and '__pycache__' not in path.parts:
                copy_file(path.relative_to(ROOT).as_posix(), stage)
    copy_file('web/assets/deepsea-fallback.svg', stage)
    copy_file('web/assets/relic.ico', stage)
    # Keep personal theme art on its owner's computer, not in the public bundle.
    for path in (stage / 'web').iterdir():
        if path.is_file():
            source = path.read_text(encoding='utf-8')
            path.write_text(source.replace('deepsea-clean.png', 'deepsea-fallback.svg').replace('deepsea-reference.jpg', 'deepsea-fallback.svg'), encoding='utf-8')
    for name in RESOURCES:
        copy_file('resources/' + name, stage)
    copy_file('resources/garments/demo_coat_front.png', stage)
    # A personal E-drive path is never an installed model on another computer.
    (stage / 'resources/models.json').write_text('{"models": []}\n', encoding='utf-8')
    for relative in ['models/README.md', 'models/manifest.example.json', 'tools/build_desktop.py', 'tools/check_desktop_distribution.py', 'tools/create_app_icon.py', 'tools/check_desktop_save.py',
                     'tools/dino_garment_correspondence.py', 'tools/download_correspondence_model.py',
                     'tools/analyze_garment_surface.py', 'tools/download_surface_models.py', 'tools/cloth_surface_algorithm.txt',
                     'tools/face_proximity_worker.py']:
        copy_file(relative, stage)


def collect_licenses(folder):
    folder.mkdir(parents=True, exist_ok=True)
    for distribution in importlib.metadata.distributions():
        name = distribution.metadata.get('Name', 'package')
        for file in distribution.files or []:
            text = str(file).replace('\\', '/')
            if '.dist-info/' not in text:
                continue
            leaf = Path(text).name.lower()
            if not (leaf.startswith(('license', 'copying', 'notice')) or '/licenses/' in text):
                continue
            original = Path(distribution.locate_file(file))
            if original.is_file():
                target = folder / name / text.split('.dist-info/', 1)[1]
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(original, target)
    for file in Path(sys.base_prefix).glob('LICENSE*'):
        if file.is_file():
            shutil.copy2(file, folder / ('Python-' + file.name))


def archive(folder, destination, prefix):
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as package:
        for path in sorted(folder.rglob('*')):
            if path.is_file() and '__pycache__' not in path.parts:
                package.write(path, prefix + '/' + path.relative_to(folder).as_posix())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=ROOT / 'release')
    parser.add_argument('--source-only', action='store_true')
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()):
        raise SystemExit('Choose a new empty output folder. Existing releases are never deleted.')
    output.mkdir(parents=True, exist_ok=True)
    stage = output / 'RelicReconstruction-source'
    stage.mkdir()
    prepare(stage)
    archive(stage, output / 'RelicReconstruction-source.zip', stage.name)
    if not args.source_only:
        licenses = output / 'build' / 'licenses'
        collect_licenses(licenses)
        environment = os.environ.copy()
        environment['PYTHONUTF8'] = '1'
        environment['PYINSTALLER_CONFIG_DIR'] = str(output / 'build' / 'cache')
        command = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--onedir', '--windowed',
                   '--name', 'RelicReconstruction', '--icon', str(stage / 'web/assets/relic.ico'),
                   '--distpath', str(output / 'windows'), '--workpath', str(output / 'build' / 'work'),
                   '--specpath', str(output / 'build'),
                   '--add-data', str(stage / 'web') + os.pathsep + 'web',
                   '--add-data', str(stage / 'resources') + os.pathsep + 'resources',
                   '--add-data', str(stage / 'tools' / 'face_proximity_worker.py') + os.pathsep + 'tools',
                   '--add-data', str(licenses) + os.pathsep + 'third-party-licenses',
                   '--collect-data', 'webview', '--collect-all', 'pythonnet', '--collect-all', 'clr_loader',
                   '--hidden-import', 'webview.platforms.edgechromium', '--hidden-import', 'webview.platforms.winforms',
                   '--hidden-import', 'uvicorn.logging', '--hidden-import', 'uvicorn.loops.asyncio',
                   '--hidden-import', 'uvicorn.protocols.http.h11_impl', '--hidden-import', 'uvicorn.lifespan.on',
                   str(stage / 'desktop.py')]
        with (output / 'build.log').open('w', encoding='utf-8') as log:
            result = subprocess.run(command, cwd=stage, env=environment, stdout=log, stderr=subprocess.STDOUT)
        if result.returncode:
            raise SystemExit('Build failed; inspect build.log.')
        package = output / 'windows' / 'RelicReconstruction'
        for relative in ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'LOCAL_MODELS.md']:
            shutil.copy2(stage / relative, package / relative)
        shutil.copytree(stage / 'models', package / 'model-pack-example')
        archive(package, output / 'RelicReconstruction-Windows-x64.zip', package.name)
    checksums = {file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in output.glob('*.zip')}
    (output / 'SHA256.json').write_text(json.dumps(checksums, indent=2), encoding='utf-8')
    print(json.dumps({'output': str(output), 'archives': list(checksums)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
