import asyncio
import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from lifecycle import Deadline, Lifecycle, Resource
from model import REQUIRED, Status, fingerprint, targets
from native import JournalCollector
from run import Driver, main
from test_native import make_page
from verify import recovery


class FakeContext:
    browser = None  # Persistent contexts need not expose a browser.

    def __init__(self, fail=False):
        self.callbacks = {}
        self.close_calls = 0
        self.fail = fail

    def on(self, event, fn):
        self.callbacks[event] = fn

    async def close(self):
        self.close_calls += 1
        if self.fail:
            raise RuntimeError("close failed")
        self.callbacks["close"]()


class FakePage:
    def __init__(self):
        self.callbacks = {}
        self.closed = False

    def on(self, event, fn):
        self.callbacks[event] = fn

    def is_closed(self):
        return self.closed


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def driver(self):
        return Driver(SimpleNamespace(output=self.root, duration_ms=1000, completed_blocks=None,
                                      run_id="run", finalization_seconds=1, safety_seconds=5))

    async def test_owned_resource_liveness_and_unique_close(self):
        life = Lifecycle(1)
        context = FakeContext()
        resource = life.own(context, "session")
        self.assertFalse(resource.usable())
        page = FakePage()
        resource.own_page(page)
        self.assertTrue(resource.usable())
        page.callbacks["crash"]()
        self.assertFalse(resource.usable())
        await asyncio.gather(resource.close(life.begin()), resource.close(life.begin()))
        await resource.close(life.begin())
        self.assertEqual(context.close_calls, 1)
        self.assertTrue(resource.closed)

    async def test_failed_close_does_not_authorize_profile_reopen(self):
        life = Lifecycle(1)
        context = FakeContext(fail=True)
        resource = life.own(context, "session")
        status = Status(self.root, targets(1, None))
        status.error("export", RuntimeError("primary"))
        await life.cleanup(status)
        await life.cleanup(status)
        self.assertEqual(context.close_calls, 1)
        self.assertFalse(resource.closed)
        self.assertEqual(status.data["primaryError"]["message"], "primary")
        self.assertEqual(len(status.data["secondaryErrors"]), 1)
        with self.assertRaises(ValueError):
            life.own(FakeContext(), "recovery")

    async def test_observed_closed_resource_needs_no_close(self):
        context = FakeContext()
        resource = Resource(context, "session")
        context.callbacks["close"]()
        await resource.close(Deadline(1))
        self.assertEqual(context.close_calls, 0)

    async def test_single_deadline_does_not_restart(self):
        current = [10]
        deadline = Deadline(2, clock=lambda: current[0])
        self.assertEqual(deadline.remaining(), 2)
        current[0] = 12
        operation = AsyncMock()
        with self.assertRaises(TimeoutError):
            await deadline.call(operation)
        operation.assert_not_called()

    async def test_rescue_before_creation_and_after_page_loss_never_creates_resources(self):
        driver = self.driver()
        await driver.rescue(); await driver.rescue()
        self.assertEqual(len(driver.status.data["proofs"]), 1)
        self.assertEqual(driver.lifecycle.resources, [])

    async def test_active_rescue_stops_once_and_awaits_existing_finalization(self):
        for stopped in (False, True):
            with self.subTest(stopped=stopped):
                root = self.root / str(stopped)
                driver = Driver(SimpleNamespace(output=root, duration_ms=1, completed_blocks=None, run_id=None, finalization_seconds=1))
                resource = driver.lifecycle.own(FakeContext(), "session")
                resource.own_page(FakePage())
                driver.metrics = AsyncMock(return_value={"status": "stopped" if stopped else "running"})
                driver.stop = AsyncMock()
                driver.finalize = AsyncMock()
                await asyncio.gather(driver.rescue(), driver.rescue())
                await driver.rescue()
                self.assertEqual(driver.stop.await_count, 0 if stopped else 1)
                driver.finalize.assert_awaited_once()

    async def test_stop_command_is_submitted_once_and_starts_shared_deadline(self):
        driver = self.driver()
        evaluate = AsyncMock()
        page = SimpleNamespace(get_by_role=lambda *_, **__: SimpleNamespace(evaluate=evaluate))
        await driver.stop(page, "objective")
        deadline = driver.lifecycle.deadline
        await driver.stop(page, "failure-rescue")
        evaluate.assert_awaited_once()
        self.assertIs(driver.lifecycle.deadline, deadline)
        self.assertEqual(driver.status.data["trigger"], "objective")

    async def test_page_disappears_between_guard_and_operation(self):
        driver = self.driver()
        resource = driver.lifecycle.own(FakeContext(), "session")
        resource.own_page(FakePage())
        driver.metrics = AsyncMock(side_effect=RuntimeError("page disappeared"))
        driver.status.error("execution", RuntimeError("primary"))
        await driver.rescue()
        await driver.lifecycle.cleanup(driver.status)
        self.assertEqual(driver.status.data["primaryError"]["message"], "primary")
        self.assertEqual(driver.status.data["secondaryErrors"][0]["message"], "page disappeared")

    async def test_optional_screenshot_failure_is_only_a_warning(self):
        driver = self.driver()
        resource = driver.lifecycle.own(FakeContext(), "session")
        page = FakePage(); page.screenshot = AsyncMock(side_effect=RuntimeError("optional"))
        resource.own_page(page)
        await driver.screenshot(resource)
        self.assertIsNone(driver.status.data["primaryError"])
        self.assertEqual(len(driver.status.data["warnings"]), 1)
        driver.status.data.update(nativeReason="duration", stoppedAtDurationMs=1000, counters={"completed": 0})
        for control in REQUIRED:
            driver.status.proof(control)
        self.assertEqual(driver.status.finish(), 0)
        resource.closed = True
        await driver.screenshot(resource)
        self.assertEqual(page.screenshot.await_count, 1)

    async def test_download_candidates_never_replace_attested_bytes(self):
        driver = self.driver()
        path = self.root / "shots.json"
        path.write_bytes(b'{"verified":true}')
        driver.status.proof("archive", [path], 1)
        class Download:
            async def save_as(self, candidate):
                candidate.write_bytes(b'{"different":true}')
            async def failure(self):
                return None
        class Event:
            async def __aenter__(self):
                self.value = asyncio.get_running_loop().create_future()
                self.value.set_result(Download())
                return self
            async def __aexit__(self, *_):
                return False
        page = SimpleNamespace(expect_download=lambda: Event())
        validate = AsyncMock()
        with self.assertRaisesRegex(ValueError, "CANDIDATE_DIVERGES"):
            await driver.download(page, SimpleNamespace(click=AsyncMock()), "shots.json", validate)
        validate.assert_awaited_once()
        self.assertEqual(path.read_bytes(), b'{"verified":true}')
        self.assertEqual(len(list(self.root.glob("*.candidate"))), 1)
        validate.side_effect = RuntimeError("invalid archive")
        with self.assertRaisesRegex(RuntimeError, "invalid archive"):
            await driver.download(page, SimpleNamespace(click=AsyncMock()), "shots.json", validate)
        self.assertEqual(path.read_bytes(), b'{"verified":true}')

    async def test_failures_at_each_browser_boundary_keep_primary_and_close_once(self):
        for boundary in ("launch-session", "export-final", "close-session", "launch-recovery", "download-recovered", "compare-recovered", "close-recovery"):
            with self.subTest(boundary=boundary):
                root = self.root / boundary
                driver = Driver(SimpleNamespace(output=root, duration_ms=1, completed_blocks=None, run_id=None, finalization_seconds=5, safety_seconds=10))
                async def chain(_):
                    for stage in ("session", "recovery"):
                        if boundary == "launch-" + stage:
                            raise RuntimeError(boundary)
                        resource = driver.lifecycle.own(FakeContext(fail=boundary == "close-" + stage), stage)
                        resource.own_page(FakePage())
                        if stage == "session" and boundary == "export-final" or stage == "recovery" and boundary in ("download-recovered", "compare-recovered"):
                            raise RuntimeError(boundary)
                        await resource.close(driver.lifecycle.begin())
                driver.run_browser = chain
                driver.metrics = AsyncMock(side_effect=RuntimeError("rescue unavailable"))
                self.assertEqual(await driver.run(None), 1)
                self.assertEqual(driver.status.data["primaryError"]["message"], "close failed" if boundary.startswith("close-") else boundary)
                self.assertTrue(all(r.context.close_calls == 1 for r in driver.lifecycle.resources))

    async def test_regression_exception_after_compared_recovery_and_both_closes(self):
        driver = self.driver()
        session = dict(id="s", status="stopped", collection="complete", storageError=None, reason="archive-budget",
                       attempted=1, completed=0, abandoned=0, interrupted=1)
        driver.status.data.update(sessionId="s", nativeReason="archive-budget", stoppedAtDurationMs=1, counters={"completed": 0}, journalCopied=1)
        async def chain(_):
            for name in ("final.json", "recovered.json"):
                (self.root / name).write_text(json.dumps(dict(session=session)))
            for name in ("journal-final.jsonl", "recovered.jsonl", "shots-final.json", "recovered-shots.json"):
                (self.root / name).write_bytes(b"real compared bytes")
            for control in REQUIRED - {"recovered-journal", "recovered-archive", "recovered-summary"}:
                driver.status.proof(control, sequence=1)
            recovery(driver.status)
            for stage in ("session", "recovery"):
                resource = driver.lifecycle.own(FakeContext(), stage)
                resource.own_page(FakePage())
                await resource.close(driver.lifecycle.begin())
            self.proofs_before_error = copy.deepcopy(driver.status.data["proofs"])
            raise RuntimeError("injected after both closes")
        driver.run_browser = chain
        driver.metrics = AsyncMock(side_effect=AssertionError("no browser access allowed"))
        self.assertEqual(await driver.run(None), 1)
        self.assertEqual(driver.status.data["primaryError"]["message"], "injected after both closes")
        self.assertEqual(driver.status.data["proofs"][:len(self.proofs_before_error)], self.proofs_before_error)
        self.assertEqual([r.context.close_calls for r in driver.lifecycle.resources], [1, 1])
        driver.metrics.assert_not_called()

    def test_raw_cursor_and_verified_prefix_remain_distinct_after_failure(self):
        collector = JournalCollector(self.root)
        page = make_page("s", 1, 3, persisted=3)
        def analyze(row):
            if row["sequence"] == 2:
                raise RuntimeError("analysis failed")
        with self.assertRaises(RuntimeError):
            collector.process_page(page, analyze)
        self.assertEqual((collector.journal_sequence, collector.verified_sequence, collector.analysis_failed_sequence), (3, 1, 2))
        self.assertEqual(collector.decisions_file.read_bytes(), page["text"].encode())
        prefix = fingerprint(collector.decisions_file, collector.verified_bytes)
        collector.process_page(make_page("s", 4, 1, persisted=4), analyze)
        self.assertEqual(collector.verified_sequence, 1)
        self.assertEqual(fingerprint(collector.decisions_file, collector.verified_bytes), prefix)

    def test_status_publication_failure_keeps_last_readable_version(self):
        status = Status(self.root, targets(1, None))
        status.publish()
        before = (self.root / "status.json").read_bytes()
        with patch("model.atomic", side_effect=OSError("disk failed")):
            with self.assertRaises(OSError):
                status.publish()
        self.assertEqual((self.root / "status.json").read_bytes(), before)
        self.assertEqual(status.data["primaryError"]["stage"], "status-publication")

    def test_changed_or_missing_attested_file_fails_without_erasing_history(self):
        for remove in (False, True):
            with self.subTest(remove=remove):
                status = Status(self.root, targets(1, None))
                path = self.root / "evidence"
                path.write_bytes(b"verified")
                status.proof("archive", [path], 1)
                if remove:
                    path.unlink()
                else:
                    path.write_bytes(b"changed")
                status.check_files()
                self.assertEqual(status.data["proofs"][0]["state"], "verified")
                self.assertEqual(status.data["proofs"][-1]["state"], "failed")
                self.assertIsNotNone(status.data["primaryError"])

    async def test_main_safety_timeout_rescues_and_cleans_once(self):
        driver = self.driver()
        driver.args.safety_seconds = .03
        resource = driver.lifecycle.own(FakeContext(), "session")
        resource.own_page(FakePage())
        async def blocked(_):
            await asyncio.Event().wait()
        driver.run_browser = blocked
        driver.rescue = AsyncMock()
        driver.lifecycle.cleanup = AsyncMock(wraps=driver.lifecycle.cleanup)
        class Runtime:
            async def __aenter__(self):
                return None
            async def __aexit__(self, *_):
                return False
        with patch("run.Driver", return_value=driver), patch("run.signal.signal"), patch("playwright.async_api.async_playwright", return_value=Runtime()):
            self.assertEqual(await main(driver.args), 1)
        driver.rescue.assert_awaited_once()
        driver.lifecycle.cleanup.assert_awaited_once()
        self.assertEqual(resource.context.close_calls, 1)
        self.assertEqual(driver.status.data["primaryError"]["type"], "CancelledError")

    async def test_main_startup_timeout_cleans_without_rescue(self):
        driver = self.driver()
        driver.args.safety_seconds = .03
        driver.rescue = AsyncMock()
        driver.lifecycle.cleanup = AsyncMock(wraps=driver.lifecycle.cleanup)
        class Runtime:
            async def __aenter__(self):
                await asyncio.Event().wait()
            async def __aexit__(self, *_):
                return False
        with patch("run.Driver", return_value=driver), patch("run.signal.signal"), patch("playwright.async_api.async_playwright", return_value=Runtime()):
            self.assertEqual(await main(driver.args), 1)
        driver.rescue.assert_not_awaited()
        driver.lifecycle.cleanup.assert_awaited_once()

    async def test_collection_checkpoints_are_bounded_incremental_and_published_once(self):
        driver = self.driver()
        driver.status.data["sessionId"] = "s"
        driver.status.publish = Mock()
        for sequence in range(1, 101):
            page = SimpleNamespace(evaluate=AsyncMock(return_value=make_page("s", sequence, 1, persisted=sequence)))
            with patch("model.fingerprint", side_effect=AssertionError("collection must not reread prefixes")):
                await driver.collect(page)
        self.assertEqual(len(driver.status.data["proofs"]), 4)
        self.assertEqual(driver.status.publish.call_count, 100)
        for proof in driver.status.data["proofs"]:
            recorded = proof["files"][0]
            self.assertEqual(recorded, fingerprint(recorded["path"], recorded["bytes"]))
        driver.status.check_files()
        self.assertIsNone(driver.status.data["primaryError"])

    async def test_collection_analysis_failure_preserves_distinct_incremental_hashes(self):
        driver = self.driver()
        def analyze(row):
            if row["sequence"] == 2:
                raise RuntimeError("analysis")
        driver.ledger = analyze
        page = SimpleNamespace(evaluate=AsyncMock(return_value=make_page("s", 1, 3, persisted=3)))
        with self.assertRaisesRegex(RuntimeError, "analysis"):
            await driver.collect(page)
        for proof in driver.status.data["proofs"]:
            recorded = proof["files"][0]
            self.assertEqual(recorded, fingerprint(recorded["path"], recorded["bytes"]))
        self.assertEqual([p["sequence"] for p in driver.status.data["proofs"]], [3, 1])

    async def test_execute_exports_only_on_new_block_end_and_uses_native_completed(self):
        driver = self.driver()
        driver.args.completed_blocks = 2
        driver.configure = AsyncMock()
        driver.metrics = AsyncMock(return_value={"status": "running"})
        ends = iter([0, 0, 1, 1, 2, 2, 3])
        async def collect(_):
            driver.collector.journal_counts["block-end"] = next(ends)
        driver.collect = collect
        driver.summary = AsyncMock(side_effect=[{"completed": 0}, {"completed": 1}, {"completed": 2}])
        driver.stop = AsyncMock()
        driver.finalize = AsyncMock()
        with patch("run.asyncio.sleep", new=AsyncMock()):
            await driver.execute(SimpleNamespace(page=SimpleNamespace(add_init_script=AsyncMock())))
        self.assertEqual(driver.summary.await_count, 3)
        driver.stop.assert_awaited_once()
        driver.finalize.assert_awaited_once()

    async def test_rescue_rejects_wrong_journal_header(self):
        driver = self.driver()
        resource = driver.lifecycle.own(FakeContext(), "session")
        resource.own_page(SimpleNamespace(is_closed=lambda: False, on=lambda *_: None, get_by_role=lambda *_, **__: None))
        page = make_page("s", 1, 1, persisted=1)
        page["status"]["complete"] = True
        driver.collector.process_page(page)
        driver.status.data.update(sessionId="s", journalCopied=1)
        path = self.root / "journal-final.jsonl"
        path.write_bytes(b'{"kind":"wrong","status":null}\n' + driver.collector.decisions_file.read_bytes())
        driver.metrics = AsyncMock(return_value={"status": "stopped"})
        driver.finalize = AsyncMock(side_effect=RuntimeError("injected"))
        driver.download = AsyncMock(return_value=path)
        driver.shots = AsyncMock(side_effect=RuntimeError("unavailable"))
        await driver.rescue()
        self.assertFalse(driver.status.has_proof("journal-binary"))
        self.assertIn("NATIVE_JOURNAL_STATUS_MISMATCH", str(driver.status.data["secondaryErrors"]))

    async def test_archive_rescue_uses_initial_identity_without_final_summary(self):
        driver = self.driver()
        driver.status.data["sessionId"] = "s"
        (self.root / "initial.json").write_text(json.dumps({"session": {"id": "s", "build": "build"}}))
        path = self.root / "shots.json"
        path.write_text(json.dumps(dict(sessionId="s", build="build", complete=True, error=None, evicted=0)))
        process = SimpleNamespace(communicate=AsyncMock(return_value=(b"", b"")), returncode=0)
        with patch("run.asyncio.create_subprocess_exec", new=AsyncMock(return_value=process)) as launch:
            await driver.validate_shots(path)
            launch.assert_awaited_once()
        self.assertFalse((self.root / "final.json").exists())

    async def test_global_timeout_during_cleanup_keeps_unique_close_alive(self):
        driver = self.driver()
        driver.args.safety_seconds = .03
        resource = driver.lifecycle.own(FakeContext(), "session")
        async def slow_close():
            resource.context.close_calls += 1
            await asyncio.sleep(.06)
            resource.context.callbacks["close"]()
        resource.context.close = slow_close
        driver.run_browser = AsyncMock()
        driver.rescue = AsyncMock()
        driver.lifecycle.cleanup = AsyncMock(wraps=driver.lifecycle.cleanup)
        class Runtime:
            async def __aenter__(self):
                return None
            async def __aexit__(self, *_):
                return False
        with patch("run.Driver", return_value=driver), patch("run.signal.signal"), patch("playwright.async_api.async_playwright", return_value=Runtime()):
            self.assertEqual(await main(driver.args), 1)
        driver.lifecycle.cleanup.assert_awaited_once()
        driver.rescue.assert_awaited_once()
        self.assertTrue(resource.closed)
        self.assertEqual(resource.context.close_calls, 1)
