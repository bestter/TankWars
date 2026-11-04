"""Native JSON/JSONL collector and binary comparator. Issue #381."""
import hashlib
import json
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple


class JournalCollector:
    def __init__(self, output_dir: Path, session_id: Optional[str] = None):
        self.output_dir = output_dir
        self.session_id = session_id
        self.journal_sequence = 0
        self.verified_sequence = 0
        self.copied_bytes = 0
        self.sha256 = hashlib.sha256()
        self.journal_counts: Dict[str, int] = {}
        self.latest_status: Optional[Dict[str, Any]] = None
        self.decisions_file = self.output_dir / "decisions.jsonl"

    def process_page(
        self,
        page_result: Dict[str, Any],
        reconcile_fn: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> Tuple[int, int]:
        """Validates page metadata, writes raw UTF-8 bytes in binary mode, advances cursors, then parses."""
        status = page_result.get("status")
        if not status:
            return 0, 0

        # Refuse session change or regression of persisted below copied cursor
        current_session = status["sessionId"]
        if self.session_id is None:
            self.session_id = current_session
        elif self.session_id != current_session:
            raise ValueError(f"SESSION_ID_MISMATCH: expected {self.session_id}, got {current_session}")

        persisted = status["persisted"]
        if persisted < self.journal_sequence:
            raise ValueError(f"JOURNAL_PERSISTED_REGRESSION: {persisted} < {self.journal_sequence}")

        self.latest_status = status

        count = page_result.get("count", 0)
        bytes_count = page_result.get("bytes", 0)
        first_seq = page_result.get("firstSequence")
        last_seq = page_result.get("lastSequence")
        text = page_result.get("text", "")

        # Empty page contract
        if count == 0:
            if text != "" or bytes_count != 0 or first_seq is not None or last_seq is not None:
                raise ValueError("INVALID_EMPTY_PAGE_CONTRACT")
            return 0, 0

        # Validate bytes match text UTF-8 encoding length
        raw_bytes = text.encode("utf-8")
        if len(raw_bytes) != bytes_count:
            raise ValueError(f"BYTES_MISMATCH: text UTF-8 length {len(raw_bytes)} != reported {bytes_count}")

        # Split strictly on LF (not splitlines which splits U+2028/U+2029)
        if not text.endswith("\n"):
            raise ValueError("MISSING_TRAILING_LF")

        lines = text.split("\n")
        if len(lines) != count + 1 or lines[-1] != "":
            raise ValueError(f"LINE_COUNT_MISMATCH: expected {count} lines plus trailing empty, got {len(lines)}")

        if first_seq != self.journal_sequence + 1:
            raise ValueError(f"SEQUENCE_GAP: expected first {self.journal_sequence + 1}, got {first_seq}")
        if last_seq != self.journal_sequence + count:
            raise ValueError(f"SEQUENCE_DISORDER: expected last {self.journal_sequence + count}, got {last_seq}")

        # Step 1: Write binary without BOM, CRLF or transformation
        # Write to actual append file directly or atomic append
        with self.decisions_file.open("ab") as stream:
            stream.write(raw_bytes)
            stream.flush()

        # Step 2: Advance copy cursor and cumulative SHA-256 before business analysis
        self.copied_bytes += len(raw_bytes)
        self.sha256.update(raw_bytes)
        self.journal_sequence = last_seq

        # Step 3: Parse lines with json.loads for business reconciliation
        for expected, line in enumerate(lines[:-1], first_seq):
            row = json.loads(line)
            if row.get("sessionId") != self.session_id:
                raise ValueError(f"ENTRY_SESSION_MISMATCH: {row.get('sessionId')} != {self.session_id}")
            if row.get("sequence") != expected:
                raise ValueError("ENTRY_SEQUENCE_MISMATCH")
            if reconcile_fn:
                reconcile_fn(row)
            self.verified_sequence = expected
            event = row.get("event", {})
            kind = event.get("event", {}).get("kind") if event.get("kind") == "combat" else event.get("kind")
            if kind:
                self.journal_counts[kind] = self.journal_counts.get(kind, 0) + 1

        return count, len(raw_bytes)


def export_native_archive_atomic(
    page: Any,
    output_path: Path,
    button_name: str = "Exporter les tirs",
    timeout_ms: int = 60000,
) -> Dict[str, Any]:
    """Downloads native archive with save_as to a temporary file, then atomically replaces destination."""
    temp_path = output_path.parent / (output_path.name + ".tmp")
    # Ensure details panel is open if present
    button = None
    if hasattr(page, "locator"):
        panel = page.locator("details.diagnostic-panel")
        if panel.count() > 0:
            if not panel.first.evaluate("el => el.open"):
                panel.first.locator("summary").click()
            button = panel.first.get_by_role("button", name=button_name, exact=True)
    if button is None:
        button = page.get_by_role("button", name=button_name, exact=True)

    with page.expect_download(timeout=timeout_ms) as download_info:
        button.click()
    download = download_info.value
    download.save_as(str(temp_path))
    temp_path.replace(output_path)
    data = json.loads(output_path.read_text(encoding="utf-8"))
    return {
        "records": len(data.get("records", [])),
        "terrains": len(data.get("terrains", [])),
        "complete": bool(data.get("complete", False)),
    }


def compare_binary_journal(copied_path: Path, native_jsonl_path: Path) -> Tuple[bool, str]:
    """Compares decisions.jsonl directly with journal-final.jsonl stripped of exactly the first physical LF line."""
    if not copied_path.exists() or not native_jsonl_path.exists():
        return False, "FILE_NOT_FOUND"

    copied_bytes = copied_path.read_bytes()
    with native_jsonl_path.open("rb") as stream:
        # Strip exactly the first physical line
        first_line = stream.readline()
        if not first_line.endswith(b"\n"):
            return False, "NATIVE_HEADER_NOT_LF_TERMINATED"
        native_body = stream.read()

    if copied_bytes != native_body:
        return False, f"BYTES_DIFFER: copied={len(copied_bytes)} vs native={len(native_body)}"
    return True, hashlib.sha256(copied_bytes).hexdigest()


def compare_binary_files(path_a: Path, path_b: Path) -> Tuple[bool, str]:
    """Direct strict binary comparison of two files."""
    if not path_a.exists() or not path_b.exists():
        return False, "FILE_NOT_FOUND"
    bytes_a = path_a.read_bytes()
    bytes_b = path_b.read_bytes()
    if bytes_a != bytes_b:
        return False, f"BYTES_DIFFER: {len(bytes_a)} vs {len(bytes_b)}"
    return True, hashlib.sha256(bytes_a).hexdigest()
