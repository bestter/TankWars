"""Native byte streams, bounded catalogs and line rotation. No business JSON rewriting."""
import hashlib
import json
import os
import tempfile
from pathlib import Path

LIMIT = 20 * 1048576


def safe(root, name):
    target = (root / name).resolve()
    if not target.is_relative_to(root.resolve()) or ".." in Path(name).parts or Path(name).is_absolute():
        raise ValueError("INVALID_STREAM_PATH")
    return target


class Multipart:
    def __init__(self, root, name="journal", limit=LIMIT, prefix="part", extension="jsonl"):
        if type(limit) is not int or limit <= 0:
            raise ValueError("INVALID_PART_SIZE")
        self.root, self.name, self.limit = Path(root), name, limit
        self.prefix, self.extension = prefix, extension
        (self.root / name).mkdir(parents=True, exist_ok=True)
        self.part = 0
        self.stream = None
        self.size = self.total = self.entries = self.pages = self.checkpoints = 0
        self.digest, self.part_digest = hashlib.sha256(), hashlib.sha256()
        self.refs = []

    def append(self, record):
        if not record.endswith(b"\n"):
            raise ValueError("RECORD_REQUIRES_LF")
        if self.size and self.size + len(record) > self.limit:
            self.close_part()
        if self.stream is None:
            self.part += 1
            self.stream = (self.root / self.part_path()).open("xb")
        self.stream.write(record)
        self.size += len(record)
        self.total += len(record)
        self.entries += 1
        self.digest.update(record)
        self.part_digest.update(record)
        if self.size > self.limit:
            self.close_part()

    def close_part(self):
        if self.stream is None:
            return
        self.stream.flush()
        os.fsync(self.stream.fileno())
        self.stream.close()
        self.refs.append(dict(path=self.part_path(), bytes=self.size,
                              sha256=self.part_digest.hexdigest(), oversized=self.size > self.limit))
        self.stream = None
        self.size = 0
        self.part_digest = hashlib.sha256()
        if len(self.refs) == 256:
            self.flush_catalog()

    def part_path(self):
        return f"{self.name}/{self.prefix}-{self.part:06d}.{self.extension}"

    def flush_catalog(self):
        if not self.refs:
            return
        self.pages += 1
        path = self.root / self.name / f"catalog-{self.pages:06d}.json"
        path.write_text(json.dumps(dict(files=self.refs), ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
        self.refs = []

    def snapshot(self):
        self.close_part()
        self.flush_catalog()
        self.checkpoints += 1
        path = self.root / self.name / f"checkpoint-{self.checkpoints:06d}.stream.json"
        path.write_text(json.dumps(dict(format="tankwars-byte-stream", schemaVersion=1, directory=self.name,
            pages=self.pages, bytes=self.total, sha256=self.digest.hexdigest(), entries=self.entries)) + "\n", encoding="utf-8", newline="\n")
        return path


def stream_references(path):
    path = Path(path)
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("format") != "tankwars-byte-stream" or data.get("schemaVersion") != 1:
        raise ValueError("UNSUPPORTED_BYTE_STREAM")
    root = path.parent.parent
    for number in range(1, data["pages"] + 1):
        page = safe(root, f'{data["directory"]}/catalog-{number:06d}.json')
        refs = json.loads(page.read_text(encoding="utf-8"))["files"]
        if len(refs) > 256:
            raise ValueError("INVALID_STREAM_CATALOG")
        for ref in refs:
            yield root, ref


def chunks(path, skip_header=False, prefix=None):
    path = Path(path)
    if path.name.endswith(".stream.json"):
        if skip_header:
            raise ValueError("STREAM_HEADER_IS_SEPARATE")
        remaining = prefix
        for root, ref in stream_references(path):
            digest, size = hashlib.sha256(), 0
            with safe(root, ref["path"]).open("rb") as stream:
                while block := stream.read(65536):
                    digest.update(block)
                    size += len(block)
                    if remaining is None:
                        yield block
                    elif remaining > 0:
                        yield block[:remaining]
                        remaining -= min(remaining, len(block))
            if size != ref["bytes"] or digest.hexdigest() != ref["sha256"]:
                raise ValueError("STREAM_PART_CHANGED")
        if remaining not in (None, 0):
            raise ValueError("ATTESTED_PREFIX_MISSING")
    else:
        with path.open("rb") as stream:
            if skip_header and not stream.readline().endswith(b"\n"):
                raise ValueError("NATIVE_HEADER_NOT_LF_TERMINATED")
            remaining = prefix
            while remaining is None or remaining > 0:
                block = stream.read(65536 if remaining is None else min(65536, remaining))
                if not block:
                    break
                yield block
                if remaining is not None:
                    remaining -= len(block)
            if remaining not in (None, 0):
                raise ValueError("ATTESTED_PREFIX_MISSING")


def compare_streams(a, b, skip_b_header=False):
    """Compare native bytes even when physical part/chunk boundaries differ."""
    left, right = iter(chunks(a)), iter(chunks(b, skip_b_header))
    x = y = b""
    digest = hashlib.sha256()
    while True:
        if not x:
            x = next(left, b"")
        if not y:
            y = next(right, b"")
        if not x or not y:
            return (True, digest.hexdigest()) if not x and not y else (False, "BYTES_DIFFER")
        length = min(len(x), len(y))
        if x[:length] != y[:length]:
            return False, "BYTES_DIFFER"
        digest.update(x[:length])
        x, y = x[length:], y[length:]


class TechnicalLog:
    """Drain immediately; spool a physical line to disk, including a missing final LF."""
    def __init__(self, root, limit=LIMIT):
        self.parts = Multipart(root, "technical", limit, "process", "log")
        self.line = tempfile.TemporaryFile(mode="w+b")
        self.length = 0
        self.incomplete = False

    def feed(self, data):
        start = 0
        for index, byte in enumerate(data):
            if byte == 10:
                self.line.write(data[start:index + 1])
                self.length += index + 1 - start
                self.flush_line()
                start = index + 1
        self.line.write(data[start:])
        self.length += len(data) - start

    def flush_line(self):
        if not self.length:
            return
        writer = self.parts
        if writer.size and writer.size + self.length > writer.limit:
            writer.close_part()
        if writer.stream is None:
            writer.part += 1
            writer.stream = (writer.root / writer.part_path()).open("xb")
        self.line.seek(0)
        while block := self.line.read(65536):
            writer.stream.write(block)
            writer.part_digest.update(block)
            writer.digest.update(block)
            writer.size += len(block)
            writer.total += len(block)
        writer.entries += 1
        self.line.seek(0)
        self.line.truncate()
        self.length = 0
        if writer.size > writer.limit:
            writer.close_part()

    def close(self):
        self.incomplete = self.length > 0
        self.flush_line()
        self.line.close()
        path = self.parts.snapshot()
        return dict(manifest=str(path), incompleteLine=self.incomplete)
