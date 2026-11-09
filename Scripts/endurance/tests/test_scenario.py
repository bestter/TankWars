import os
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from run import arguments, ROOT
from verify import scenario_config


class ScenarioTests(unittest.TestCase):
    def setUp(self):
        previous = Path.cwd()
        os.chdir(ROOT)
        self.addCleanup(os.chdir, previous)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = json.loads((ROOT / "Scripts/endurance/config.example.json").read_text(encoding="utf-8"))
        self.config["profiles"] = ["v1-random", "v4-smart"]
        self.scenario = json.loads((ROOT / "Scripts/endurance/scenarios/issue-361-rock-cliff.json").read_text(encoding="utf-8"))

    def parse(self, extra=()):
        config = self.root / "config.json"
        config.write_text(json.dumps(self.config), encoding="utf-8")
        return arguments(["--url", "http://localhost:5173", "--output", str(self.root / "out"),
                          "--expected-build", "test", "--config", str(config), "--duration-ms", "1000",
                          "--safety-seconds", "200", *extra])

    def test_relative_config_and_cli_precedence_use_shared_validator(self):
        path = self.root / "map.json"
        path.write_text(json.dumps(self.scenario), encoding="utf-8")
        self.config["scenario"] = "map.json"
        args = self.parse()
        self.assertEqual(args.scenario_path, path.resolve())
        self.assertEqual(args.scenario_data, self.scenario)
        self.config["scenario"] = "missing.json"
        cli = Path("Scripts/endurance/scenarios/issue-361-rock-cliff.json")
        self.assertEqual(self.parse(["--scenario", str(cli)]).scenario_path, cli.resolve())

    def test_null_absent_malformed_mismatch_and_unreadable(self):
        self.assertIsNone(self.parse().scenario_data)
        self.config["scenario"] = None
        self.assertIsNone(self.parse().scenario_data)
        path = self.root / "map.json"
        self.config["scenario"] = "map.json"
        path.write_text("{", encoding="utf-8")
        with self.assertRaises(SystemExit):
            self.parse()
        path.write_text(json.dumps(self.scenario), encoding="utf-8")
        self.config["profiles"].append("v3-sniper")
        with self.assertRaises(SystemExit):
            self.parse()
        self.config["scenario"] = "missing.json"
        with self.assertRaises(SystemExit):
            self.parse()

    def test_supervisor_rejects_bad_scenario_before_spawning(self):
        from supervise import main
        path = self.root / "bad.json"
        path.write_text("{}", encoding="utf-8")
        config = self.root / "config.json"
        config.write_text(json.dumps(self.config), encoding="utf-8")
        with patch("supervise.subprocess.Popen", wraps=subprocess.Popen) as spawn:
            with self.assertRaises(SystemExit):
                main(["--safety-seconds", "300", "--", "--url", "http://localhost:5173", "--output", str(self.root / "out"),
                      "--expected-build", "test", "--config", str(config), "--duration-ms", "1000", "--safety-seconds", "200",
                      "--scenario", str(path)])
            self.assertTrue(all(call.args[0][0] == "node" for call in spawn.call_args_list))

    def test_export_verification_detects_changed_config_and_positions(self):
        session = {"config": {"scenario": self.scenario, "players": [
            {"tank": {"position": {"x": x, "y": self.scenario["heights"][int(x)]}}} for x in self.scenario["spawnXs"]]}}
        scenario_config(session, self.scenario)
        with self.assertRaises(ValueError):
            scenario_config(session, None)
        session["config"]["players"][1]["tank"]["position"]["x"] = 400
        with self.assertRaises(ValueError):
            scenario_config(session, self.scenario)
