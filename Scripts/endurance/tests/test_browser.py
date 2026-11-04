"""Opt-in real Chromium persistence smoke test, shared by #382 and #383.

Requires a locally served endurance build and ENDURANCE_SMOKE_URL/BUILD/OUTPUT.
"""
import os
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

from model import REQUIRED
from run import Driver, arguments


@unittest.skipUnless(os.environ.get("ENDURANCE_SMOKE_URL"), "real browser smoke is opt-in")
class BrowserTests(unittest.IsolatedAsyncioTestCase):
    async def test_stop_export_reopen_compare_close_and_late_exception(self):
        from playwright.async_api import async_playwright
        for inject in (False, True):
            with self.subTest(inject=inject):
                output = Path(os.environ["ENDURANCE_SMOKE_OUTPUT"]) / ("injected" if inject else "normal")
                args = arguments(["--url", os.environ["ENDURANCE_SMOKE_URL"], "--expected-build", os.environ["ENDURANCE_SMOKE_BUILD"],
                    "--config", str(Path(__file__).resolve().parents[1] / "config.example.json"), "--output", str(output),
                    "--duration-ms", "12000", "--finalization-seconds", "45", "--safety-seconds", "100"])
                args.config_data["profiles"] = ["v1-random", "v1-random"]
                args.config_data["freeWeapons"] = inject
                driver = Driver(args)
                execute = driver.execute
                async def execute_with_native_stop_race(resource):
                    await execute(resource)
                    frozen = driver.status.data["stoppedAtDurationMs"]
                    # Submit an objective request after the native duration has won
                    # the race. A disabled native button must not hang or stop twice.
                    await driver.stop(resource.page, "objective")
                    self.assertEqual((await driver.metrics(resource.page))["stoppedAtDurationMs"], frozen)
                driver.execute = execute_with_native_stop_race
                if inject:
                    async def fail_after_close():
                        self.assertTrue(all(r.closed for r in driver.lifecycle.resources))
                        # Any rescue use of a browser after closure fails this regression.
                        driver.metrics = AsyncMock(side_effect=AssertionError("browser used after closure"))
                        raise RuntimeError("INJECTED_AFTER_VERIFIED_RECOVERY")
                    driver.after_recovery = fail_after_close
                async with async_playwright() as playwright:
                    code = await driver.run(playwright)
                self.assertEqual(code, 1 if inject else 0)
                self.assertTrue(REQUIRED <= {p["control"] for p in driver.status.data["proofs"] if p["state"] == "verified"})
                self.assertTrue(all(r.closed for r in driver.lifecycle.resources))
                self.assertEqual(len(driver.lifecycle.resources), 2)
                if inject:
                    driver.metrics.assert_not_called()
                    self.assertEqual(driver.status.data["primaryError"]["message"], "INJECTED_AFTER_VERIFIED_RECOVERY")
