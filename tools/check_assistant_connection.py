"""Offline regressions for key-only DeepSeek presets and provider isolation."""
from __future__ import annotations

import copy
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))


def main():
    with tempfile.TemporaryDirectory(prefix="assistant-connection-", dir=SOURCE) as scratch:
        with patch.dict(os.environ, {"RELIC_DATA_DIR": scratch}):
            import co_design as co
            from fastapi import HTTPException

            initial, active = copy.deepcopy(co._SETTINGS), co._ACTIVE
            fake_key = "fake-key-for-offline-config-only"
            try:
                with patch.object(co, "_request", side_effect=AssertionError("Settings must not call a model")):
                    configured = co.configure({"provider": "deepseek", "apiKey": fake_key})
                    assert configured["ready"] and configured["model"] == "deepseek-flash"
                    assert configured["vision"] and configured["baseUrl"] == "https://api.deepseek.com/v1"
                    assert fake_key not in json.dumps(configured)
                    co.configure({"provider": "local_openai", "model": "custom-local-vision"})
                    configured = co.configure({"provider": "deepseek", "apiKey": fake_key})
                    assert configured["model"] == "deepseek-flash" and not configured["localOnly"]
                    assert co._SETTINGS["local_openai"]["model"] == "custom-local-vision"
                    co.configure({"provider": "deepseek", "baseUrl": "https://custom.example/v1", "model": "old-custom"})
                    configured = co.configure({"provider": "deepseek", "apiKey": fake_key})
                    assert configured["baseUrl"] == co.DEEPSEEK_DEFAULTS["baseUrl"]
                    assert configured["model"] == co.DEEPSEEK_DEFAULTS["model"]
                    configured = co.configure({"provider": "deepseek", "baseUrl": " ", "model": "", "vision": False})
                    assert configured["ready"] and configured["model"] == "deepseek-flash" and not configured["vision"]
                    co.configure({"provider": "openai_compatible", "baseUrl": "https://other.example/v1",
                                  "model": "my-custom-model", "apiKey": "another-fake-only-key"})
                    configured = co.configure({"provider": "deepseek"})
                    assert configured["hasKey"] and co._SETTINGS["deepseek"]["apiKey"] == fake_key
                    before = copy.deepcopy(co._SETTINGS)
                    try:
                        co.configure({"provider": "openai_compatible", "baseUrl": "https://other.example/v1", "model": ""})
                    except HTTPException as exc:
                        assert exc.status_code == 422
                    else:
                        raise AssertionError("Custom providers still require an explicit model")
                    assert co._SETTINGS == before
                    for path in Path(scratch).rglob("*"):
                        if path.is_file():
                            assert fake_key.encode() not in path.read_bytes()
                print(json.dumps({"ok": True, "keyOnlyOfficialPreset": True, "blankFieldsDefault": True,
                                  "providerIsolation": True, "customModelRetained": True,
                                  "realNetworkRequests": 0, "paidRequests": 0, "keysWritten": False}))
            finally:
                co._SETTINGS.clear()
                co._SETTINGS.update(initial)
                co._ACTIVE = active


if __name__ == "__main__":
    main()
