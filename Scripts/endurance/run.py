"""Reusable native UI driver. Run from the repository root; no historical artifact dependencies."""
import argparse
import asyncio
import json
import math
import re
import signal
import subprocess
import sys
import urllib.parse
import uuid
import time
from pathlib import Path

from ledger import Ledger
from lifecycle import Lifecycle
from model import Status, positive, require, targets, atomic
from native import JournalCollector
from verify import scenario_config, archive_manifest, closed_session, compare, journal, read, recovery
from bundle import collect_bundle, logical_stream, compare_bundles, proof_files
from multipart import compare_streams

ROOT = Path(__file__).resolve().parents[2]
PROFILES = {"v1-random", "v2-heuristic", "v3-sniper", "v4-smart"}


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        self.exit(1, self.prog + ": " + message + "\n")


def arguments(argv=None):
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expected-build", required=True, help="Exact session build identity, including timestamp")
    parser.add_argument("--scenario", type=Path, help="Custom JSON map; overrides config scenario")
    parser.add_argument("--config", type=Path, required=True, help="See config.example.json")
    parser.add_argument("--duration-ms", type=int, required=True)
    parser.add_argument("--completed-blocks", type=int)
    parser.add_argument("--finalization-seconds", type=float, default=120)
    parser.add_argument("--safety-seconds", type=float, required=True)
    parser.add_argument("--run-id")
    parser.add_argument("--part-size-mib", type=int, default=20)
    parser.add_argument("--slow-decision-ms", type=int, default=1000)
    args = parser.parse_args(argv)
    try:
        targets(args.duration_ms, args.completed_blocks)
        require(0 < args.part_size_mib * 1048576 <= 9007199254740991 and 0 < args.slow_decision_ms <= 9007199254740991, "INVALID_EXPORT_OPTIONS")
        parsed = urllib.parse.urlparse(args.url)
        require(parsed.scheme in ("http", "https") and bool(parsed.netloc), "INVALID_URL")
        require(positive(args.finalization_seconds) and positive(args.safety_seconds), "INVALID_TECHNICAL_TIMEOUT")
        require(args.safety_seconds > args.duration_ms / 1000 + args.finalization_seconds, "SAFETY_MUST_INCLUDE_FINALIZATION")
        config = read(args.config)
        require(isinstance(config, dict), "INVALID_CONFIG")
        require(set(config) - {"scenario"} == {"profiles", "roundsPerBlock", "archiveBudgetMiB", "freeWeapons", "stopOnIncident", "limits"}, "INVALID_CONFIG_KEYS")
        require(type(config["profiles"]) is list and 2 <= len(config["profiles"]) <= 4 and all(p in PROFILES for p in config["profiles"]), "INVALID_PROFILES")
        require(type(config["roundsPerBlock"]) is int and 0 < config["roundsPerBlock"] <= 9007199254740991, "INVALID_ROUNDS")
        require(type(config["archiveBudgetMiB"]) is int and 64 <= config["archiveBudgetMiB"] <= 4096, "INVALID_ARCHIVE_BUDGET")
        require(type(config["freeWeapons"]) is bool and type(config["stopOnIncident"]) is bool, "INVALID_FLAGS")
        require(isinstance(config["limits"], dict) and set(config["limits"]) == {"turns", "roundMs", "actionMs", "transitionMs"} and
                all(type(v) is int and 0 < v <= 9007199254740991 for v in config["limits"].values()), "INVALID_LIMITS")
        configured = config.get("scenario")
        require(configured is None or isinstance(configured, str) and bool(configured.strip()), "INVALID_SCENARIO_PATH")
        path = args.scenario if args.scenario is not None else (args.config.resolve().parent / configured if configured else None)
        args.scenario_path = path.resolve() if path is not None else None
        args.scenario_data = None
        if args.scenario_path is not None:
            checked = subprocess.run(["node", str(ROOT / "Scripts/endurance/scenario.mjs"), "validate", str(args.scenario_path)],
                                     cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=60)
            require(checked.returncode == 0, "INVALID_SCENARIO: " + checked.stderr)
            args.scenario_data = json.loads(checked.stdout)
            require(len(args.scenario_data["spawnXs"]) == len(config["profiles"]), "SCENARIO_PROFILE_COUNT_MISMATCH")
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        parser.error(str(error))
    args.config_data = config
    return args


class Driver:
    def __init__(self, args):
        self.args = args
        self.status = Status(args.output, targets(args.duration_ms, args.completed_blocks), args.run_id)
        self.multipart = hasattr(args, "part_size_mib")
        self.collector = JournalCollector(self.status.output, part_size=args.part_size_mib * 1048576 if self.multipart else None)
        if not self.multipart:
            self.collector.decisions_file.touch(exist_ok=False)
        self.bundle_options = dict(partSizeMiB=getattr(args, "part_size_mib", 20), slowDecisionMs=getattr(args, "slow_decision_ms", 1000))
        self.ledger = Ledger()
        self.cancelled = False
        self.stop_requested = False
        self.lifecycle = Lifecycle(args.finalization_seconds)

    async def metrics(self, page):
        metrics = await page.evaluate("() => window.__tankwarsEnduranceTest.readArchiveMetrics()")
        require("stoppedAtDurationMs" in metrics, "FROZEN_DURATION_CAPABILITY_REQUIRED")
        frozen = metrics["stoppedAtDurationMs"]
        require(frozen is None or type(frozen) in (int, float) and math.isfinite(frozen) and frozen >= 0, "INVALID_STOP_MEASUREMENT")
        previous = self.status.data["stoppedAtDurationMs"]
        require(previous is None or previous == frozen, "STOP_MEASUREMENT_CHANGED")
        self.status.data.update(archiveMetrics=metrics, nativeReason=metrics["reason"],
                                stoppedAtDurationMs=metrics["stoppedAtDurationMs"])
        self.status.publish()
        return metrics

    async def collect(self, page, final=False):
        started = time.perf_counter()
        while True:
            result = await page.evaluate("after => window.__tankwarsEnduranceTest.readJournalText(after, 256)", self.collector.journal_sequence)
            before = self.collector.journal_sequence
            try:
                count, _ = self.collector.process_page(result, self.ledger)
            finally:
                self.status.data.update(journalCopied=self.collector.journal_sequence, journalVerified=self.collector.verified_sequence,
                    analysisFailedSequence=self.collector.analysis_failed_sequence,
                    journalStatus=self.collector.latest_status, journalSha256=self.collector.sha256.hexdigest())
                if self.collector.journal_sequence > before:
                    self.status.proof("raw-copy", [self.collector.decisions_file], self.collector.journal_sequence,
                                      prefix_bytes=self.collector.copied_bytes, prefix_sha256=self.collector.sha256.hexdigest(), publish=False)
                    self.status.proof("ledger-prefix", [self.collector.decisions_file], self.collector.verified_sequence,
                                      prefix_bytes=self.collector.verified_bytes, prefix_sha256=self.collector.verified_sha256.hexdigest(), publish=False)
                self.status.publish()
            meta = result["status"]
            require(meta is not None and not meta["error"], "JOURNAL_UNAVAILABLE_OR_FAILED")
            if not count or self.collector.journal_sequence >= meta["persisted"]:
                break
        if final:
            journal(meta, self.collector)
            self.status.proof("journal", [self.collector.decisions_file], self.collector.journal_sequence)
        timings = self.status.data.setdefault("timings", {})
        timings["collectionMs"] = timings.get("collectionMs", 0) + (time.perf_counter() - started) * 1000

    async def download(self, page, button, filename, validate=None):
        path = self.status.output / filename
        candidate = path.with_name(path.name + "." + uuid.uuid4().hex + ".candidate")
        async with page.expect_download() as event:
            await button.click()
        download = await event.value
        await download.save_as(candidate)
        require(await download.failure() is None, "DOWNLOAD_FAILED: " + filename)
        if filename.endswith(".json"):
            read(candidate)
        if validate is not None:
            await validate(candidate)
        # Published files are immutable. A later attempt cannot destroy prior evidence.
        attested = any(p["state"] == "verified" and any(f["path"] == str(path.resolve()) for f in p["files"])
                       for p in self.status.data["proofs"])
        if path.exists() and attested:
            require(path.read_bytes() == candidate.read_bytes(), "CANDIDATE_DIVERGES: " + filename)
            candidate.unlink()
            return path
        candidate.replace(path)
        return path

    async def summary(self, page, filename="final.json", scope=None):
        if self.multipart:
            await page.wait_for_function("() => !!window.__tankwarsEnduranceBundle")
            value = await page.evaluate("() => window.__tankwarsEnduranceBundle.summary()")
            require(value.get("schemaVersion") == 2, "UNSUPPORTED_DRIVER_SUMMARY")
            atomic(self.status.output / filename, json.dumps(value, ensure_ascii=False) + "\n")
            scenario_config(value["session"], getattr(self.args, "scenario_data", None))
            return value["session"]
        scope = scope if scope is not None else page
        session = read(await self.download(page, scope.get_by_role("button", name="JSON", exact=True), filename))["session"]
        scenario_config(session, getattr(self.args, "scenario_data", None))
        return session

    async def shots(self, page, filename, scope=None):
        if scope is None:
            panel = page.locator("details.diagnostic-panel")
            await panel.evaluate("el => { el.open = true; }")
            scope = panel
        return await self.download(page, scope.get_by_role("button", name="Exporter les tirs", exact=True), filename, self.validate_shots)

    async def validate_shots(self, path):
        started = time.perf_counter()
        # Rescue may preserve a complete archive before the final summary exists.
        summary = self.status.output / "final.json"
        if not summary.exists():
            summary = self.status.output / "initial.json"
        session = read(summary)["session"]
        require(session["id"] == self.status.data["sessionId"], "SESSION_CHANGED")
        value = read(path)
        if value.get("format") == "tankwars-endurance-bundle":
            require(value["session"]["id"] == session["id"] and value["session"]["build"] == session["build"], "ARCHIVE_IDENTITY_MISMATCH")
            require(value["complete"] and value["journal"]["complete"] and not value["journal"]["error"], "INCOMPLETE_ARCHIVE")
        else:
            archive_manifest(value, session)
        process = await asyncio.create_subprocess_exec("node", str(ROOT / "Scripts/endurance/validate-archive.mjs"), str(path.resolve()),
                                                       cwd=ROOT, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            stdout, stderr = await process.communicate()
        except BaseException:
            process.kill(); await process.wait(); raise
        require(process.returncode == 0, "ARCHIVE_VALIDATION: " + stderr.decode(errors="replace"))
        timings = self.status.data.setdefault("timings", {})
        timings["validationMs"] = timings.get("validationMs", 0) + (time.perf_counter() - started) * 1000

    async def configure(self, page):
        await page.goto(self.args.url)
        await page.get_by_role("button", name="Endurance IA", exact=True).click()
        config = self.args.config_data
        count = page.get_by_label(re.compile(r"^NOMBRE DE JOUEURS :"))
        if getattr(self.args, "scenario_path", None) is not None:
            # Upload the validated bytes, protecting against a source edit between preflight and upload.
            await page.get_by_test_id("endurance-scenario-input").set_input_files(dict(
                name=self.args.scenario_path.name, mimeType="application/json",
                buffer=json.dumps(self.args.scenario_data, ensure_ascii=False).encode("utf-8")))
            await page.get_by_test_id("endurance-scenario-preview").wait_for()
            require(await count.is_disabled() and await count.input_value() == str(len(config["profiles"])), "SCENARIO_COUNT_NOT_LOCKED")
        else:
            await count.select_option(str(len(config["profiles"])))
        for index, profile in enumerate(config["profiles"], 1):
            await page.get_by_label(re.compile(rf"^Profil IA {index}")).select_option(profile)
        values = {"Manches par bloc": config["roundsPerBlock"], "Blocs tentés maximum (0 : sans limite)": 0,
                  "Durée maximale en minutes (0 : sans limite)": self.args.duration_ms / 60000,
                  "Budget d’archive (Mio)": config["archiveBudgetMiB"], "Tours par manche": config["limits"]["turns"],
                  "Durée de combat par manche (ms)": config["limits"]["roundMs"],
                  "Durée par action (ms)": config["limits"]["actionMs"], "Durée par transition (ms)": config["limits"]["transitionMs"]}
        for label, value in values.items():
            field = page.get_by_label(label, exact=True)
            # The native form has no step restriction in its domain; allow sub-minute smoke runs.
            if label.startswith("Durée maximale"):
                await field.evaluate("el => { el.step = 'any'; }")
            await field.fill(str(value))
        await page.get_by_label("Mode armes gratuites", exact=True).set_checked(config["freeWeapons"])
        await page.get_by_label("Arrêter au premier abandon sur incident", exact=True).set_checked(config["stopOnIncident"])
        await page.get_by_role("button", name="Démarrer la session", exact=True).click()
        await page.get_by_role("button", name="Arrêter et sauvegarder", exact=True).wait_for()
        session = await self.summary(page, "initial.json")
        self.status.data["sessionId"] = session["id"]
        self.collector.session_id = session["id"]
        require(session["build"] == self.args.expected_build, "SERVED_BUILD_MISMATCH")
        self.status.proof("build", [self.status.output / "initial.json"])
        actual = session["config"]
        require(actual["maxBlocks"] is None and actual["maxDurationMs"] == self.args.duration_ms, "NATIVE_LIMITS_MISMATCH")
        require([p["aiProfile"] for p in actual["players"]] == config["profiles"], "ROSTER_MISMATCH")
        for key in ("roundsPerBlock", "archiveBudgetMiB", "freeWeapons", "stopOnIncident", "limits"):
            require(actual[key] == config[key], "CONFIGURATION_MISMATCH: " + key)
        self.status.proof("configuration", [self.status.output / "initial.json"])

    async def stop(self, page, trigger):
        if not self.stop_requested:
            self.stop_requested = True
            self.status.data["trigger"] = trigger
            self.lifecycle.begin()
            # Atomic DOM check/click: the native duration may stop the session between
            # observing a completed-block objective and submitting this UI command.
            await page.get_by_role("button", name="Arrêter et sauvegarder", exact=True).evaluate(
                "el => { if (!el.disabled) el.click(); }")

    async def finalize(self, page):
        self.status.data["phase"] = "finalization"
        await page.get_by_role("button", name="MENU", exact=True).wait_for(state="visible")
        while not await page.get_by_role("button", name="MENU", exact=True).is_enabled():
            await asyncio.sleep(.1)
        metrics = await self.metrics(page)
        require(metrics["status"] == "stopped" and metrics["stoppedAtDurationMs"] is not None, "MISSING_STOP_MEASUREMENT")
        session = read(self.status.output / "final.json")["session"] if self.status.has_proof("closure") else await self.summary(page)
        require(session["id"] == self.status.data["sessionId"], "SESSION_CHANGED")
        self.status.data.update(counters=closed_session(session), nativeReason=session["reason"])
        self.status.proof("closure", [self.status.output / "final.json"])
        await self.collect(page, final=True)
        if self.multipart:
            await self.finalize_bundle(page)
            return
        if not self.status.has_proof("journal-binary"):
            await self.download(page, page.get_by_role("button", name="JSONL", exact=True), "journal-final.jsonl")
        self.verify_journal(self.status.output / "journal-final.jsonl")
        if not self.status.has_proof("archive"):
            await self.shots(page, "shots-final.json")
            self.status.proof("archive", [self.status.output / "shots-final.json"], self.collector.journal_sequence)

    async def finalize_bundle(self, page):
        root = self.status.output / "bundle"
        if not self.status.has_proof("archive"):
            started = time.perf_counter()
            manifest = await collect_bundle(page, root, self.bundle_options)
            self.status.data.setdefault("timings", {})["nativeExportMs"] = (time.perf_counter() - started) * 1000
            await self.validate_shots(root / "manifest.json")
            require(manifest["journal"] == self.collector.latest_status, "NATIVE_JOURNAL_STATUS_MISMATCH")
            if not manifest["reportComplete"]:
                self.status.warning("report", RuntimeError(manifest["reportError"]))
            self.status.proof("archive", proof_files(root), self.collector.journal_sequence)
        native = logical_stream(root, "journal")
        equal, detail = compare_streams(self.collector.decisions_file, native)
        self.status.proof("journal-binary", [self.collector.decisions_file, native], self.collector.journal_sequence,
                          "verified" if equal else "failed", None if equal else detail)
        require(equal, "NATIVE_JOURNAL_BINARY_MISMATCH: " + detail)

    def verify_journal(self, path, *, require_verified=True):
        with path.open(encoding="utf-8") as stream:
            meta = json.loads(stream.readline())
        require(isinstance(meta, dict) and meta.get("kind") == "journal-status" and meta.get("status") == self.collector.latest_status, "NATIVE_JOURNAL_STATUS_MISMATCH")
        status = meta["status"]
        require(status is not None and status.get("complete") is True and not status.get("error"), "INCOMPLETE_JOURNAL")
        require(status.get("sessionId") == self.collector.session_id, "JOURNAL_SESSION_MISMATCH")
        if require_verified:
            require(self.collector.journal_sequence == self.collector.verified_sequence == status.get("persisted") == status.get("emitted"), "JOURNAL_CURSOR_MISMATCH")
        else:
            require(self.collector.journal_sequence == status.get("persisted") == status.get("emitted"), "JOURNAL_CURSOR_MISMATCH")
        compare(self.status, "journal-binary", self.collector.decisions_file, path, True)

    async def launch(self, playwright):
        return await playwright.chromium.launch_persistent_context(str(self.status.output / "browser-profile"),
            headless=True, locale="fr-CA", timezone_id="America/Toronto", accept_downloads=True,
            viewport={"width": 1280, "height": 1000})

    async def new_resource(self, playwright, stage):
        require(all(r.closed for r in self.lifecycle.resources), "PERSISTENT_PROFILE_STILL_OWNED")
        resource = self.lifecycle.own(await self.launch(playwright), stage)
        # Explicitly own this page. Never index context.pages or guess resource liveness.
        resource.own_page(await resource.context.new_page())
        resource.page.set_default_timeout(min(15000, self.args.finalization_seconds * 1000))
        return resource

    async def screenshot(self, resource):
        if not resource.usable():
            self.status.warning("screenshot", RuntimeError("PAGE_UNAVAILABLE"))
            return
        try:
            await self.lifecycle.begin().call(lambda: resource.page.screenshot(path=str(self.status.output / "diagnostic.png"), timeout=1000))
        except Exception as error:
            self.status.warning("screenshot", error)

    async def execute(self, resource):
        page = resource.page
        await page.add_init_script("localStorage.setItem('i18nextLng', 'fr');")
        await self.configure(page)
        self.status.data["phase"] = "execution"
        checked_block_ends = 0
        while True:
            metrics = await self.metrics(page)
            if metrics["status"] == "stopped":
                self.lifecycle.begin()
                break
            await self.collect(page)
            if self.cancelled:
                await self.stop(page, "voluntary-signal"); break
            block_ends = self.collector.journal_counts.get("block-end", 0)
            if block_ends > checked_block_ends:
                # block-end also includes abandoned/interrupted blocks; only
                # the native summary establishes the completed-block objective.
                session = await self.summary(page, "progress.json")
                if self.multipart:
                    await collect_bundle(page, self.status.output / "bundle", self.bundle_options)
                checked_block_ends = block_ends
                if self.args.completed_blocks is not None and session["completed"] >= self.args.completed_blocks:
                    await self.stop(page, "objective"); break
            await asyncio.sleep(.25)
        await self.lifecycle.begin().call(lambda: self.finalize(page))

    async def run_browser(self, playwright):
        resource = await self.new_resource(playwright, "session")
        await self.execute(resource)
        await self.screenshot(resource)
        await resource.close(self.lifecycle.begin())
        # Reopening is planned verification, performed only once after confirmed close.
        resource = await self.lifecycle.begin().call(lambda: self.new_resource(playwright, "recovery"))
        async def recover():
            page = resource.page
            await page.add_init_script("localStorage.setItem('i18nextLng', 'fr');")
            await page.goto(self.args.url)
            await page.get_by_role("button", name="Endurance IA", exact=True).click()
            scope = page.locator(".endurance-screen > p").filter(has_text=self.status.data["sessionId"])
            await scope.wait_for()
            await self.summary(page, "recovered.json", scope)
            if self.multipart:
                root = self.status.output / "recovered-bundle"
                await collect_bundle(page, root, self.bundle_options)
                await self.validate_shots(root / "manifest.json")
                compare_bundles(self.status.output / "bundle", root)
                for control, kind in (("recovered-journal", "journal"), ("recovered-archive", "captures")):
                    self.status.proof(control, [logical_stream(self.status.output / "bundle", kind), logical_stream(root, kind)], self.collector.journal_sequence)
                require(read(self.status.output / "final.json")["session"] == read(self.status.output / "recovered.json")["session"], "RECOVERED_SUMMARY_MISMATCH")
                self.status.proof("recovered-summary", [self.status.output / "final.json", self.status.output / "recovered.json"])
                return
            await self.download(page, scope.get_by_role("button", name="JSONL", exact=True), "recovered.jsonl")
            await self.shots(page, "recovered-shots.json", scope)
            recovery(self.status)
        started = time.perf_counter()
        await self.lifecycle.begin().call(recover)
        self.status.data.setdefault("timings", {})["recoveryMs"] = (time.perf_counter() - started) * 1000
        await resource.close(self.lifecycle.begin())
        await self.after_recovery()

    async def after_recovery(self):
        """Injection seam for the regression test: no browser accesses beyond this point."""

    async def rescue(self):
        life = self.lifecycle
        if life.rescuing or life.rescued:
            return
        life.rescuing = True
        life.rescued = True
        try:
            resource = life.resources[-1] if life.resources else None
            if resource is None or resource.stage != "session" or not resource.usable():
                self.status.proof("rescue", state="unverified", reason="session page unavailable; local evidence retained")
                return
            async def preserve():
                metrics = await self.metrics(resource.page)
                if metrics["status"] != "stopped":
                    await self.stop(resource.page, "failure-rescue")
                # A pending stop is awaited; never submit a second stop command.
                try:
                    await self.finalize(resource.page)
                except Exception as error:
                    self.status.error("rescue-finalization", error)
                    if self.multipart:
                        try:
                            await life.begin().call(lambda: self.finalize_bundle(resource.page))
                        except Exception as secondary:
                            self.status.error("rescue-bundle", secondary)
                        return
                    # Independent exports may remain usable after an analysis failure.
                    # Never re-export a complete archive already attested at this bound.
                    for control, operation in (
                        ("journal-binary", lambda: self.download(resource.page,
                            resource.page.get_by_role("button", name="JSONL", exact=True), "journal-final.jsonl")),
                        ("archive", lambda: self.shots(resource.page, "shots-final.json")),
                    ):
                        if not self.status.has_proof(control) and resource.usable():
                            try:
                                path = await life.begin().call(operation)
                                if control == "archive":
                                    self.status.proof(control, [path], self.collector.journal_sequence)
                                else:
                                    self.verify_journal(path, require_verified=False)
                            except Exception as secondary:
                                self.status.error("rescue-" + control, secondary)
            await life.begin().call(preserve)
        except Exception as error:
            self.status.error("rescue", error)
        finally:
            life.rescuing = False

    async def run(self, playwright, *, guarded=False):
        self.status.publish()
        try:
            if guarded:
                await self.run_browser(playwright)
            else:
                await asyncio.wait_for(self.run_browser(playwright), self.args.safety_seconds)
        except (Exception, asyncio.CancelledError) as error:
            self.status.error(self.status.data["phase"], error)
            try:
                self.status.publish()
            except Exception as secondary:
                self.status.error("rescue-publication", secondary)
            try:
                await self.rescue()
            except Exception as secondary:
                self.status.error("rescue", secondary)
        finally:
            # The global guard can expire after browser work, while cleanup is
            # already closing a context. Keep that unique cleanup task alive.
            cleanup = asyncio.create_task(self.lifecycle.cleanup(self.status))
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError as error:
                self.status.error("cleanup-safety", error)
                await cleanup
                await self.rescue()
        return self.status.finish()


async def main(args):
    from playwright.async_api import async_playwright
    driver = Driver(args)
    def cancel(*_):
        driver.cancelled = True
    for sig in (signal.SIGINT, signal.SIGTERM, *([signal.SIGBREAK] if hasattr(signal, "SIGBREAK") else [])):
        signal.signal(sig, cancel)
    driver.status.publish()
    run_entered = False
    async def managed():
        nonlocal run_entered
        async with async_playwright() as playwright:
            run_entered = True
            # main owns the sole guard, including Playwright startup.
            return await driver.run(playwright, guarded=True)
    try:
        return await asyncio.wait_for(managed(), args.safety_seconds)
    except Exception as error:
        if not run_entered:
            driver.status.error("browser-runtime", error)
            await driver.lifecycle.cleanup(driver.status)
            return driver.status.finish()
        return driver.status.data.get("expectedExitCode", 1)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(arguments())))
