"""Tests for native collector and binary comparator. Issue #381."""
import hashlib
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from native import (
    JournalCollector,
    compare_binary_journal,
    compare_binary_files,
)


def make_entry_dict(seq: int, session_id: str = "sess-1", **extra):
    return {
        "schemaVersion": 1,
        "sessionId": session_id,
        "sequence": seq,
        "at": "2026-11-04T12:00:00Z",
        "atMs": seq * 100,
        "event": {"kind": "test", **extra},
    }


def make_page(session_id: str, start_seq: int, count: int, persisted: int = 100, **entry_kwargs):
    entries = [make_entry_dict(start_seq + i, session_id, **entry_kwargs) for i in range(count)]
    text = "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in entries)
    raw_bytes = text.encode("utf-8")
    return {
        "status": {
            "schemaVersion": 1,
            "sessionId": session_id,
            "emitted": persisted,
            "persisted": persisted,
            "complete": False,
            "error": None,
        },
        "firstSequence": start_seq if count > 0 else None,
        "lastSequence": (start_seq + count - 1) if count > 0 else None,
        "count": count,
        "bytes": len(raw_bytes),
        "text": text,
    }


class TestNativeCollector(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.tmp_path = Path(self.temp_dir)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_binary_copy_fidelity(self):
        collector = JournalCollector(self.tmp_path)
        # Page with unicode accents and special chars
        page = make_page("sess-1", 1, 5, sample="Montréal & Québec — 💥")
        count, written_bytes = collector.process_page(page)

        self.assertEqual(count, 5)
        self.assertEqual(written_bytes, page["bytes"])
        self.assertEqual(collector.journal_sequence, 5)
        self.assertEqual(collector.copied_bytes, written_bytes)

        # Ensure exact raw UTF-8 bytes were written without CRLF translation
        written_data = (self.tmp_path / "decisions.jsonl").read_bytes()
        self.assertEqual(written_data, page["text"].encode("utf-8"))
        self.assertEqual(collector.sha256.hexdigest(), hashlib.sha256(written_data).hexdigest())

    def test_empty_page_contract(self):
        collector = JournalCollector(self.tmp_path)
        empty_page = {
            "status": {
                "schemaVersion": 1,
                "sessionId": "sess-1",
                "emitted": 10,
                "persisted": 10,
                "complete": True,
                "error": None,
            },
            "firstSequence": None,
            "lastSequence": None,
            "count": 0,
            "bytes": 0,
            "text": "",
        }
        count, written_bytes = collector.process_page(empty_page)
        self.assertEqual(count, 0)
        self.assertEqual(written_bytes, 0)
        self.assertEqual(collector.journal_sequence, 0)

    def test_invalid_metadata_rejected(self):
        collector = JournalCollector(self.tmp_path)
        page = make_page("sess-1", 1, 2)

        # 1. Byte length mismatch
        bad_bytes_page = dict(page, bytes=page["bytes"] + 5)
        with self.assertRaises(ValueError) as ctx:
            collector.process_page(bad_bytes_page)
        self.assertIn("BYTES_MISMATCH", str(ctx.exception))

        # 2. Missing trailing LF
        bad_lf_page = dict(page, text=page["text"].rstrip("\n"), bytes=len(page["text"].rstrip("\n").encode("utf-8")))
        with self.assertRaises(ValueError) as ctx:
            collector.process_page(bad_lf_page)
        self.assertIn("MISSING_TRAILING_LF", str(ctx.exception))

        # 3. Sequence gap
        bad_seq_page = dict(page, firstSequence=2)
        with self.assertRaises(ValueError) as ctx:
            collector.process_page(bad_seq_page)
        self.assertIn("SEQUENCE_GAP", str(ctx.exception))

        # 4. Session ID mismatch
        collector.process_page(page)
        diff_session_page = make_page("sess-2", 3, 2)
        with self.assertRaises(ValueError) as ctx:
            collector.process_page(diff_session_page)
        self.assertIn("SESSION_ID_MISMATCH", str(ctx.exception))

    def test_write_error_preserves_cursor(self):
        collector = JournalCollector(self.tmp_path)
        # Make decisions.jsonl a directory so opening as a file raises an error
        (self.tmp_path / "decisions.jsonl").mkdir()
        page = make_page("sess-1", 1, 3)

        with self.assertRaises(Exception):
            collector.process_page(page)

        # Cursor and SHA-256 must NOT have advanced
        self.assertEqual(collector.journal_sequence, 0)
        self.assertEqual(collector.copied_bytes, 0)

    def test_business_analysis_error_advances_copy_cursor(self):
        collector = JournalCollector(self.tmp_path)
        page = make_page("sess-1", 1, 3)

        def failing_reconcile(row):
            if row["sequence"] == 2:
                raise RuntimeError("RECONCILIATION_BUSINESS_ERROR")

        with self.assertRaises(RuntimeError) as ctx:
            collector.process_page(page, reconcile_fn=failing_reconcile)
        self.assertIn("RECONCILIATION_BUSINESS_ERROR", str(ctx.exception))

        # Crucial requirement: copy cursor and sha256 advanced BEFORE business analysis error
        self.assertEqual(collector.journal_sequence, 3)
        self.assertEqual(collector.copied_bytes, page["bytes"])

        # When next page arrives (e.g. final collection), sequence continues from 4 without duplicates
        page2 = make_page("sess-1", 4, 2)
        count2, written2 = collector.process_page(page2)
        self.assertEqual(count2, 2)
        self.assertEqual(collector.journal_sequence, 5)

        # Check that file contains exactly 5 lines (1..5) without re-writing 1..3
        lines = (self.tmp_path / "decisions.jsonl").read_text(encoding="utf-8").strip().split("\n")
        sequences = [json.loads(line)["sequence"] for line in lines]
        self.assertEqual(sequences, [1, 2, 3, 4, 5])

    def test_strict_binary_comparisons(self):
        copied_path = self.tmp_path / "decisions.jsonl"
        native_path = self.tmp_path / "journal-final.jsonl"

        header = json.dumps({"schemaVersion": 1, "kind": "journal-status", "status": {"complete": True}}) + "\n"
        body_entry1 = json.dumps(make_entry_dict(1, "s1", test="special \u2028 line")) + "\n"
        body_entry2 = json.dumps(make_entry_dict(2, "s1", test="no whitespace strip")) + "\n"

        body_bytes = (body_entry1 + body_entry2).encode("utf-8")
        copied_path.write_bytes(body_bytes)
        native_path.write_bytes(header.encode("utf-8") + body_bytes)

        # Binary comparison strips exact first physical line and checks byte equality
        equal, digest = compare_binary_journal(copied_path, native_path)
        self.assertTrue(equal)
        self.assertEqual(digest, hashlib.sha256(body_bytes).hexdigest())

        # If even a single byte differs, strict equality fails
        corrupted_native = self.tmp_path / "corrupted.jsonl"
        corrupted_native.write_bytes(header.encode("utf-8") + body_bytes + b" ")
        equal_bad, _ = compare_binary_journal(copied_path, corrupted_native)
        self.assertFalse(equal_bad)

        # Binary file compare
        file_a = self.tmp_path / "a.json"
        file_b = self.tmp_path / "b.json"
        file_a.write_bytes(b'{"exact":true}\n')
        file_b.write_bytes(b'{"exact":true}\n')
        self.assertTrue(compare_binary_files(file_a, file_b)[0])
        file_b.write_bytes(b'{"exact":true}\r\n')
        self.assertFalse(compare_binary_files(file_a, file_b)[0])


if __name__ == "__main__":
    unittest.main()
