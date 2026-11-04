"""Reusable native UI driver. Run from the repository root; no historical artifact dependencies."""
import argparse
import asyncio
import json
import re
import signal
from pathlib import Path

from ledger import Ledger
from model import Status, positive, require, targets
from native import JournalCollector
from verify import archive_manifest, closed_session, compare, journal, read, recovery

ROOT = Path(__file__).resolve().parents[2]
PROFILES = {"v1-random", "v2-heuristic", "v3-sniper", "v4-smart"}


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expected-build", required=True, help="Exact session build identity, including timestamp")
    parser.add_argument("--config", type=Path, required=True, help="See config.example.json")
    parser.add_argument("--duration-ms", type=int, required=True)
    parser.add_argument("--completed-blocks", type=int)
    parser.add_argument("--finalization-seconds", type=float, default=120)
    parser.add_argument("--safety-seconds", type=float, required=True)
    parser.add_argument("--run-id")
    args = parser.parse_args(argv)
    try:
        targets(args.duration_ms, args.completed_blocks)
        require(positive(args.finalization_seconds) and positive(args.safety_seconds), "INVALID_TECHNICAL_TIMEOUT")
        require(args.safety_seconds > args.duration_ms / 1000 + args.finalization_seconds, "SAFETY_MUST_INCLUDE_FINALIZATION")
        config = read(args.config)
        require(set(config) == {"profiles", "roundsPerBlock", "archiveBudgetMiB", "freeWeapons", "stopOnIncident", "limits"}, "INVALID_CONFIG_KEYS")
        require(2 <= len(config["profiles"]) <= 4 and all(p in PROFILES for p in config["profiles"]), "INVALID_PROFILES")
        require(type(config["roundsPerBlock"]) is int and config["roundsPerBlock"] > 0, "INVALID_ROUNDS")
        require(type(config["archiveBudgetMiB"]) is int and 64 <= config["archiveBudgetMiB"] <= 4096, "INVALID_ARCHIVE_BUDGET")
        require(type(config["freeWeapons"]) is bool and type(config["stopOnIncident"]) is bool, "INVALID_FLAGS")
        require(set(config["limits"]) == {"turns", "roundMs", "actionMs", "transitionMs"} and
                all(type(v) is int and v > 0 for v in config["limits"].values()), "INVALID_LIMITS")
    except (ValueError, KeyError, TypeError) as error:
        parser.error(str(error))
    args.config_data = config
    return args


class Driver:
    def __init__(self, args):
        self.args = args
        self.status = Status(args.output, targets(args.duration_ms, args.completed_blocks), args.run_id)
        self.collector = JournalCollector(self.status.output)
        self.collector.decisions_file.touch(exist_ok=False)
        self.ledger = Ledger()
        self.cancelled = False
        self.stop_requested = False

    async def metrics(self, page):
        metrics = await page.evaluate("() => window.__tankwarsEnduranceTest.readArchiveMetrics()")
        require("stoppedAtDurationMs" in metrics, "FROZEN_DURATION_CAPABILITY_REQUIRED")
        self.status.data.update(archiveMetrics=metrics, nativeReason=metrics["reason"],
                                stoppedAtDurationMs=metrics["stoppedAtDurationMs"])
        self.status.publish()
        return metrics

    async def collect(self, page, final=False):
        while True:
            result = await page.evaluate("after => window.__tankwarsEnduranceTest.readJournalText(after, 256)", self.collector.journal_sequence)
            count, _ = self.collector.process_page(result, self.ledger)
            meta = result["status"]
            self.status.data.update(journalCopied=self.collector.journal_sequence, journalVerified=self.collector.verified_sequence,
                                    journalStatus=meta, journalSha256=self.collector.sha256.hexdigest())
            self.status.publish()
            require(meta is not None and not meta["error"], "JOURNAL_UNAVAILABLE_OR_FAILED")
            if not count or self.collector.journal_sequence >= meta["persisted"]:
                break
        if final:
            journal(meta, self.collector)
            self.status.proof("journal", [self.collector.decisions_file], self.collector.journal_sequence)

    async def download(self, page, button, filename):
        path = self.status.output / filename
        candidate = path.with_name(path.name + ".candidate")
        async with page.expect_download() as event:
            await button.click()
        download = await event.value
        await download.save_as(candidate)
        require(await download.failure() is None, "DOWNLOAD_FAILED: " + filename)
        if filename.endswith(".json"):
            read(candidate)
        candidate.replace(path)
        return path

    async def summary(self, page, filename="final.json", scope=None):
        scope = scope if scope is not None else page
        return read(await self.download(page, scope.get_by_role("button", name="JSON", exact=True), filename))["session"]

    async def shots(self, page, filename, scope=None):
        if scope is None:
            panel = page.locator("details.diagnostic-panel")
            await panel.evaluate("el => { el.open = true; }")
            scope = panel
        path = await self.download(page, scope.get_by_role("button", name="Exporter les tirs", exact=True), filename)
        archive_manifest(read(path), read(self.status.output / "final.json")["session"])
        process = await asyncio.create_subprocess_exec("node", str(ROOT / "Scripts/endurance/validate-archive.mjs"), str(path.resolve()),
                                                       cwd=ROOT, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            stdout, stderr = await process.communicate()
        except BaseException:
            process.kill(); await process.wait(); raise
        require(process.returncode == 0, "ARCHIVE_VALIDATION: " + stderr.decode(errors="replace"))
        return path

    async def configure(self, page):
        await page.goto(self.args.url)
        await page.get_by_role("button", name="Endurance IA", exact=True).click()
        config = self.args.config_data
        await page.get_by_label(re.compile(r"^NOMBRE DE JOUEURS :")).select_option(str(len(config["profiles"])))
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
            await page.get_by_role("button", name="Arrêter et sauvegarder", exact=True).click()

    async def finalize(self, page):
        self.status.data["phase"] = "finalization"
        await page.get_by_role("button", name="MENU", exact=True).wait_for(state="visible")
        while not await page.get_by_role("button", name="MENU", exact=True).is_enabled():
            await asyncio.sleep(.1)
        metrics = await self.metrics(page)
        require(metrics["status"] == "stopped" and metrics["stoppedAtDurationMs"] is not None, "MISSING_STOP_MEASUREMENT")
        session = await self.summary(page)
        require(session["id"] == self.status.data["sessionId"], "SESSION_CHANGED")
        self.status.data.update(counters=closed_session(session), nativeReason=session["reason"])
        self.status.proof("closure", [self.status.output / "final.json"])
        await self.collect(page, final=True)
        await self.download(page, page.get_by_role("button", name="JSONL", exact=True), "journal-final.jsonl")
        meta = json.loads((self.status.output / "journal-final.jsonl").open(encoding="utf-8").readline())
        require(meta["kind"] == "journal-status" and meta["status"] == self.collector.latest_status, "NATIVE_JOURNAL_STATUS_MISMATCH")
        compare(self.status, "journal-binary", self.collector.decisions_file, self.status.output / "journal-final.jsonl", True)
        await self.shots(page, "shots-final.json")
        self.status.proof("archive", [self.status.output / "shots-final.json"], self.collector.journal_sequence)

    async def launch(self, playwright):
        return await playwright.chromium.launch_persistent_context(str(self.status.output / "browser-profile"),
            headless=True, locale="fr-CA", timezone_id="America/Toronto", accept_downloads=True,
            viewport={"width": 1280, "height": 1000})

    async def run_browser(self, playwright):
        context = await self.launch(playwright)
        try:
            page = await context.new_page()
            await page.add_init_script("localStorage.setItem('i18nextLng', 'fr');")
            await self.configure(page)
            self.status.data["phase"] = "execution"
            while True:
                metrics = await self.metrics(page)
                await self.collect(page)
                if metrics["status"] == "stopped":
                    break
                if self.cancelled:
                    await self.stop(page, "voluntary-signal"); break
                if self.args.completed_blocks is not None:
                    session = await self.summary(page, "progress.json")
                    if session["completed"] >= self.args.completed_blocks:
                        await self.stop(page, "objective"); break
                await asyncio.sleep(.25)
            await asyncio.wait_for(self.finalize(page), self.args.finalization_seconds)
        finally:
            await context.close()
        context = await self.launch(playwright)
        try:
            page = await context.new_page()
            await page.goto(self.args.url)
            await page.get_by_role("button", name="Endurance IA", exact=True).click()
            scope = page.locator(".endurance-screen > p").filter(has_text=self.status.data["sessionId"])
            await scope.wait_for()
            await self.summary(page, "recovered.json", scope)
            await self.download(page, scope.get_by_role("button", name="JSONL", exact=True), "recovered.jsonl")
            await self.shots(page, "recovered-shots.json", scope)
            recovery(self.status)
        finally:
            await context.close()

    async def run(self, playwright):
        self.status.publish()
        try:
            await asyncio.wait_for(self.run_browser(playwright), self.args.safety_seconds)
        except Exception as error:
            self.status.error(self.status.data["phase"], error)
        return self.status.finish()


async def main(args):
    from playwright.async_api import async_playwright
    driver = Driver(args)
    def cancel(*_):
        driver.cancelled = True
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, cancel)
    async with async_playwright() as playwright:
        return await driver.run(playwright)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(arguments())))
