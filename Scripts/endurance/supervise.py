"""Linux-compatible bounded supervisor; public exit codes follow the shared result protocol."""
import argparse
import json
import os
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path
from model import CODES, Status, atomic, positive, require, targets


def observe(status, raw_code, run_id, intervention=None, terminated=True):
    if not terminated:
        return dict(observation="unknown", result=None, expectedExitCode=None, rawExitCode=raw_code)
    valid = (isinstance(status, dict) and status.get("schemaVersion") == 1 and status.get("runId") == run_id
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
    with (output / "process.log").open("w", encoding="utf-8") as log:
        process = subprocess.Popen([sys.executable, str(Path(__file__).with_name("run.py")), *command],
                                   stdout=log, stderr=subprocess.STDOUT, start_new_session=os.name != "nt")
        def voluntary(signum, _):
            # Forward user cancellation without calling it a safety intervention.
            if process.poll() is None:
                process.send_signal(signum)
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, voluntary)
        try:
            raw = process.wait(timeout=args.safety_seconds)
        except subprocess.TimeoutExpired:
            intervention = "supervisor-deadline"
            if os.name != "nt":
                os.killpg(process.pid, signal.SIGTERM)
            else:
                process.terminate()
            try:
                raw = process.wait(timeout=args.termination_seconds)
            except subprocess.TimeoutExpired:
                if os.name != "nt":
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
                try:
                    raw = process.wait(timeout=args.termination_seconds)
                except subprocess.TimeoutExpired:
                    # The intervention is confirmed, even if death is not yet observable.
                    raw = None
    try:
        state = json.loads((output / "status.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        state = None
    verdict = observe(state, raw, run_id, intervention)
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
    verdict.update(runId=run_id, intervention=intervention, elapsedSeconds=time.monotonic() - started)
    atomic(output / "process-exit.json", json.dumps(verdict, indent=2) + "\n")
    with (output / "process.log").open("a", encoding="utf-8") as log:
        log.write(json.dumps(verdict) + "\n")
    print(json.dumps(verdict))
    return verdict["expectedExitCode"]


if __name__ == "__main__":
    raise SystemExit(main())
