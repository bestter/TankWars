"""Required local checks independent of the driver's terminal result."""
import json
from pathlib import Path
from model import require
from native import compare_binary_files, compare_binary_journal


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def closed_session(session):
    require(session["status"] == "stopped" and session["collection"] == "complete" and not session["storageError"], "INCOMPLETE_SESSION")
    counters = {key: session[key] for key in ("attempted", "completed", "abandoned", "interrupted")}
    require(all(type(v) is int and v >= 0 for v in counters.values()), "INVALID_COUNTERS")
    require(counters["attempted"] == sum(counters[k] for k in ("completed", "abandoned", "interrupted")), "INCOHERENT_COUNTERS")
    return counters


def journal(status, collector):
    require(status is not None and status["complete"] is True and not status["error"], "INCOMPLETE_JOURNAL")
    require(status["sessionId"] == collector.session_id, "JOURNAL_SESSION_MISMATCH")
    require(collector.journal_sequence == collector.verified_sequence == status["persisted"] == status["emitted"], "JOURNAL_CURSOR_MISMATCH")


def archive_manifest(data, session):
    require(data["sessionId"] == session["id"] and data["build"] == session["build"], "ARCHIVE_IDENTITY_MISMATCH")
    require(data["complete"] is True and data["error"] is None and data["evicted"] == 0, "INCOMPLETE_ARCHIVE")
    # Deep validation (terrain, record fingerprints, schemas) is done by the repository's
    # validateArchive through validate-archive.mjs, not by a second Python implementation.


def compare(status, control, a, b, strip_header=False):
    equal, detail = (compare_binary_journal if strip_header else compare_binary_files)(a, b)
    status.proof(control, [p for p in (a, b) if p.exists()], status.data.get("journalCopied"),
                 "verified" if equal else "failed", None if equal else detail)
    require(equal, control + ": " + detail)


def recovery(status):
    root = status.output
    compare(status, "recovered-journal", root / "journal-final.jsonl", root / "recovered.jsonl")
    compare(status, "recovered-archive", root / "shots-final.json", root / "recovered-shots.json")
    final = read(root / "final.json")["session"]
    recovered = read(root / "recovered.json")["session"]
    closed_session(recovered)
    require(final == recovered, "RECOVERED_SUMMARY_MISMATCH")
    status.proof("recovered-summary", [root / "final.json", root / "recovered.json"])


def scenario_config(session, expected):
    require(session["config"].get("scenario") == expected, "SCENARIO_CONFIG_MISMATCH")
    if expected is not None:
        players = session["config"]["players"]
        require(len(players) == len(expected["spawnXs"]), "SCENARIO_ROSTER_MISMATCH")
        for player, x in zip(players, expected["spawnXs"]):
            require(player["tank"]["position"] == dict(x=x, y=expected["heights"][int(x)]), "SCENARIO_SPAWN_MISMATCH")
