"""Keep njsscan findings advisory while failing incomplete or invalid scans."""

import json
from pathlib import Path
import subprocess
import sys


def validate_report(report, returncode):
  """Validate the SARIF contract emitted by the pinned njsscan 1.0.1 CLI."""
  if returncode not in (0, 1):
    raise ValueError(f"Unexpected njsscan exit code: {returncode}")
  if not isinstance(report, dict) or report.get("version") != "2.1.0":
    raise ValueError("Expected a SARIF 2.1.0 object")
  runs = report.get("runs")
  if not isinstance(runs, list) or len(runs) != 1:
    raise ValueError("Expected exactly one njsscan run")
  run = runs[0]
  if not isinstance(run, dict):
    raise ValueError("Invalid SARIF run")
  tool = run.get("tool")
  driver = tool.get("driver") if isinstance(tool, dict) else None
  if not isinstance(driver, dict) or driver.get("name") != "nodejsscan":
    raise ValueError("Expected the nodejsscan tool driver")
  invocations = run.get("invocations")
  if not isinstance(invocations, list) or not invocations:
    raise ValueError("Missing scanner execution status")
  if any(not isinstance(item, dict) or item.get("executionSuccessful") is not True
         for item in invocations):
    raise ValueError("njsscan reported an incomplete or failed analysis")
  results = run.get("results")
  if not isinstance(results, list):
    raise ValueError("Missing SARIF results array")
  has_errors = False
  for result in results:
    if not isinstance(result, dict):
      raise ValueError("Invalid SARIF result")
    message = result.get("message")
    if not isinstance(message, dict) or not isinstance(message.get("text"), str):
      raise ValueError("Missing SARIF result message")
    if not isinstance(result.get("ruleId"), str) or not result["ruleId"]:
      raise ValueError("Missing SARIF result ruleId")
    level = result.get("level")
    if level not in ("error", "warning", "note", "none"):
      raise ValueError("Invalid SARIF result level")
    has_errors = has_errors or level == "error"
  # Without --exit-warning, this pinned CLI returns 1 for ERROR findings only
  # when executionSuccessful is true. Do not accept an unexplained failure.
  if (returncode == 1) != has_errors:
    raise ValueError("njsscan exit code disagrees with the SARIF findings")


def run_scan(report_path=Path("results.sarif")):
  try:
    # A previous report must never certify a failed invocation.
    report_path.unlink(missing_ok=True)
    completed = subprocess.run(
      ["njsscan", ".", "--sarif", "--output", str(report_path)], check=False,
    )
    with report_path.open(encoding="utf-8") as report_file:
      report = json.load(report_file)
    validate_report(report, completed.returncode)
  except (OSError, ValueError) as error:
    print(f"njsscan execution check failed: {error}", file=sys.stderr)
    return 1
  print("njsscan completed successfully; findings remain advisory.")
  return 0


if __name__ == "__main__":
  sys.exit(run_scan())
