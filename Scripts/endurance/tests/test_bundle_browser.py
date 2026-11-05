"""Opt-in Chromium ZIP/offline/rotation checks against recorded native data.

ENDURANCE_BUNDLE_SOURCE=<bundle directory>, ENDURANCE_BUNDLE_DEV_URL=<Vite endurance dev URL>,
ENDURANCE_BUNDLE_OUTPUT=<new directory>. Install psutil for process memory sampling.
"""
import asyncio
import json
import os
import time
import unittest
import zipfile
from html.parser import HTMLParser
from urllib.parse import unquote, urlparse
from pathlib import Path
from bundle import bundle_files


@unittest.skipUnless(os.environ.get("ENDURANCE_BUNDLE_SOURCE"), "bundle browser checks are opt-in")
class BundleBrowserTests(unittest.IsolatedAsyncioTestCase):
    async def test_zip_rotations_offline_and_bounded_memory_measurements(self):
        import psutil
        from playwright.async_api import async_playwright
        root = Path(os.environ["ENDURANCE_BUNDLE_SOURCE"])
        output = Path(os.environ["ENDURANCE_BUNDLE_OUTPUT"])
        output.mkdir(parents=True, exist_ok=False)
        manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
        rows, terrains = [], {}
        for ref in bundle_files(root):
            if not ref["path"].startswith(("journal/", "terrains/")):
                continue
            with (root / ref["path"]).open(encoding="utf-8") as stream:
                for line in stream:
                    row = json.loads(line)
                    if ref["path"].startswith("journal/"):
                        if len(rows) < 128:
                            rows.append(row)
                    else:
                        terrains[row["id"]] = row
        self.assertGreaterEqual(len(rows), 64)
        measurements = []
        async with async_playwright() as runtime:
            browser = await runtime.chromium.launch(headless=True, args=["--enable-precise-memory-info", "--js-flags=--expose-gc"])
            try:
                for count in (256, 512, 1024):
                    context = await browser.new_context(accept_downloads=True)
                    page = await context.new_page()
                    await page.goto(os.environ["ENDURANCE_BUNDLE_DEV_URL"])
                    data = dict(session=manifest["session"], rows=rows, count=count, terrains=terrains, id=f"bundle-check-{count}")
                    started = time.perf_counter()
                    operation = asyncio.create_task(page.evaluate("""async data => {
                      const { BrowserDisk } = await import('/src/game/endurance/bundle/browserDisk.ts');
                      const { buildBundle } = await import('/src/game/endurance/bundle/build.ts');
                      const { writeZip } = await import('/src/game/endurance/bundle/zip.ts');
                      const disk = await BrowserDisk.create(data.id);
                      window.testBundleDisk = disk;
                      const status = {schemaVersion:1, sessionId:data.session.id, persisted:data.count,
                        emitted:data.count, complete:false, error:null};
                      const source = {session:data.session, status, terrain:async id => data.terrains[id],
                        collection:async () => [], journal:async after => Array.from({length:Math.min(256,data.count-after)},(_,i)=>{
                          const sequence=after+i+1, original=data.rows[sequence-1];
                          return {...(original??data.rows[0]),sequence,
                            event:original?.event??{kind:'phase',reason:'benchmark-padding',players:[]},
                            contextError:'Benchmark fixture only: '+ 'é😀'.repeat(12000)};
                        })};
                      const heapStart = performance.memory?.usedJSHeapSize ?? null;
                      let exportStart = performance.now(), indexStart = null;
                      const manifest = await buildBundle(source,disk,{partSizeMiB:1},undefined,
                        p=>{if(p.stage==='report') indexStart=performance.now()});
                      const finished = performance.now();
                      const zipStart = performance.now(); await writeZip(disk); const zipEnd=performance.now();
                      let cancellation = null;
                      if(data.count===256) {
                        const temporary=await BrowserDisk.create(data.id+'-cancel'), controller=new AbortController();
                        try { await buildBundle(source,temporary,{partSizeMiB:1},controller.signal,()=>controller.abort()); }
                        catch(error) { cancellation=error.name; }
                        finally { await temporary.dispose(); }
                      }
                      window.gc?.();
                      let total=0,parts=0; for await(const file of disk.scan('files')) {
                        total += await disk.size(file.key); if(file.key.startsWith('journal/')) parts++;
                      }
                      return {manifest,parts,total,zipBytes:await disk.size('bundle.zip'),heapStart,cancellation,
                        heapEnd:performance.memory?.usedJSHeapSize??null,
                        exportMs:(indexStart??finished)-exportStart,indexMs:indexStart===null?null:finished-indexStart,
                        zipMs:zipEnd-zipStart};
                    }""", data))
                    peak_heap = peak_rss = peak_private = peak_python = 0
                    while not operation.done():
                        rss = private = 0
                        for process in psutil.Process().children(recursive=True):
                            try:
                                if "chrome" in process.name().lower():
                                    info = process.memory_info(); rss += info.rss; private += getattr(info, "private", 0)
                            except (psutil.NoSuchProcess, psutil.AccessDenied):
                                pass
                        peak_rss = max(peak_rss, rss); peak_private = max(peak_private, private)
                        peak_python = max(peak_python, psutil.Process().memory_info().rss)
                        peak_heap = max(peak_heap, await page.evaluate("() => performance.memory?.usedJSHeapSize??0"))
                        await asyncio.sleep(.1)
                    result = await operation
                    cdp = await context.new_cdp_session(page)
                    await cdp.send("HeapProfiler.collectGarbage")
                    result["retainedJSHeap"] = (await cdp.send("Runtime.getHeapUsage"))["usedSize"]
                    result.update(records=count, elapsedMs=(time.perf_counter()-started)*1000, peakJSHeap=peak_heap,
                                  peakBrowserRSS=peak_rss, peakBrowserPrivate=peak_private, peakPythonRSS=peak_python)
                    measurements.append(result)
                    if count == 256:
                        self.assertEqual(result["cancellation"], "AbortError")
                    if count >= 64:
                        self.assertGreaterEqual(result["parts"], 4)
                    if count == 1024:
                        async with page.expect_download() as event:
                            await page.evaluate("() => window.testBundleDisk.download('bundle.zip','test.zip')")
                        await (await event.value).save_as(output / "test.zip")
                        with zipfile.ZipFile(output / "test.zip") as archive:
                            self.assertIsNone(archive.testzip())
                            archive.extractall(output / "extracted")
                        class Links(HTMLParser):
                            def handle_starttag(inner, tag, attrs):
                                for key, value in attrs:
                                    if key in ("href", "src") and value:
                                        url = urlparse(value)
                                        self.assertFalse(url.scheme or url.netloc, value)
                                        target = (html.parent / unquote(url.path)).resolve()
                                        self.assertTrue(target.is_relative_to((output / "extracted").resolve()), value)
                                        self.assertTrue(target.is_file(), str(target))
                        for html in (output / "extracted").rglob("*.html"):
                            Links().feed(html.read_text(encoding="utf-8"))
                        requests = []
                        page.on("request", lambda request: requests.append(request.url))
                        await context.set_offline(True)
                        await page.goto((output / "extracted/index.html").resolve().as_uri())
                        await page.get_by_role("link", name="Rapport hors ligne / Offline report").click()
                        await page.get_by_role("link", name="Statistiques / Statistics").click()
                        self.assertIn("Durées", await page.title())
                        self.assertFalse(any(url.startswith(("http://", "https://")) for url in requests))
                    await context.close()
            finally:
                await browser.close()
        (output / "measurements.json").write_text(json.dumps(dict(
            fixture="Recorded native rows with deterministic contextError padding; gameplay was not rerun or modified",
            samples=measurements), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
