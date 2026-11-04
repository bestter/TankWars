import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from supervise import main


class SupervisorTests(unittest.TestCase):
    def test_process_codes_and_external_intervention(self):
        for raw, intervene in [(0, False), (2, False), (3, False), (1, False), (0, True), (137, False)]:
            with self.subTest(raw=raw, intervene=intervene), tempfile.TemporaryDirectory() as temp:
                output = Path(temp)
                result = {0: "completed", 2: "protected-stop", 3: "interrupted", 1: "error"}.get(raw, "completed")
                class Process:
                    pid = 123
                    calls = 0
                    def __init__(self, command, **_):
                        run_id = command[command.index("--run-id") + 1]
                        state = dict(schemaVersion=1, runId=run_id, phase="end", result=result,
                                     expectedExitCode=raw if raw != 137 else 0, requested=dict(durationMs=1, completedBlocks=None),
                                     proofs=[], primaryError=None, secondaryErrors=[], warnings=[], stoppedAtDurationMs=1, counters={"completed": 0})
                        (output / "status.json").write_text(json.dumps(state))
                    def wait(self, timeout):
                        self.calls += 1
                        if intervene and self.calls == 1:
                            raise subprocess.TimeoutExpired("driver", timeout)
                        return raw
                    def terminate(self):
                        pass
                args = ["--safety-seconds", "4", "--", "--url", "http://localhost/", "--output", temp,
                        "--expected-build", "build", "--config", str(Path(__file__).resolve().parents[1] / "config.example.json"),
                        "--duration-ms", "1", "--finalization-seconds", "1", "--safety-seconds", "3"]
                with patch("supervise.subprocess.Popen", Process), patch("supervise.signal.signal"), patch("supervise.os.killpg", create=True):
                    code = main(args)
                expected = 1 if intervene or raw == 137 else raw
                self.assertEqual(code, expected)
                observed = json.loads((output / "process-exit.json").read_text())
                self.assertEqual(observed["rawExitCode"], raw)
                self.assertEqual(observed["expectedExitCode"], expected)
                if intervene:
                    self.assertEqual(observed["intervention"], "supervisor-deadline")
