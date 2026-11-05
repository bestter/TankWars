"""Shared evidence-first result protocol. No browser or process is started on import."""
import hashlib
import json
import math
import os
import sys
import traceback
import uuid
from multipart import chunks, Multipart
from datetime import datetime, timezone
from pathlib import Path

CODES = {"completed": 0, "protected-stop": 2, "interrupted": 3, "error": 1}
LABELS = {"completed": "Terminé / Completed", "protected-stop": "Écourté par protection / Protected stop",
          "interrupted": "Interrompu / Interrupted", "error": "Erreur / Error"}
REQUIRED = {"build", "configuration", "closure", "journal", "archive", "journal-binary",
            "recovered-journal", "recovered-archive", "recovered-summary"}


def now():
    return datetime.now(timezone.utc).isoformat()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def positive(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def targets(duration_ms, blocks):
    require(type(duration_ms) is int and 0 < duration_ms <= 9007199254740991, "POSITIVE_DURATION_REQUIRED")
    require(blocks is None or type(blocks) is int and blocks > 0, "INVALID_COMPLETED_BLOCKS_TARGET")
    return {"durationMs": duration_ms, "completedBlocks": blocks}


def objective(requested, duration, completed):
    duration_reached = None if duration is None else duration >= requested["durationMs"]
    blocks_reached = False if requested["completedBlocks"] is None else (None if completed is None else completed >= requested["completedBlocks"])
    reached = True if duration_reached is True or blocks_reached is True else (None if duration_reached is None or blocks_reached is None else False)
    return dict(durationReached=duration_reached, completedBlocksReached=blocks_reached, objectiveReached=reached)


def fingerprint(path, prefix_bytes=None):
    digest = hashlib.sha256()
    remaining = prefix_bytes
    total = 0
    for chunk in chunks(path, prefix=remaining):
        digest.update(chunk)
        total += len(chunk)
    result = {"path": str(Path(path).resolve()), "bytes": total, "sha256": digest.hexdigest()}
    if prefix_bytes is not None:
        result["prefix"] = True
    return result


def atomic(path, text):
    path = Path(path)
    candidate = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with candidate.open("w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        candidate.replace(path)
    finally:
        candidate.unlink(missing_ok=True)


class Status:
    def __init__(self, output, requested, run_id=None):
        self.output = Path(output)
        self.output.mkdir(parents=True, exist_ok=True)
        self.history = Multipart(self.output, "evidence-" + uuid.uuid4().hex)
        self.data = dict(schemaVersion=2, runId=run_id or uuid.uuid4().hex, phase="preparation", result=None,
                         nativeReason=None, trigger=None, sessionId=None, stoppedAtDurationMs=None,
                         counters=None, requested=requested, proofs=[], primaryError=None, secondaryErrors=[], warnings=[],
                         expectedExitCode=None, **objective(requested, None, None))

    def error(self, stage, error):
        record = dict(stage=stage, type=type(error).__name__, message=str(error), at=now(),
                      traceback="".join(traceback.format_exception(error)))
        if self.data["primaryError"] is None:
            self.data["primaryError"] = record
        else:
            self.data["secondaryErrors"].append(record)
            self.data["secondaryErrors"] = self.data["secondaryErrors"][-64:]
        self.retain("error", record)
        self.data.update(result=None, expectedExitCode=None)
        print(json.dumps(record, ensure_ascii=False), file=sys.stderr, flush=True)

    def proof(self, control, files=(), sequence=None, state="verified", reason=None, prefix_bytes=None,
              prefix_sha256=None, publish=True):
        recorded = [fingerprint(p, prefix_bytes) if prefix_sha256 is None else
                    dict(path=str(Path(p).resolve()), bytes=prefix_bytes, sha256=prefix_sha256, prefix=True) for p in files]
        proof = dict(control=control, sessionId=self.data["sessionId"],
            stage=self.data["phase"], at=now(), state=state, files=recorded,
            sequence=sequence, sequenceReason="not a journal control" if sequence is None else None, reason=reason)
        # Retain the first and latest immutable cursor checkpoints. Milestones
        # and failures are never compacted.
        if control in ("raw-copy", "ledger-prefix") and state == "verified":
            checkpoints = [p for p in self.data["proofs"] if p["control"] == control and
                           p["sessionId"] == proof["sessionId"] and p["state"] == "verified"]
            if len(checkpoints) >= 2:
                self.data["proofs"] = [p for p in self.data["proofs"] if p is not checkpoints[-1]]
        self.data["proofs"].append(proof)
        self.retain("proof", proof)
        matching = [p for p in self.data["proofs"] if p["control"] == control and p["state"] == state and p["sessionId"] == proof["sessionId"]]
        if len(matching) > 2:
            self.data["proofs"] = [p for p in self.data["proofs"] if p is not matching[-2]]
        if publish:
            self.publish()

    def warning(self, stage, error):
        record = dict(stage=stage, type=type(error).__name__, message=str(error), at=now())
        self.data["warnings"].append(record)
        self.data["warnings"] = self.data["warnings"][-64:]
        self.retain("warning", record)
        print(json.dumps(record, ensure_ascii=False), file=sys.stderr, flush=True)

    def retain(self, kind, record):
        self.history.append((json.dumps(dict(kind=kind, record=record), ensure_ascii=False) + "\n").encode("utf-8"))
        self.data["evidence"] = str(self.history.snapshot().relative_to(self.output))

    def has_proof(self, control):
        for p in reversed(self.data["proofs"]):
            if (p["control"] == control and p["sessionId"] == self.data["sessionId"] and
                    (p["sequence"] is None or p["sequence"] == self.data.get("journalCopied"))):
                return p["state"] == "verified"
        return False

    def check_files(self):
        cache = {}
        for proof in list(self.data["proofs"]):
            if proof["state"] != "verified":
                continue
            for recorded in proof["files"]:
                try:
                    key = (recorded["path"], recorded["bytes"] if recorded.get("prefix") else None)
                    if key not in cache:
                        cache[key] = fingerprint(key[0], key[1])
                    require(cache[key] == recorded, "ATTESTED_FILE_CHANGED: " + recorded["path"])
                except Exception as error:
                    self.error("proof-availability", error)
                    self.data["proofs"].append({**proof, "at": now(), "state": "failed", "reason": str(error)})
                    break

    def publish(self):
        self.data["updatedAt"] = now()
        text = json.dumps(self.data, ensure_ascii=False, indent=2) + "\n"
        # Both artifacts embed the exact same result. status.json is the commit marker.
        summary = "# Endurance\n\n" + LABELS.get(self.data["result"], "En cours / In progress") + "\n\n```json\n" + text + "```\n\nSigné : Codex — GPT-6\n"
        try:
            atomic(self.output / "summary.md", summary)
            atomic(self.output / "status.json", text)
        except Exception as error:
            self.error("status-publication", error)
            raise

    def finish(self):
        d = self.data
        self.check_files()
        flags = objective(d["requested"], d["stoppedAtDurationMs"], None if d["counters"] is None else d["counters"]["completed"])
        d.update(flags)
        verified = {control for control in REQUIRED if self.has_proof(control)}
        if d["primaryError"] is None:
            try:
                require(REQUIRED <= verified, "MISSING_REQUIRED_PROOF: " + str(REQUIRED - verified))
                require(d["stoppedAtDurationMs"] is not None, "FROZEN_DURATION_CAPABILITY_REQUIRED")
                reason = d["nativeReason"]
                if reason == "archive-budget":
                    result = "protected-stop"
                elif reason in ("duration", "block-limit", "manual") and flags["objectiveReached"] and (reason != "manual" or d["trigger"] == "objective"):
                    result = "completed"
                elif reason in ("manual", "environment-hidden", "environment-pagehide"):
                    result = "interrupted"
                else:
                    raise ValueError("UNEXPECTED_STOP: " + str(reason))
            except Exception as error:
                self.error("classification", error)
        if d["primaryError"] is not None:
            result = "error"
        d.update(phase="end", result=result, expectedExitCode=CODES[result])
        self.publish()
        return CODES[result]
