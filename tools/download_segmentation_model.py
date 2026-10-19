"""Download the explicitly requested, public SAM 2.1 Tiny weights only.

No inference inputs or credentials leave this computer. Files are pinned to the
resolved official revision and verified against the Hub's LFS SHA256 when set.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

REPO = 'facebook/sam2.1-hiera-tiny'
FILES = ('config.json', 'preprocessor_config.json', 'processor_config.json',
         'model.safetensors', 'README.md', 'LICENSE')


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def download(destination):
    destination = Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(f'https://huggingface.co/api/models/{REPO}?blobs=true', timeout=45) as response:
        metadata = json.load(response)
    revision = metadata['sha']
    available = {v['rfilename']: v for v in metadata['siblings']}
    files = []
    for name in FILES:
        if name not in available:
            continue
        target = destination / name
        expected = (available[name].get('lfs') or {}).get('sha256')
        url = f'https://huggingface.co/{REPO}/resolve/{revision}/{name}'
        if not target.is_file() or expected and digest(target) != expected:
            partial = target.with_name(target.name + '.part')
            print('download ' + name, flush=True)
            with urllib.request.urlopen(url, timeout=120) as response, partial.open('wb') as handle:
                for block in iter(lambda: response.read(4 * 1024 * 1024), b''):
                    handle.write(block)
            if expected and digest(partial) != expected:
                raise RuntimeError('Downloaded checkpoint checksum mismatch: ' + name)
            partial.replace(target)
        files.append({'file': name, 'bytes': target.stat().st_size, 'sha256': digest(target), 'url': url})
    required = ('config.json', 'preprocessor_config.json', 'model.safetensors')
    if not all((destination / name).is_file() for name in required):
        raise RuntimeError('Official model assets are incomplete')
    receipt = {'model': REPO, 'revision': revision, 'status': 'downloaded', 'license': 'Apache-2.0',
               'files': files, 'imageUploaded': False, 'trainingPerformed': False}
    (destination / 'download-manifest.json').write_text(json.dumps(receipt, indent=2), encoding='utf8')
    print(json.dumps({'model': REPO, 'revision': revision, 'bytes': sum(v['bytes'] for v in files)}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-dir', type=Path, default=Path(__file__).resolve().parents[1] / 'models/sam2.1-hiera-tiny')
    download(parser.parse_args().model_dir)
