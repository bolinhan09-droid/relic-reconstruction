"""Download a pinned, public DINOv2 safetensors model; never upload images."""
from pathlib import Path
import hashlib
import json
import requests

ROOT = Path(__file__).resolve().parents[1]
REPO = 'facebook/dinov2-small'
REVISION = 'ed25f3a31f01632728cabb09d1542f84ab7b0056'


def main():
    target = ROOT / 'models/dinov2-small'
    target.mkdir(parents=True, exist_ok=True)
    response = requests.get(f'https://huggingface.co/api/models/{REPO}/revision/{REVISION}?blobs=true', timeout=60)
    response.raise_for_status()
    metadata = response.json()
    files = {row['rfilename']: row for row in metadata['siblings']}
    rows = []
    for name in ('config.json', 'preprocessor_config.json', 'model.safetensors', 'README.md'):
        path = target / name
        row = files[name]
        expected = row.get('lfs', {}).get('sha256')
        if not path.is_file() or (expected and hashlib.sha256(path.read_bytes()).hexdigest() != expected):
            temporary = path.with_suffix(path.suffix + '.part')
            with requests.get(f'https://huggingface.co/{REPO}/resolve/{REVISION}/{name}', stream=True, timeout=120) as stream:
                stream.raise_for_status()
                with temporary.open('wb') as output:
                    for block in stream.iter_content(1024 * 1024):
                        output.write(block)
            actual = hashlib.sha256(temporary.read_bytes()).hexdigest()
            if expected and actual != expected:
                raise ValueError('Official LFS SHA256 did not match: ' + name)
            temporary.replace(path)
        rows.append({'name': name, 'bytes': path.stat().st_size,
                     'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                     'officialLfsSha256': expected})
        print('Verified ' + name, flush=True)
    manifest = {'repository': REPO, 'revision': REVISION, 'license': 'Apache-2.0',
                'imageUploaded': False, 'files': rows}
    (target / 'download-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
