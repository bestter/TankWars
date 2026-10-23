"""Regression tests without installing or executing njsscan."""

import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from njsscan_runner import run_scan, validate_report


def sarif(levels=()):
  return {
    "version": "2.1.0",
    "runs": [{
      "tool": {"driver": {"name": "nodejsscan"}},
      "invocations": [{"executionSuccessful": True}],
      "results": [{"ruleId": "test_rule", "level": level,
                   "message": {"text": "Test finding"}} for level in levels],
    }],
  }


class ReportTests(unittest.TestCase):
  def test_success_and_advisory_findings(self):
    for levels, code in [((), 0), (("warning", "note"), 0),
                         (("error",), 1), (("error", "warning"), 1)]:
      with self.subTest(levels=levels):
        validate_report(sarif(levels), code)

  def test_unexpected_exit_codes(self):
    for code in (-9, 2, 127):
      with self.subTest(code=code), self.assertRaises(ValueError):
        validate_report(sarif(), code)

  def test_exit_code_must_agree_with_findings(self):
    for report, code in [(sarif(), 1), (sarif(("warning",)), 1),
                         (sarif(("error",)), 0)]:
      with self.subTest(code=code), self.assertRaises(ValueError):
        validate_report(report, code)

  def test_invalid_sarif_structure(self):
    for report in [None, [], {}, {"version": "2.0.0"},
                   {"version": "2.1.0", "runs": []},
                   {"version": "2.1.0", "runs": [None]},
                   {"version": "2.1.0", "runs": [{}, {}]}]:
      with self.subTest(report=report), self.assertRaises(ValueError):
        validate_report(report, 0)

  def test_missing_or_failed_execution_evidence(self):
    for invocations in (None, [], [{}], [{"executionSuccessful": False}],
                        [{"executionSuccessful": "true"}],
                        [{"executionSuccessful": True}, {"executionSuccessful": False}]):
      report = sarif()
      report["runs"][0]["invocations"] = invocations
      with self.subTest(invocations=invocations), self.assertRaises(ValueError):
        validate_report(report, 0)

  def test_invalid_tool_and_results(self):
    for field, value in [("tool", None), ("tool", {"driver": {"name": "other"}}),
                         ("results", None), ("results", [None]),
                         ("results", [{}]), ("results", [{"level": "error"}])]:
      report = sarif()
      report["runs"][0][field] = value
      with self.subTest(field=field, value=value), self.assertRaises(ValueError):
        validate_report(report, 0)

  def test_invalid_finding_fields(self):
    for field, value in [("level", "invalid"), ("ruleId", ""),
                         ("message", {}), ("message", {"text": 42})]:
      report = copy.deepcopy(sarif(("warning",)))
      report["runs"][0]["results"][0][field] = value
      with self.subTest(field=field), self.assertRaises(ValueError):
        validate_report(report, 0)


class ExecutionTests(unittest.TestCase):
  def setUp(self):
    self.directory = tempfile.TemporaryDirectory()
    self.addCleanup(self.directory.cleanup)
    self.report_path = Path(self.directory.name) / "results.sarif"

  def scan_with(self, content, code=0):
    def fake_scan(command, check):
      self.assertEqual(command, ["njsscan", ".", "--sarif", "--output", str(self.report_path)])
      self.assertFalse(check)
      if content is not None:
        self.report_path.write_text(content, encoding="utf-8")
      return subprocess.CompletedProcess(command, code)
    with patch("njsscan_runner.subprocess.run", side_effect=fake_scan):
      return run_scan(self.report_path)

  def test_clean_scan(self):
    self.assertEqual(self.scan_with(json.dumps(sarif())), 0)

  def test_advisory_errors_preserve_report(self):
    self.assertEqual(self.scan_with(json.dumps(sarif(("error",))), 1), 0)
    self.assertTrue(self.report_path.is_file())

  def test_launch_failure(self):
    with patch("njsscan_runner.subprocess.run", side_effect=FileNotFoundError("njsscan")):
      self.assertEqual(run_scan(self.report_path), 1)

  def test_missing_report(self):
    self.assertEqual(self.scan_with(None), 1)

  def test_stale_report_cannot_hide_failure(self):
    self.report_path.write_text(json.dumps(sarif()), encoding="utf-8")
    self.assertEqual(self.scan_with(None, 1), 1)
    self.assertFalse(self.report_path.exists())

  def test_invalid_json_is_retained_for_diagnostics(self):
    self.assertEqual(self.scan_with("not JSON"), 1)
    self.assertEqual(self.report_path.read_text(encoding="utf-8"), "not JSON")

  def test_incomplete_scan_is_retained_for_upload(self):
    report = sarif()
    report["runs"][0]["invocations"][0]["executionSuccessful"] = False
    self.assertEqual(self.scan_with(json.dumps(report), 1), 1)
    self.assertTrue(self.report_path.is_file())

  def test_unexpected_exit_with_valid_report(self):
    self.assertEqual(self.scan_with(json.dumps(sarif()), 2), 1)


if __name__ == "__main__":
  unittest.main()
