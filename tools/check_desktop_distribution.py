"""Check curated desktop/source releases without executing them or exposing secrets.

This is a static release check, not proof of runtime behavior or a comprehensive
secret audit. It never reads environment values, uses the network, extracts ZIPs,
or imports the application. Only paths and finding categories are reported.
"""
from __future__ import annotations

import argparse
import json
import re
import stat
import tempfile
import zipfile
from collections import Counter
from pathlib import Path, PurePosixPath


MODEL_SUFFIXES = {'.safetensors', '.ckpt', '.pt', '.pth', '.gguf', '.onnx', '.h5', '.hdf5'}
FORBIDDEN_DIRS = {'.git', '.venv', 'venv', '.desktop-build', 'node_modules', '__pycache__',
                  'workspace', 'workspaces', 'user-data', 'browser-profile'}
SOURCE_ONLY_DIRS = {'build', 'dist', '.pytest_cache', '.mypy_cache', '.ruff_cache'}
DATA_DIRS = {'data', 'uploads', 'projects', 'jobs'}
TEXT_SUFFIXES = {'.py', '.js', '.mjs', '.cjs', '.json', '.txt', '.md', '.html', '.css',
                 '.yml', '.yaml', '.toml', '.ini', '.cfg', '.bat', '.cmd', '.ps1', '.spec', '.xml', '.pem'}
MAX_TEXT_BYTES = 16 * 1024 * 1024
CORE_SOURCE = ['desktop.py', 'desktop_runtime.py', 'app.py', 'frontend_assets.py', 'cloud_provider.py', 'co_design.py',
               'manual_workflow.py', 'brush_workflow.py', 'quick_draft.py', 'runtime_paths.py',
               'local_models.py', 'README.md', 'node_studio/__init__.py', 'node_studio/catalog.py',
               'node_studio/store.py', 'node_studio/routes.py', 'node_studio/adapters.py',
               'node_studio/generation.py', 'node_studio/fabrication.py', 'node_studio/proximity.py',
               'node_studio/character_research.py', 'node_studio/assistant_engine.py', 'node_studio/text_inputs.py',
               'node_studio/garment_tools.py', 'node_studio/garment_jobs.py', 'node_studio/blend_tools.py',
               'local_ai_runtime.py', 'local_image_runtime.py',
               'tools/update_desktop.py', 'docs/V011.md', 'node_studio/deletion.py']
WEB_FILES = ['web/index.html', 'web/app.js', 'web/style.css', 'web/co-design.js',
             'web/co-design.css', 'web/brush-engine.js', 'web/brush-workbench.js',
             'web/node-studio/index.html', 'web/node-studio/app.js',
             'web/node-studio/core/model.js', 'web/node-studio/core/graph.js', 'web/node-studio/core/job-tracker.js',
             'web/node-studio/workspaces/index.js', 'web/node-studio/adapters/legacy-bridge.js',
             'web/node-studio/core/text-input.js', 'web/node-studio/workspaces/generation-brief.js',
             'web/node-studio/components/global-ai-settings.js', 'web/node-studio/styles/global-ai-settings.css',
             'web/node-studio/workspaces/image-connection.js', 'web/node-studio/workspaces/assistant-configuration.js',
             'web/node-studio/workspaces/image-configuration.js', 'web/node-studio/core/ai-settings-events.js',
             'web/node-studio/workspaces/magnifier.js', 'web/node-studio/adapters/proximity-sensor.js',
             'web/node-studio/workspaces/character-research.js', 'web/node-studio/workspaces/magnifier.css',
             'tools/face_proximity_worker.py', 'tools/segment_garment.py',
             'web/node-studio/workspaces/battle-3d.js', 'web/node-studio/workspaces/gesture-camera.js',
             'web/node-studio/workspaces/garments.js', 'web/node-studio/styles/v010-workspaces.css',
             'web/node-studio/styles/v011-canvas.css',
             'web/node-studio/vendor/three/build/three.module.js',
             'web/node-studio/vendor/mediapipe/vision_bundle.mjs',
             'web/node-studio/vendor/mediapipe/wasm/vision_wasm_internal.wasm',
             'web/node-studio/vendor/mediapipe/models/hand_landmarker.task']
RESOURCE_FILES = ['resources/catalog.json', 'resources/scenarios.json',
                  'resources/models.json', 'resources/capabilities.json',
                  'resources/craft_knowledge.json', 'resources/story_sources.json']

# Match only recognizable literal credentials; never include match contents in output.
TOKEN_RE = re.compile(r'(?<![\w-])(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|'
                      r'gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,}|'
                      r'AKIA[0-9A-Z]{16})(?![\w-])')
ASSIGNMENT_RE = re.compile(
    r'''(?ix)["']?(?:api[_-]?key|access[_-]?token|client[_-]?secret|secret[_-]?key)["']?
        \s*[:=]\s*["']([^"'\r\n]{16,1024})["']''')
PRIVATE_KEY_RE = re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----')


def finding(report, category, path, detail):
    report['findings'].append({'category': category, 'path': str(path), 'detail': detail})


def suspicious_literal(value):
    """Avoid treating explicit example/test placeholders as real credentials."""
    lowered = value.lower()
    if any(word in lowered for word in ('placeholder', 'example', 'dummy', 'fake',
                                        'mock', 'your-key', 'your_api', 'test-key', 'test_secret')):
        return False
    if value.startswith(('$', '{', '<')) or ' ' in value or '\\' in value:
        return False
    return len(set(value)) >= 8 and bool(re.search(r'[A-Za-z]', value)) and bool(re.search(r'[0-9]', value))


def inspect_text(report, path, raw):
    report['scannedTextFiles'] += 1
    content = raw.decode('utf-8-sig', errors='replace')
    categories = set()
    if PRIVATE_KEY_RE.search(content):
        categories.add('private_key_literal')
    if any(suspicious_literal(match.group(0)) for match in TOKEN_RE.finditer(content)):
        categories.add('recognizable_token_literal')
    if any(suspicious_literal(match.group(1)) for match in ASSIGNMENT_RE.finditer(content)):
        categories.add('credential_assignment_literal')
    for category in sorted(categories):
        finding(report, category, path, 'Potential credential detected; value redacted. Review or remove before release.')


def path_reasons(path, source):
    pure = PurePosixPath(str(path).replace('\\', '/'))
    parts = [part.lower() for part in pure.parts]
    name = pure.name.lower()
    suffix = pure.suffix.lower()
    reasons = []
    app_parts = parts[1:] if parts and parts[0] == '_internal' else parts
    # This exact directory contains application renderers, not user workspaces.
    # A nested workspace or any other workspace path remains forbidden.
    forbidden_parts = [part for index, part in enumerate(app_parts)
                       if not (part == 'workspaces' and index == 2
                               and app_parts[:2] == ['web', 'node-studio'])]
    if any(part in FORBIDDEN_DIRS for part in forbidden_parts):
        reasons.append(('development_or_user_directory', 'Development environment or user workspace must not be distributed.'))
    source_parts = [part for index, part in enumerate(parts)
                    if not (part == 'build' and index == 4 and parts[:4] == ['web', 'node-studio', 'vendor', 'three'])]
    if source and any(part in SOURCE_ONLY_DIRS for part in source_parts):
        reasons.append(('build_artifact_in_source', 'Curated source ZIP must not include build output or caches.'))
    # Only app-level data paths; third-party library resource folders may be named data.
    if app_parts and app_parts[0] in DATA_DIRS:
        reasons.append(('personal_application_data', 'Uploads, projects, jobs and runtime records belong outside a clean release.'))
    if source and any(part in DATA_DIRS for part in parts):
        reasons.append(('personal_application_data', 'Source ZIP must not include application/user data.'))
    if suffix in MODEL_SUFFIXES or (suffix == '.bin' and any(part in {'models', 'checkpoints', 'loras'} for part in parts)):
        reasons.append(('model_weight', 'Model weights must be external downloads, not bundled in this release.'))
    if name.startswith('.env') and name not in {'.env.example', '.env.template', '.env.sample'}:
        reasons.append(('environment_secret_file', 'Only an explicitly empty example/template environment file may be published.'))
    public_ca = not source and name == 'cacert.pem' and 'certifi' in parts
    if (suffix in {'.pem', '.key', '.pfx', '.p12'} and not public_ca) or name in {'credentials.json', 'secrets.json', 'id_rsa', 'id_ed25519'}:
        reasons.append(('credential_file', 'Potential credential/private-key file must not be distributed.'))
    if suffix in {'.log', '.pid'} or (source and suffix in {'.pyc', '.pyo'}) or name == 'launch.json':
        reasons.append(('runtime_or_cache_file', 'Logs, process records and compiled caches are not source files.'))
    return list(dict.fromkeys(reasons))


def add_requirements(report, names, required, prefix=''):
    present = {name.lower() for name in names}
    for item in required:
        candidates = [prefix + item] if prefix else [item, '_internal/' + item]
        if not any(candidate.lower() in present for candidate in candidates):
            finding(report, 'required_file_missing', item, 'Required release file is absent.')


def new_report(kind, path):
    return {'kind': kind, 'path': str(path), 'passed': False, 'fileCount': 0,
            'totalBytes': 0, 'scannedTextFiles': 0, 'findings': [], 'warnings': [],
            'scope': 'Static names/assets and heuristic plaintext secret checks only; no application execution or network.'}


def check_dist(path, entry_exe='RelicReconstruction.exe', required=()):
    root = Path(path).resolve()
    report = new_report('windows_onedir', root)
    if not root.is_dir():
        finding(report, 'distribution_missing', root, 'Distribution directory does not exist.')
        return report
    names = []
    for item in root.rglob('*'):
        relative = item.relative_to(root).as_posix()
        if item.is_symlink():
            finding(report, 'link_not_allowed', relative, 'Release should contain regular files, not external links.')
            continue
        if not item.is_file():
            continue
        names.append(relative)
        size = item.stat().st_size
        report['fileCount'] += 1
        report['totalBytes'] += size
        reasons = path_reasons(relative, False)
        for category, detail in reasons:
            finding(report, category, relative, detail)
        if reasons:
            continue  # Do not read detected personal data or key files.
        if item.suffix.lower() in TEXT_SUFFIXES:
            if size <= MAX_TEXT_BYTES:
                inspect_text(report, relative, item.read_bytes())
            else:
                finding(report, 'unscanned_large_text', relative, 'Text file exceeds bounded secret scan size; review before release.')
    add_requirements(report, names, WEB_FILES + RESOURCE_FILES + list(required))
    executable = root / entry_exe
    if not executable.is_file():
        finding(report, 'entry_executable_missing', entry_exe, 'Windows entry executable is absent.')
    else:
        with executable.open('rb') as handle:
            if handle.read(2) != b'MZ':
                finding(report, 'entry_not_pe', entry_exe, 'Entry is not a recognizable Windows executable.')
    for dll in ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll']:
        if not any(PurePosixPath(name).name.lower() == dll.lower() for name in names):
            finding(report, 'webview_dll_missing', dll, 'Required EdgeChromium support DLL is absent.')
    if not any(re.fullmatch(r'python\d{2,3}\.dll', PurePosixPath(name).name, re.I) for name in names):
        finding(report, 'python_runtime_missing', '.', 'Bundled Python DLL is absent.')
    report['warnings'].append('External WebView2 Runtime is not bundled; startup must detect it and direct missing-runtime users to Microsoft.')
    report['warnings'].append('Compiled code and third-party binary contents are not decompiled or scanned; this check is not a guarantee that every secret is absent.')
    report['passed'] = not report['findings']
    return report


def zip_name_safe(name):
    normalized = name.replace('\\', '/')
    pure = PurePosixPath(normalized)
    return not ('\x00' in normalized or normalized.startswith('/') or
                re.match(r'^[A-Za-z]:', normalized) or '..' in pure.parts)


def check_source_zip(path, source_entry='desktop.py', prefix='RelicReconstruction-source/', required=()):
    archive = Path(path).resolve()
    report = new_report('curated_source_zip', archive)
    if not archive.is_file():
        finding(report, 'source_zip_missing', archive, 'Source ZIP does not exist.')
        return report
    try:
        with zipfile.ZipFile(archive) as handle:
            infos = handle.infolist()
            files = [info for info in infos if not info.is_dir()]
            counts = Counter(info.filename.replace('\\', '/').lower() for info in files)
            for name, count in counts.items():
                if count > 1:
                    finding(report, 'duplicate_zip_path', name, 'Case-insensitive duplicate path is unsafe on Windows.')
            names = []
            for info in files:
                name = info.filename.replace('\\', '/')
                if not zip_name_safe(name):
                    finding(report, 'unsafe_zip_path', '(unsafe archive member)', 'Absolute or traversing archive path is rejected.')
                    continue
                if prefix and not name.startswith(prefix):
                    finding(report, 'unexpected_source_prefix', name, 'Source files must be within the documented top-level directory.')
                    continue
                relative = name[len(prefix):] if prefix else name
                names.append(relative)
                report['fileCount'] += 1
                report['totalBytes'] += info.file_size
                reasons = path_reasons(relative, True)
                for category, detail in reasons:
                    finding(report, category, relative, detail)
                if stat.S_ISLNK(info.external_attr >> 16):
                    finding(report, 'link_not_allowed', relative, 'Source ZIP must not contain symbolic links.')
                    continue
                if info.flag_bits & 1:
                    finding(report, 'encrypted_zip_member', relative, 'Encrypted members cannot be inspected in a public source release.')
                    continue
                if reasons:
                    continue  # Never read personal data or a detected key file.
                if PurePosixPath(relative).suffix.lower() in TEXT_SUFFIXES:
                    if info.file_size > MAX_TEXT_BYTES:
                        finding(report, 'unscanned_large_text', relative, 'Text file exceeds bounded secret scan size.')
                    else:
                        inspect_text(report, relative, handle.read(info))
            modules = [item for item in CORE_SOURCE if item != 'desktop.py'] + [source_entry]
            add_requirements(report, names, modules + WEB_FILES + RESOURCE_FILES + list(required))
            if not any(PurePosixPath(name).name.startswith('requirements') and name.endswith('.txt') for name in names):
                finding(report, 'requirements_missing', '.', 'Source release needs an explicit dependency file.')
            if not any(PurePosixPath(name).name.lower().startswith(('license', 'third_party')) for name in names):
                finding(report, 'license_scope_missing', '.', 'Source release needs a license or explicit rights/scope notice.')
    except (zipfile.BadZipFile, OSError, RuntimeError):
        finding(report, 'source_zip_unreadable', archive.name, 'Cannot inspect this ZIP; no exception body or member contents are exposed.')
    report['warnings'].append('Heuristic scanning cannot prove the absence of every credential; source must be curated before this check.')
    report['passed'] = not report['findings']
    return report


def self_test(temp_root=None):
    """Create synthetic releases only; never inspect user data or environment keys."""
    assert not path_reasons('web/node-studio/workspaces/index.js', True)
    assert not path_reasons('_internal/web/node-studio/workspaces/index.js', False)
    assert path_reasons('web/node-studio/workspaces/workspace/private.png', True)
    assert path_reasons('workspaces/private.png', True)
    if temp_root is not None:
        temp_root = Path(temp_root).resolve()
        temp_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='relic-distribution-check-', dir=temp_root) as temporary:
        root = Path(temporary)
        dist = root / 'release'
        dist.mkdir()
        (dist / 'RelicReconstruction.exe').write_bytes(b'MZ' + b'\0' * 64)
        for name in WEB_FILES + RESOURCE_FILES:
            target = dist / '_internal' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('{}' if name.endswith('.json') else '/* example */', encoding='utf-8')
        for name in ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll', 'python310.dll']:
            (dist / '_internal' / name).write_bytes(b'MZ')
        assert check_dist(dist)['passed']
        private = dist / 'data' / 'uploads' / 'photo.png'
        private.parent.mkdir(parents=True)
        private.write_bytes(b'not a real image')
        assert any(row['category'] == 'personal_application_data' for row in check_dist(dist)['findings'])
        archive = root / 'source.zip'
        def source_zip(extra=()):
            with zipfile.ZipFile(archive, 'w') as handle:
                for name in CORE_SOURCE + WEB_FILES + RESOURCE_FILES + ['requirements-desktop.txt', 'LICENSE.md']:
                    handle.writestr('RelicReconstruction-source/' + name, '# placeholder')
                for name, content in extra:
                    handle.writestr('RelicReconstruction-source/' + name, content)
        source_zip()
        assert check_source_zip(archive)['passed']
        source_zip([('data/jobs/result.png', b'not a real image'), ('models/private.safetensors', b'not weights')])
        report = check_source_zip(archive)
        assert {'personal_application_data', 'model_weight'} <= {row['category'] for row in report['findings']}
        sentinel = 'sk-' + 'X9y4Z2a7B3c8D1e6F0g5H2j9K4m7N1p6'
        source_zip([('bad-config.py', 'api_key="' + sentinel + '"')])
        report = check_source_zip(archive)
        assert any('literal' in row['category'] for row in report['findings'])
        assert sentinel not in json.dumps(report)
        source_zip([('../outside.py', '# example')])
        assert any(row['category'] == 'unsafe_zip_path' for row in check_source_zip(archive)['findings'])
        print(json.dumps({'passed': True, 'checks': ['clean onedir', 'personal data exclusion', 'clean source ZIP',
              'model weight exclusion', 'secret findings redacted', 'ZIP traversal exclusion'], 'networkCalls': 0}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dist-dir', type=Path)
    parser.add_argument('--source-zip', type=Path)
    parser.add_argument('--entry-exe', default='RelicReconstruction.exe')
    parser.add_argument('--source-entry', default='desktop.py')
    parser.add_argument('--source-prefix', default='RelicReconstruction-source/')
    parser.add_argument('--dist-required', action='append', default=[])
    parser.add_argument('--source-required', action='append', default=[])
    parser.add_argument('--report', type=Path)
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('--self-test-root', type=Path, help='Optional writable parent for synthetic test fixtures.')
    arguments = parser.parse_args()
    if arguments.self_test:
        self_test(arguments.self_test_root)
        return 0
    if not arguments.dist_dir and not arguments.source_zip:
        parser.error('Supply --dist-dir and/or --source-zip, or --self-test.')
    reports = []
    if arguments.dist_dir:
        reports.append(check_dist(arguments.dist_dir, arguments.entry_exe, arguments.dist_required))
    if arguments.source_zip:
        reports.append(check_source_zip(arguments.source_zip, arguments.source_entry,
                                        arguments.source_prefix, arguments.source_required))
    output = {'passed': all(report['passed'] for report in reports), 'networkCalls': 0, 'reports': reports}
    rendered = json.dumps(output, ensure_ascii=False, indent=2)
    if arguments.report:
        arguments.report.parent.mkdir(parents=True, exist_ok=True)
        arguments.report.write_text(rendered + '\n', encoding='utf-8')
    print(rendered)
    return 0 if output['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
