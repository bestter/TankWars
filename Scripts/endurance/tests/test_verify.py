import json
import tempfile
import unittest
from pathlib import Path
from model import Status, targets
from native import JournalCollector
from verify import archive_manifest, compare, journal, recovery
from test_native import make_page


class VerificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.status = Status(self.root, targets(1, None))
        self.status.data["sessionId"] = "s1"

    def test_empty_native_archive_is_allowed_but_partial_or_wrong_identity_is_not(self):
        data = dict(sessionId="s1", build="build", complete=True, error=None, evicted=0, records=[], terrains=[])
        archive_manifest(data, dict(id="s1", build="build"))
        for fields in [dict(complete=False), dict(error="export failed"), dict(sessionId="s2"), dict(evicted=1)]:
            with self.assertRaises(ValueError):
                archive_manifest({**data, **fields}, dict(id="s1", build="build"))

    def test_journal_closure_requires_all_cursors_and_analysis(self):
        collector = JournalCollector(self.root)
        page = make_page("s1", 1, 2, persisted=2)
        page["status"].update(complete=True, error=None)
        collector.process_page(page)
        journal(page["status"], collector)
        for fields in [dict(complete=False), dict(error="quota"), dict(emitted=3), dict(persisted=3), dict(sessionId="s2")]:
            with self.assertRaises(ValueError):
                journal({**page["status"], **fields}, collector)
        collector.verified_sequence = 1
        with self.assertRaises(ValueError):
            journal(page["status"], collector)

    def test_real_binary_recovery_and_later_failure_preserve_proofs(self):
        session = dict(id="s1", status="stopped", collection="complete", storageError=None,
                       reason="archive-budget", attempted=1, completed=0, abandoned=0, interrupted=1)
        for name in ("final.json", "recovered.json"):
            (self.root / name).write_text(json.dumps(dict(session=session)))
        for name in ("journal-final.jsonl", "recovered.jsonl", "shots-final.json", "recovered-shots.json"):
            (self.root / name).write_bytes(b"identical\n")
        recovery(self.status)
        self.assertEqual(len(self.status.data["proofs"]), 3)
        (self.root / "recovered-shots.json").write_bytes(b"divergent\n")
        with self.assertRaises(ValueError):
            recovery(self.status)
        self.assertEqual(self.status.data["proofs"][1]["state"], "verified")
        self.assertEqual(self.status.data["proofs"][-1]["state"], "failed")

    def test_binary_missing_and_divergent(self):
        a, b = self.root / "a", self.root / "b"
        for raw in (None, b"different"):
            a.write_bytes(b"native")
            if raw is not None:
                b.write_bytes(raw)
            with self.assertRaises(ValueError):
                compare(self.status, "journal-binary", a, b)
            self.assertEqual(self.status.data["proofs"][-1]["state"], "failed")
