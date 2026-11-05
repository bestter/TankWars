import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from multipart import Multipart, TechnicalLog, chunks, compare_streams, stream_references
from native import JournalCollector
from model import fingerprint
from test_native import make_page


class MultipartTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_native_utf8_equality_and_different_part_boundaries(self):
        records = [(json.dumps(dict(text="é😀\u2028", n=i), ensure_ascii=False) + "\n").encode() for i in range(7)]
        a = Multipart(self.root, "left", len(records[0]) * 2)
        b = Multipart(self.root, "right", len(records[0]) * 3)
        for record in records:
            a.append(record)
            b.append(record)
        left, right = a.snapshot(), b.snapshot()
        self.assertTrue(compare_streams(left, right)[0])
        self.assertEqual(b"".join(chunks(left)), b"".join(records))
        self.assertGreater(a.part, b.part)
        self.assertEqual(fingerprint(left)["sha256"], hashlib.sha256(b"".join(records)).hexdigest())
        first = next(stream_references(left))[1]
        self.assertEqual(first["bytes"], len(records[0]) * 2)

    def test_oversized_missing_and_changed_parts(self):
        writer = Multipart(self.root, "journal", 8)
        writer.append(b"12345678\n")
        writer.append(b"x\n")
        path = writer.snapshot()
        refs = list(stream_references(path))
        self.assertTrue(refs[0][1]["oversized"])
        target = self.root / refs[0][1]["path"]
        target.write_bytes(b"altered\n")
        with self.assertRaisesRegex(ValueError, "STREAM_PART_CHANGED"):
            list(chunks(path))
        target.unlink()
        with self.assertRaises(FileNotFoundError):
            list(chunks(path))

    def test_raw_copy_advances_before_failed_analysis_with_rotations(self):
        collector = JournalCollector(self.root, part_size=10)
        page = make_page("s", 1, 3, persisted=3)
        def analyze(row):
            if row["sequence"] == 2:
                raise ValueError("analysis")
        with self.assertRaisesRegex(ValueError, "analysis"):
            collector.process_page(page, analyze)
        self.assertEqual(collector.journal_sequence, 3)
        self.assertEqual(collector.verified_sequence, 1)
        self.assertEqual(b"".join(chunks(collector.decisions_file)), page["text"].encode())
        self.assertEqual(fingerprint(collector.decisions_file, collector.verified_bytes)["sha256"], collector.verified_sha256.hexdigest())

    def test_technical_unterminated_line_spools_without_waiting_for_lf(self):
        log = TechnicalLog(self.root, 10)
        log.feed(b"first\n")
        for _ in range(100):
            log.feed(b"0123456789")
        log.feed(b"\nlast")
        meta = log.close()
        self.assertTrue(meta["incompleteLine"])
        self.assertEqual(b"".join(chunks(meta["manifest"])), b"first\n" + b"0123456789" * 100 + b"\nlast")
        paths = [r[1]["path"] for r in stream_references(meta["manifest"])]
        self.assertTrue(all(p.startswith("technical/process-") and p.endswith(".log") for p in paths))

    def test_empty_stream_and_immutable_checkpoints(self):
        writer = Multipart(self.root)
        empty = writer.snapshot()
        self.assertEqual(b"".join(chunks(empty)), b"")
        writer.append(b"one\n")
        first = writer.snapshot()
        writer.append(b"two\n")
        last = writer.snapshot()
        self.assertEqual(b"".join(chunks(first)), b"one\n")
        self.assertEqual(b"".join(chunks(last)), b"one\ntwo\n")
