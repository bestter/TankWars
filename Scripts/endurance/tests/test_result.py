import json
import tempfile
import unittest
from pathlib import Path
from model import REQUIRED, Status, objective, targets
from supervise import observe
from verify import closed_session


class ResultTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def status(self, reason="duration", duration=1000, completed=0, trigger=None):
        status = Status(Path(self.temp.name), targets(1000, 2), "run")
        status.data.update(nativeReason=reason, stoppedAtDurationMs=duration, counters={"completed": completed}, trigger=trigger)
        for name in REQUIRED:
            status.proof(name)
        return status

    def test_thresholds(self):
        for duration, completed, expected in [(999, 1, False), (1000, 0, True), (1001, 0, True), (0, 2, True), (0, 3, True)]:
            with self.subTest(duration=duration, completed=completed):
                self.assertEqual(objective(targets(1000, 2), duration, completed)["objectiveReached"], expected)
        self.assertFalse(objective(targets(1000, None), 999, 999)["objectiveReached"])
        self.assertIsNone(objective(targets(1000, 2), None, None)["objectiveReached"])
        for duration, blocks in [(None, 2), (0, 2), (-1, 2), (float("nan"), 2), (1000, 0), (1000, 1.1), (True, None)]:
            with self.assertRaises(ValueError):
                targets(duration, blocks)

    def test_classification_and_same_summary(self):
        cases = [("duration", 1000, None, 0), ("manual", 999, None, 3), ("manual", 1000, "objective", 0),
                 ("environment-hidden", 1000, None, 3), ("environment-pagehide", 999, None, 3),
                 ("archive-budget", 999, None, 2), ("archive-budget", 1000, None, 2),
                 ("duration", 999, None, 1), ("block-limit", 0, None, 1), ("incident", 1000, None, 1),
                 ("journal-failure", 1000, None, 1), ("storage-failure", 1000, None, 1), ("unknown", 1000, None, 1)]
        for reason, duration, trigger, expected in cases:
            with self.subTest(reason=reason, duration=duration):
                status = self.status(reason, duration, trigger=trigger)
                self.assertEqual(status.finish(), expected)
                saved = json.loads((status.output / "status.json").read_text(encoding="utf-8"))
                self.assertEqual(saved, status.data)
                self.assertIn(json.dumps(saved, ensure_ascii=False, indent=2), (status.output / "summary.md").read_text(encoding="utf-8"))

    def test_error_precedence_and_missing_proofs(self):
        status = self.status("archive-budget")
        status.error("closure", RuntimeError("quota"))
        status.error("cleanup", RuntimeError("secondary"))
        self.assertEqual(status.finish(), 1)

        self.assertEqual(status.data["nativeReason"], "archive-budget")
        self.assertEqual(status.data["primaryError"]["message"], "quota")
        self.assertEqual(len(status.data["secondaryErrors"]), 1)
        for control in REQUIRED:
            status = self.status()
            status.data["proofs"] = [p for p in status.data["proofs"] if p["control"] != control]
            self.assertEqual(status.finish(), 1)
        status = self.status(duration=None)
        self.assertEqual(status.finish(), 1)

    def test_derived_report_warning_preserves_a_verified_result(self):
        status = self.status()
        status.warning("report", RuntimeError("rapport incomplet"))
        self.assertEqual(status.finish(), 0)
        self.assertEqual(status.data["warnings"][0]["stage"], "report")

    def test_stopped_is_not_finalized(self):
        for collection, error in [("incomplete", None), ("complete", "quota")]:
            with self.assertRaises(ValueError):
                closed_session(dict(status="stopped", collection=collection, storageError=error))
        status = Status(Path(self.temp.name), targets(1000, None))
        status.publish()
        self.assertIsNone(status.data["result"])

    def test_supervisor_protocol(self):
        for result, code in [("completed", 0), ("protected-stop", 2), ("interrupted", 3), ("error", 1)]:
            status = dict(schemaVersion=2, runId="run", phase="end", result=result, expectedExitCode=code)
            self.assertEqual(observe(status, code, "run")["result"], result)
            self.assertEqual(observe(status, 137, "run")["reason"], "DRIVER_PROTOCOL_ERROR")
            self.assertEqual(observe(status, code, "old")["result"], "error")
            self.assertEqual(observe(status, code, "run", "supervisor-deadline")["result"], "error")
        self.assertEqual(observe(None, 0, "run")["result"], "error")
        self.assertEqual(observe(None, None, "run", terminated=False)["observation"], "unknown")

    def test_objective_with_partial_measurements_and_strict_duration(self):
        self.assertTrue(objective(targets(1000, None), 1000, None)["objectiveReached"])
        self.assertFalse(objective(targets(1000, None), 999, None)["objectiveReached"])
        self.assertTrue(objective(targets(1000, 2), None, 2)["objectiveReached"])
        self.assertIsNone(objective(targets(1000, 2), 999, None)["objectiveReached"])
        for duration in (1000.0, True, 9007199254740992):
            with self.assertRaises(ValueError):
                targets(duration, None)

    def test_latest_relevant_proof_supersedes_success(self):
        status = self.status()
        status.data.update(sessionId="s", journalCopied=3)
        status.proof("archive", sequence=3)
        status.proof("archive", sequence=2, state="failed")
        self.assertTrue(status.has_proof("archive"))
        status.proof("archive", sequence=3, state="failed")
        self.assertFalse(status.has_proof("archive"))
        status.data["sessionId"] = "other"
        status.proof("archive", sequence=3)
        status.data["sessionId"] = "s"
        self.assertFalse(status.has_proof("archive"))
