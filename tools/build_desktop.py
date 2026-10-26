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
CODE = ['desktop.py', 'desktop_runtime.py', 'app.py', 'frontend_assets.py', 'runtime_paths.py', 'local_models.py', 'cloud_provider.py',
        'co_design.py', 'brush_workflow.py', 'manual_workflow.py', 'quick_draft.py', 'garment_mapping.py',
        'garment_correspondence.py', 'garment_shape_matching.py', 'surface_workflow.py', 'cloth_surface.py',
        'local_ai_runtime.py', 'local_image_runtime.py']
DOCS = ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'LOCAL_MODELS.md', '开始使用.txt', '.gitignore', '.gitattributes', 'RELEASE_NOTES.md',
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
    for folder, suffixes in [('node_studio', {'.py'}), ('web/node-studio', {'.js', '.mjs', '.wasm', '.task', '.css', '.html', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.json', '.md', '.txt'}), ('docs', {'.md', '.txt'})]:
        for path in (ROOT / folder).rglob('*'):
            if path.is_file() and (path.suffix.lower() in suffixes or path.name in {'LICENSE', 'NOTICE'}) and '__pycache__' not in path.parts:
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
    for relative in ['models/README.md', 'models/manifest.example.json', 'tools/build_desktop.py', 'tools/update_desktop.py', 'tools/check_desktop_lifecycle.py', 'tools/check_desktop_update.py', 'tools/check_desktop_distribution.py', 'tools/create_app_icon.py', 'tools/check_desktop_save.py',
                     'tools/dino_garment_correspondence.py', 'tools/download_correspondence_model.py',
                     'tools/analyze_garment_surface.py', 'tools/download_surface_models.py', 'tools/cloth_surface_algorithm.txt',
                     'tools/face_proximity_worker.py', 'tools/segment_garment.py', 'tools/download_segmentation_model.py',
                     'tools/install_qwen_local.py', 'tools/install_qwen_image_local.py', 'tools/install_browser_vision_assets.py',
                     'tools/start_qwen_local.ps1', 'tools/stop_qwen_local.ps1',
                     'tools/check_node_assistant.py', 'tools/check_garment_tools.py', 'tools/check_node_garments_api.py',
                     'tools/check_editable_blend.py', 'tools/check_node_studio_backend.py', 'tools/check_node_studio_branches.py',
                     'tools/check_node_routes.py', 'tools/check_node_routes.cjs', 'tools/check_node_deletion.py',
                     'tools/check_frontend_assets.py', 'tools/check_assistant_connection.py', 'tools/qa_assistant_connection.cjs',
                     'tools/check_node_text_flow.py', 'tools/qa_node_text_flow.cjs',
                     'tools/qa_global_ai_settings.cjs', 'tools/qa_global_ai_app.cjs',
                     'tools/check_making_kit.py', 'tools/check_making_routes.py', 'tools/qa_making_kit.cjs', 'tools/qa_making_app.cjs',
                     'tools/check_making_shortcut.cjs', 'tools/qa_workbenches_v0116.cjs', 'tools/qa_workbench_layouts.cjs',
                     'tools/check_splatter_coverage.cjs', 'tools/check_splatter_backend.py', 'tools/qa_splatter_renderer.cjs', 'tools/qa_splatter_workbench.cjs',
                     'tools/check_generation_results.py', 'tools/qa_generation_results.cjs', 'tools/check_node_job_tracker.cjs', 'tools/qa_garment_current.cjs',
                     'tools/check_assistant_conversation.py', 'tools/qa_assistant_conversation.py', 'tools/qa_assistant_conversation.cjs',
                     'tools/qa_onboarding_workbench.cjs', 'tools/qa_api_guide.cjs']:
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
                   '--add-data', str(stage / 'tools' / 'segment_garment.py') + os.pathsep + 'tools',
                   '--add-data', str(stage / 'tools' / 'analyze_garment_surface.py') + os.pathsep + 'tools',
                   '--add-data', str(stage / 'tools' / 'dino_garment_correspondence.py') + os.pathsep + 'tools',
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
        for relative in ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'LOCAL_MODELS.md', '开始使用.txt']:
            shutil.copy2(stage / relative, package / relative)
        shutil.copytree(stage / 'models', package / 'model-pack-example')
        updater = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--onefile', '--console',
                   '--name', 'RelicUpdater', '--icon', str(stage / 'web/assets/relic.ico'),
                   '--distpath', str(output / 'updater'), '--workpath', str(output / 'build' / 'updater'),
                   '--specpath', str(output / 'build'), str(stage / 'tools/update_desktop.py')]
        with (output / 'build-updater.log').open('w', encoding='utf-8') as log:
            result = subprocess.run(updater, cwd=stage, env=environment, stdout=log, stderr=subprocess.STDOUT)
        if result.returncode:
            raise SystemExit('Updater build failed; inspect build-updater.log.')
        shutil.copy2(output / 'updater/RelicUpdater.exe', package / 'RelicUpdater.exe')
        from update_desktop import write_manifest
        sys.path.insert(0, str(ROOT))
        from desktop_runtime import APP_VERSION
        write_manifest(package, APP_VERSION)
        archive(package, output / 'RelicReconstruction-Windows-x64.zip', package.name)
    checksums = {file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in output.glob('*.zip')}
    (output / 'SHA256.json').write_text(json.dumps(checksums, indent=2), encoding='utf-8')
    print(json.dumps({'output': str(output), 'archives': list(checksums)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
