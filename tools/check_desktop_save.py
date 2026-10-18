"""Check native export byte handling; dialog selection is mocked, not UI-tested."""
import base64
import io
import sys
import tempfile
import zipfile
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from desktop import DesktopBridge
from PIL import Image

with tempfile.TemporaryDirectory(dir=Path.cwd()) as scratch:
    root = Path(scratch)
    bridge = DesktopBridge(root)
    png = io.BytesIO()
    Image.new('RGB', (2, 2), '#315d64').save(png, 'PNG')
    zipped = io.BytesIO()
    with zipfile.ZipFile(zipped, 'w') as output:
        output.writestr('test.txt', 'fixture only')
    fixtures = {'test.png': png.getvalue(), 'test.json': b'{"test":true}',
                'test.zip': zipped.getvalue(), 'test.html': b'<!doctype html><title>test</title>'}
    for name, value in fixtures.items():
        bridge._window = SimpleNamespace(native=SimpleNamespace(InvokeRequired=False),
                                        create_file_dialog=lambda *a, **kw: (str(root / kw['save_filename']),))
        result = bridge.save_export(name, base64.b64encode(value).decode())
        assert result['ok'] and (root / name).read_bytes() == value
    assert not bridge.save_export('../test.html', 'YQ==')['ok']
    assert not bridge.save_export('test.exe', 'YQ==')['ok']
    assert not bridge.save_export('test.png', 'invalid-b64-')['ok']
    bridge._window.create_file_dialog = lambda *a, **kw: None
    assert bridge.save_export('cancel.json', 'e30=')['cancelled']
    assert not (root / 'cancel.json').exists()
print('8 export checks passed; chooser is mocked; no real model requests.')
