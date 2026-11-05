"""Cross-platform bounded supervisor; public exit codes follow the shared result protocol."""
import argparse
import json
import os
import signal
import subprocess
import sys
import time
import uuid
import threading
from pathlib import Path
from model import CODES, Status, atomic, positive, require, targets
from multipart import TechnicalLog

WINDOWS = os.name == "nt"


def forward_signal(process, signum):
    if process.poll() is None:
        try:
            process.send_signal(signal.CTRL_BREAK_EVENT if WINDOWS else signum)
        except (ProcessLookupError, OSError):
            pass


def observe(status, raw_code, run_id, intervention=None, terminated=True):
    if not terminated:
        return dict(observation="unknown", result=None, expectedExitCode=None, rawExitCode=raw_code)
    valid = (isinstance(status, dict) and status.get("schemaVersion") == 2 and status.get("runId") == run_id
             and status.get("phase") == "end" and status.get("result") in CODES)
    expected = CODES[status["result"]] if valid else None
    if intervention or not valid or expected != raw_code or status.get("expectedExitCode") != expected:
        return dict(observation="confirmed", result="error", expectedExitCode=1, rawExitCode=raw_code,
                    reason=intervention or "DRIVER_PROTOCOL_ERROR")
    return dict(observation="confirmed", result=status["result"], expectedExitCode=expected, rawExitCode=raw_code)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--safety-seconds", type=float, required=True)
    parser.add_argument("--termination-seconds", type=float, default=10)
    parser.add_argument("driver_args", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    require(positive(args.safety_seconds) and positive(args.termination_seconds), "INVALID_SUPERVISOR_TIMEOUT")
    command = args.driver_args
    if command[:1] == ["--"]:
        command = command[1:]
    from run import arguments
    driver_args = arguments(command)
    require(args.safety_seconds > driver_args.safety_seconds, "EXTERNAL_GUARD_MUST_EXCEED_DRIVER_GUARD")
    output = driver_args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    require(not (output / "status.json").exists(), "OUTPUT_ALREADY_USED")
    run_id = uuid.uuid4().hex
    command += ["--run-id", run_id]
    intervention = None
    started = time.monotonic()
    log = TechnicalLog(output, driver_args.part_size_mib * 1048576)
    drain_errors = []
    def drain(pipe):
        try:
            while data := pipe.read1(65536):
                log.feed(data)
        except Exception as error:
            drain_errors.append(str(error))
        finally:
            pipe.close()
    try:
        process = subprocess.Popen([sys.executable, str(Path(__file__).with_name("run.py")), *command],
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=not WINDOWS,
                                   creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if WINDOWS else 0)
        reader = threading.Thread(target=drain, args=(process.stdout,), daemon=True)
        reader.start()
        def voluntary(signum, _):
            # Forward user cancellation without calling it a safety intervention.
            forward_signal(process, signum)
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, voluntary)
        try:
            raw = process.wait(timeout=args.safety_seconds)
        except subprocess.TimeoutExpired:
            intervention = "supervisor-deadline"
            try:
                if not WINDOWS:
                    os.killpg(process.pid, signal.SIGTERM)
                elif hasattr(process, "send_signal") and hasattr(signal, "CTRL_BREAK_EVENT"):
                    process.send_signal(signal.CTRL_BREAK_EVENT)
                else:
                    process.terminate()
            except (ProcessLookupError, OSError):
                pass
            try:
                raw = process.wait(timeout=args.termination_seconds)
            except subprocess.TimeoutExpired:
                try:
                    if not WINDOWS:
                        os.killpg(process.pid, signal.SIGKILL)
                    else:
                        process.kill()
                except (ProcessLookupError, OSError):
                    pass
                try:
                    raw = process.wait(timeout=args.termination_seconds)
                except subprocess.TimeoutExpired:
                    # The intervention is confirmed, even if death is not yet observable.
                    raw = None
        reader.join(timeout=args.termination_seconds)
        if reader.is_alive():
            intervention = intervention or "technical-drain-timeout"
        if drain_errors:
            intervention = intervention or "technical-drain-failed"
    finally:
        # The daemon cannot be abandoned as a successful run; no positive verdict
        # is possible if inherited pipe handles prevented draining to EOF.
        technical = log.close() if not ('reader' in locals() and reader.is_alive()) else dict(incompleteLine=True, error="drain timeout")
    try:
        state = json.loads((output / "status.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        state = None
    verdict = observe(state, raw, run_id, intervention, terminated=raw is not None)
    if verdict["result"] == "error" and (state is None or state.get("result") != "error" or intervention):
        repaired = Status(output, targets(driver_args.duration_ms, driver_args.completed_blocks), run_id)
        if state is not None and state.get("runId") == run_id:
            repaired.data = state
        repaired.error("supervision", RuntimeError(verdict.get("reason", "DRIVER_PROTOCOL_ERROR")))
        repaired.data["supervision"] = dict(rawExitCode=raw, intervention=intervention)
        try:
            repaired.finish()
        except OSError as error:
            # Keep process-exit independently publishable even when status.json is locked.
            print("SUPERVISOR_STATUS_PUBLICATION_FAILED: " + str(error), file=sys.stderr, flush=True)
    verdict.update(schemaVersion=2, runId=run_id, intervention=intervention, elapsedSeconds=time.monotonic() - started, technical=technical)
    atomic(output / "process-exit.json", json.dumps(verdict, indent=2) + "\n")
    print(json.dumps(verdict))
    return verdict["expectedExitCode"] if type(verdict["expectedExitCode"]) is int else 1


if __name__ == "__main__":
    raise SystemExit(main())
