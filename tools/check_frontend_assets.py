"""Check versioned assets, embedded legacy UI and cache-invalidation behavior."""
from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from fastapi import FastAPI
from fastapi.responses import HTMLResponse, Response
from fastapi.testclient import TestClient
import uvicorn
from frontend_assets import FrontendAssets


class FrontendTests(unittest.TestCase):
    def setUp(self):
        parent = ROOT / "work" / "frontend-checks"
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="cache-", dir=parent)
        self.root = Path(self.temp.name)
        self.write("node-studio/index.html",
                   '<html><head><link rel="stylesheet" href="/web/node-studio/main.css"></head>'
                   '<body><a href="/legacy#studio">Legacy</a><a href="/">Home</a>'
                   '<img src="/resources/demo.png"><script type="module" src="/web/node-studio/main.js">'
                   '</script></body></html>')
        self.write("node-studio/main.js", "import './nested.js';window.build='new';")
        self.write("node-studio/nested.js", "window.nested='new';")
        self.write("node-studio/main.css", "body{color:rgb(1,2,3);background:url('/web/node-studio/bg.svg')}")
        self.write("node-studio/bg.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>')
        self.write("index.html", '<html><head><link rel="stylesheet" href="/old.css"></head>'
                   '<body><script src="/old.js"></script><div id="legacy">new legacy</div></body></html>')
        self.write("old.js", "window.legacyBuild='new';")
        self.write("old.css", "body{color:rgb(4,5,6)}")
        self.assets = FrontendAssets(self.root)

    def tearDown(self):
        assert self.root.resolve().is_relative_to((ROOT / "work" / "frontend-checks").resolve())
        self.temp.cleanup()

    def write(self, relative, text):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def app(self):
        app = FastAPI()
        app.mount(self.assets.mount_path, self.assets.static)
        return app

    def test_contents_not_timestamps_control_build(self):
        old = self.assets.fingerprint
        path = self.root / "old.js"
        before = path.stat()
        self.write("old.js", "window.legacyBuild='NEW';")
        os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
        self.assertNotEqual(old, FrontendAssets(self.root).fingerprint)

    def test_all_entry_dependencies_and_nested_modules_share_namespace(self):
        prefix = self.assets.mount_path
        client = TestClient(self.app())
        entry = client.get(prefix + "/node-studio/index.html")
        self.assertEqual(entry.status_code, 200)
        self.assertIn(prefix + "/node-studio/main.js", entry.text)
        self.assertIn(prefix + "/index.html#studio", entry.text)
        self.assertIn(prefix + "/node-studio/index.html", entry.text)
        self.assertIn('src="/resources/demo.png"', entry.text)
        self.assertIn("relic-ui-build", entry.text)
        script = client.get(prefix + "/node-studio/main.js")
        self.assertIn("import './nested.js'", script.text)
        css = client.get(prefix + "/node-studio/main.css")
        self.assertIn(prefix + "/node-studio/bg.svg", css.text)
        legacy = client.get(prefix + "/index.html")
        self.assertIn(prefix + "/old.js", legacy.text)
        self.assertIn(prefix + "/old.css", legacy.text)
        for response in (entry, script, css, legacy):
            self.assertIn("no-store", response.headers["cache-control"])
            self.assertEqual(response.headers["x-relic-ui-build"], self.assets.fingerprint)
        # Even a browser with stale validators gets the new body, never a 304.
        validated = client.get(prefix + "/node-studio/main.js",
                               headers={"If-None-Match": "*", "If-Modified-Since": "Wed, 21 Oct 2099 07:28:00 GMT"})
        self.assertEqual(validated.status_code, 200)
        self.assertIn("window.build='new'", validated.text)

    def test_dynamic_legacy_and_stylesheet_urls_are_versioned(self):
        code = "iframe.src='/legacy?'+query+'#studio';sheet.href='/web/node-studio/main.css';fetch('/api/test');"
        changed = self.assets.transform(code, "node-studio/bridge.js")
        self.assertIn(self.assets.mount_path + "/index.html?", changed)
        self.assertIn(self.assets.mount_path + "/node-studio/main.css", changed)
        self.assertIn("fetch('/api/test')", changed)
        self.assertEqual(self.assets._url("https://example.test/file.js"), "https://example.test/file.js")
        self.assertEqual(self.assets._url("/data/photo.png"), "/data/photo.png")
        self.assertEqual(self.assets._url("/web/../../../private.txt"), "/web/../../../private.txt")

    def test_same_origin_browser_with_old_cached_ui(self):
        node = os.environ.get("RELIC_QA_NODE", r"C:\Program Files\nodejs\node.exe")
        playwright = os.environ.get("RELIC_QA_PLAYWRIGHT", r"C:\Users\lenovo\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright-core")
        chrome = os.environ.get("RELIC_QA_CHROME", r"C:\Program Files\Google\Chrome\Application\chrome.exe")
        if not all(Path(path).exists() for path in (node, playwright, chrome)):
            self.skipTest("Set RELIC_QA_NODE, RELIC_QA_PLAYWRIGHT and RELIC_QA_CHROME")
        app = FastAPI()
        changed = {"ready": False}

        @app.get("/")
        def index():
            if changed["ready"]:
                return self.assets.entry_html()
            return HTMLResponse('<html><head><link rel="stylesheet" href="/web/node-studio/main.css"></head>'
                                '<body><script type="module" src="/web/node-studio/main.js"></script></body></html>',
                                headers={"Cache-Control": "public, max-age=86400"})

        @app.post("/switch")
        def switch():
            changed["ready"] = True
            return {"ok": True}

        @app.get("/web/node-studio/main.js")
        def old_script():
            return Response("import './nested.js';window.build='old';", media_type="text/javascript",
                            headers={"Cache-Control": "public, max-age=86400"})

        @app.get("/web/node-studio/nested.js")
        def old_nested():
            return Response("window.nested='old';", media_type="text/javascript",
                            headers={"Cache-Control": "public, max-age=86400"})

        @app.get("/web/node-studio/main.css")
        def old_css():
            return Response("body{color:rgb(200,0,0)}", media_type="text/css",
                            headers={"Cache-Control": "public, max-age=86400"})

        app.mount(self.assets.mount_path, self.assets.static)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()
        for _ in range(100):
            if server.started:
                break
            time.sleep(.05)
        script = self.root / "browser.cjs"
        script.write_text("""
const assert=require('node:assert/strict');
const {chromium}=require(process.argv[2]);
(async()=>{
 const browser=await chromium.launch({executablePath:process.argv[3],headless:true});
 try {
  const context=await browser.newContext();
  const page=await context.newPage();
  const base=process.argv[4],prefix=process.argv[5];
  await page.goto(base);await page.waitForFunction(()=>window.build==='old'&&window.nested==='old');
  await page.evaluate(()=>localStorage.setItem('saved-creation','retained'));
  await page.request.post(base+'/switch');
  await page.goto(base+'/?build='+prefix.split('/').pop());
  await page.waitForFunction(()=>window.build==='new'&&window.nested==='new');
  assert.equal(await page.evaluate(()=>localStorage.getItem('saved-creation')),'retained');
  assert.equal(await page.evaluate(()=>getComputedStyle(document.body).color),'rgb(1, 2, 3)');
  assert.ok(await page.locator('script[type=module]').getAttribute('src').then(p=>p.startsWith(prefix)));
  await page.locator('a').filter({hasText:'Legacy'}).click();
  await page.waitForFunction(()=>window.legacyBuild==='new');
  assert.equal(await page.evaluate(()=>getComputedStyle(document.body).color),'rgb(4, 5, 6)');
  assert.equal(await page.evaluate(()=>localStorage.getItem('saved-creation')),'retained');
  console.log(JSON.stringify({warmCacheUpgrade:true,nestedModules:true,legacy:true,localStorageRetained:true}));
 } finally {await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
""", encoding="utf-8")
        try:
            result = subprocess.run([node, str(script), playwright, chrome, f"http://127.0.0.1:{port}",
                                     self.assets.mount_path], capture_output=True, text=True, timeout=40)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue(json.loads(result.stdout)["warmCacheUpgrade"])
        finally:
            server.should_exit = True
            thread.join(5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
