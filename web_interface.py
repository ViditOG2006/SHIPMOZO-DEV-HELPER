from __future__ import annotations

import asyncio
import csv
import json
from dataclasses import asdict
from dataclasses import dataclass
from pathlib import Path

from flask import Flask
from flask import abort
from flask import redirect
from flask import render_template_string
from flask import request
from flask import send_file
from flask import url_for

from login_change_workflow import OUTPUT_ROOT
from login_change_workflow import _now_id
from login_change_workflow import _run_dir
from login_change_workflow import build_tech_guide
from login_change_workflow import build_login_test_data_csv
from login_change_workflow import build_test_cases_csv
from login_change_workflow import run_login_test_case_suite

app = Flask(__name__)


@dataclass
class WorkflowState:
    run_id: str
    requirement: str
    run_dir: Path
    tech_guide_path: Path
    test_cases_csv_path: Path
    test_data_csv_path: Path | None = None
    test_case_results_csv_path: Path | None = None
    approval_status: str = "pending"
    verification_status: str = "not_run"
    verification_notes: str = ""
    verification_screenshots: list[str] | None = None
    report_path: Path | None = None


RUNS: dict[str, WorkflowState] = {}


PAGE_STYLE = """
<style>
  body { font-family: Arial, sans-serif; margin: 24px; background: #f7f7f7; }
  .card { background: #fff; border-radius: 10px; padding: 18px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
  h1, h2 { margin-top: 0; }
  textarea { width: 100%; min-height: 110px; padding: 10px; }
  input[type=text] { width: 100%; padding: 10px; }
  button { padding: 10px 14px; margin-right: 10px; border: 0; border-radius: 6px; cursor: pointer; }
  .primary { background: #0a66c2; color: #fff; }
  .ok { background: #107c41; color: #fff; }
  .danger { background: #c42b1c; color: #fff; }
  .muted { color: #555; }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  th, td { border: 1px solid #ddd; padding: 8px; font-size: 13px; text-align: left; }
  th { background: #f0f0f0; }
  .mono { font-family: Consolas, monospace; font-size: 12px; }
  a { color: #0a66c2; text-decoration: none; }
  .badge { display: inline-block; padding: 4px 8px; border-radius: 10px; font-size: 12px; background: #eee; }
</style>
"""


def _read_csv_rows(csv_path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with csv_path.open("r", encoding="utf-8") as fp:
        reader = csv.DictReader(fp)
        fieldnames = reader.fieldnames or []
        rows = list(reader)
    return fieldnames, rows


def _merge_case_rows_with_dataset(
    case_fields: list[str],
    case_rows: list[dict[str, str]],
    data_rows: list[dict[str, str]],
) -> tuple[list[str], list[dict[str, str]]]:
    dataset_by_tc = {row.get("TC_ID", ""): row for row in data_rows}
    input_columns = ["Input_EmailOrPhone", "Input_Password", "Input_Notes"]
    merged_fields = list(case_fields)
    for col in input_columns:
        if col not in merged_fields:
            merged_fields.append(col)

    merged_rows: list[dict[str, str]] = []
    for row in case_rows:
        merged = dict(row)
        tc_id = row.get("TC_ID", "")
        ds = dataset_by_tc.get(tc_id, {})
        for col in input_columns:
            if not merged.get(col):
                merged[col] = ds.get(col, "")
        merged_rows.append(merged)
    return merged_fields, merged_rows


def _write_report(state: WorkflowState) -> Path:
    payload = {
        "run_id": state.run_id,
        "requirement": state.requirement,
        "tech_guide_path": str(state.tech_guide_path),
        "test_cases_csv_path": str(state.test_cases_csv_path),
        "test_data_csv_path": str(state.test_data_csv_path) if state.test_data_csv_path else "",
        "test_case_results_csv_path": str(state.test_case_results_csv_path) if state.test_case_results_csv_path else "",
        "approval_status": state.approval_status,
        "verification_status": state.verification_status,
        "verification_notes": state.verification_notes,
        "verification_screenshots": state.verification_screenshots or [],
    }
    report_path = state.run_dir / "workflow_report.json"
    report_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return report_path


@app.get("/")
def home():
    runs = sorted(RUNS.values(), key=lambda s: s.run_id, reverse=True)
    return render_template_string(
        f"""
        {PAGE_STYLE}
        <h1>Login Test Workflow Interface</h1>
        <div class="card">
          <h2>Start New Workflow</h2>
          <form method="post" action="/start">
            <label><b>Requirement</b></label><br/>
            <textarea name="requirement" placeholder="Example: Password now requires 10 chars + 1 special + 1 uppercase"></textarea><br/><br/>
            <button class="primary" type="submit">Generate Tech Guide + CSV</button>
          </form>
        </div>

        <div class="card">
          <h2>Recent Runs</h2>
          {{% if runs %}}
            <ul>
            {{% for run in runs %}}
              <li>
                <a href="{{{{ url_for('run_view', run_id=run.run_id) }}}}">
                  {{{{ run.run_id }}}}
                </a>
                -
                <span class="badge">approval: {{{{ run.approval_status }}}}</span>
                <span class="badge">verification: {{{{ run.verification_status }}}}</span>
              </li>
            {{% endfor %}}
            </ul>
          {{% else %}}
            <p class="muted">No runs yet.</p>
          {{% endif %}}
        </div>
        """,
        runs=runs,
    )


@app.post("/start")
def start_workflow():
    requirement = request.form.get("requirement", "").strip()
    if not requirement:
        return "Requirement cannot be empty.", 400

    run_id = _now_id()
    run_dir = _run_dir(run_id)
    tech_guide = build_tech_guide(requirement, run_dir)
    test_csv = build_test_cases_csv(requirement, run_dir)
    test_data_csv = build_login_test_data_csv(run_dir)

    RUNS[run_id] = WorkflowState(
        run_id=run_id,
        requirement=requirement,
        run_dir=run_dir,
        tech_guide_path=tech_guide,
        test_cases_csv_path=test_csv,
        test_data_csv_path=test_data_csv,
        verification_screenshots=[],
    )
    return redirect(url_for("run_view", run_id=run_id))


@app.get("/run/<run_id>")
def run_view(run_id: str):
    state = RUNS.get(run_id)
    if not state:
        abort(404)

    tech_guide = state.tech_guide_path.read_text(encoding="utf-8")
    fields, rows = _read_csv_rows(state.test_cases_csv_path)
    data_fields: list[str] = []
    data_rows: list[dict[str, str]] = []
    if state.test_data_csv_path and state.test_data_csv_path.exists():
        data_fields, data_rows = _read_csv_rows(state.test_data_csv_path)
    # Always enrich the Test Cases table with concrete input columns
    # so older runs without those columns still display actual inputs.
    fields, rows = _merge_case_rows_with_dataset(fields, rows, data_rows)
    report_link = (
        url_for("artifact", run_id=run_id, filename=state.report_path.name)
        if state.report_path
        else None
    )
    result_fields: list[str] = []
    result_rows: list[dict[str, str]] = []
    if state.test_case_results_csv_path and state.test_case_results_csv_path.exists():
        result_fields, result_rows = _read_csv_rows(state.test_case_results_csv_path)

    return render_template_string(
        f"""
        {PAGE_STYLE}
        <a href="/">← Back</a>
        <h1>Workflow Run: {{{{ state.run_id }}}}</h1>
        <div class="card">
          <p><b>Requirement:</b> {{{{ state.requirement }}}}</p>
          <p>
            <span class="badge">approval: {{{{ state.approval_status }}}}</span>
            <span class="badge">verification: {{{{ state.verification_status }}}}</span>
          </p>
        </div>

        <div class="card">
          <h2>1) Tech Guide</h2>
          <pre class="mono">{{{{ tech_guide }}}}</pre>
          <p>
            <a href="{{{{ url_for('artifact', run_id=state.run_id, filename=state.tech_guide_path.name) }}}}">
              Download tech guide
            </a>
          </p>
        </div>

        <div class="card">
          <h2>2) Test Cases CSV Preview</h2>
          <table>
            <thead>
              <tr>
                {{% for h in fields %}}<th>{{{{ h }}}}</th>{{% endfor %}}
              </tr>
            </thead>
            <tbody>
              {{% for row in rows %}}
              <tr>
                {{% for h in fields %}}<td>{{{{ row[h] }}}}</td>{{% endfor %}}
              </tr>
              {{% endfor %}}
            </tbody>
          </table>
          <p>
            <a href="{{{{ url_for('artifact', run_id=state.run_id, filename=state.test_cases_csv_path.name) }}}}">
              Download CSV
            </a>
          </p>
        </div>

        <div class="card">
          <h2>2b) Concrete Input Dataset (What Will Be Used)</h2>
          {{% if data_rows %}}
          <table>
            <thead>
              <tr>
                {{% for h in data_fields %}}<th>{{{{ h }}}}</th>{{% endfor %}}
              </tr>
            </thead>
            <tbody>
              {{% for row in data_rows %}}
              <tr>
                {{% for h in data_fields %}}<td>{{{{ row[h] }}}}</td>{{% endfor %}}
              </tr>
              {{% endfor %}}
            </tbody>
          </table>
          <p>
            <a href="{{{{ url_for('artifact', run_id=state.run_id, filename=state.test_data_csv_path.name) }}}}">
              Download test-data CSV
            </a>
          </p>
          {{% else %}}
          <p class="muted">Dataset CSV not found for this run.</p>
          {{% endif %}}
        </div>

        <div class="card">
          <h2>3) Approval Gate</h2>
          {{% if state.approval_status == 'pending' %}}
            <form method="post" action="{{{{ url_for('approve_and_run', run_id=state.run_id) }}}}" style="display:inline;">
              <button class="ok" type="submit">Approve & Run Self-Healing Login Test</button>
            </form>
            <form method="post" action="{{{{ url_for('reject_run', run_id=state.run_id) }}}}" style="display:inline;">
              <button class="danger" type="submit">Reject</button>
            </form>
          {{% else %}}
            <p>Approval status: <b>{{{{ state.approval_status }}}}</b></p>
          {{% endif %}}
        </div>

        <div class="card">
          <h2>4) Verification Output</h2>
          <p><b>Status:</b> {{{{ state.verification_status }}}}</p>
          <p><b>Notes:</b> {{{{ state.verification_notes }}}}</p>

          {{% if result_rows %}}
            <h3>Test Case Wise Results</h3>
            <table>
              <thead>
                <tr>
                  {{% for h in result_fields %}}<th>{{{{ h }}}}</th>{{% endfor %}}
                </tr>
              </thead>
              <tbody>
                {{% for row in result_rows %}}
                <tr>
                  {{% for h in result_fields %}}<td>{{{{ row[h] }}}}</td>{{% endfor %}}
                </tr>
                {{% endfor %}}
              </tbody>
            </table>
            <p>
              <a href="{{{{ url_for('artifact', run_id=state.run_id, filename=state.test_case_results_csv_path.name) }}}}">
                Download test-case result CSV
              </a>
            </p>
          {{% endif %}}

          {{% if state.verification_screenshots %}}
            <h3>Screenshots</h3>
            {{% for shot in state.verification_screenshots %}}
              <div style="margin-bottom:16px;">
                <a href="{{{{ url_for('artifact', run_id=state.run_id, filename=Path(shot).name) }}}}">
                  {{{{ Path(shot).name }}}}
                </a><br/>
                <img src="{{{{ url_for('artifact', run_id=state.run_id, filename=Path(shot).name) }}}}" style="max-width:100%; border:1px solid #ddd;" />
              </div>
            {{% endfor %}}
          {{% endif %}}

          {{% if report_link %}}
            <p><a href="{{{{ report_link }}}}">Download workflow report (JSON)</a></p>
          {{% endif %}}
        </div>
        """,
        state=state,
        tech_guide=tech_guide,
        fields=fields,
        rows=rows,
        data_fields=data_fields,
        data_rows=data_rows,
        result_fields=result_fields,
        result_rows=result_rows,
        report_link=report_link,
        Path=Path,
    )


@app.post("/run/<run_id>/approve")
def approve_and_run(run_id: str):
    state = RUNS.get(run_id)
    if not state:
        abort(404)
    if state.approval_status == "approved" and state.verification_status != "not_run":
        return redirect(url_for("run_view", run_id=run_id))

    state.approval_status = "approved"
    status, shots, notes, result_csv = asyncio.run(
        run_login_test_case_suite(state.run_dir, state.test_cases_csv_path)
    )
    state.verification_status = status
    state.verification_notes = notes
    state.verification_screenshots = shots
    state.test_case_results_csv_path = result_csv
    state.report_path = _write_report(state)
    return redirect(url_for("run_view", run_id=run_id))


@app.post("/run/<run_id>/reject")
def reject_run(run_id: str):
    state = RUNS.get(run_id)
    if not state:
        abort(404)
    state.approval_status = "rejected"
    state.verification_status = "not_run"
    state.verification_notes = "Stopped because approval not granted."
    state.verification_screenshots = []
    state.test_case_results_csv_path = None
    state.report_path = _write_report(state)
    return redirect(url_for("run_view", run_id=run_id))


@app.get("/artifact/<run_id>/<filename>")
def artifact(run_id: str, filename: str):
    state = RUNS.get(run_id)
    if not state:
        abort(404)
    target = state.run_dir / filename
    if not target.exists():
        abort(404)
    return send_file(target)


def bootstrap_existing_runs() -> None:
    # Optional: discover previous workflow runs on startup.
    if not OUTPUT_ROOT.exists():
        return
    for run_dir in OUTPUT_ROOT.iterdir():
        if not run_dir.is_dir():
            continue
        run_id = run_dir.name
        guide = run_dir / "login_tech_guide.md"
        csv_path = run_dir / "login_test_cases.csv"
        report = run_dir / "workflow_report.json"
        if not guide.exists() or not csv_path.exists():
            continue

        requirement = "Recovered from existing run"
        approval = "pending"
        ver_status = "not_run"
        notes = ""
        shots: list[str] = []

        if report.exists():
            try:
                payload = json.loads(report.read_text(encoding="utf-8"))
                requirement = payload.get("requirement", requirement)
                approval = payload.get("approval_status", approval)
                ver_status = payload.get("verification_status", ver_status)
                notes = payload.get("verification_notes", "")
                shots = payload.get("verification_screenshots", []) or []
                test_data_csv = payload.get("test_data_csv_path", "")
                results_csv = payload.get("test_case_results_csv_path", "")
            except Exception:
                test_data_csv = ""
                results_csv = ""
                pass

        RUNS[run_id] = WorkflowState(
            run_id=run_id,
            requirement=requirement,
            run_dir=run_dir,
            tech_guide_path=guide,
            test_cases_csv_path=csv_path,
            test_data_csv_path=Path(test_data_csv) if test_data_csv else (run_dir / "login_test_data.csv"),
            approval_status=approval,
            verification_status=ver_status,
            verification_notes=notes,
            verification_screenshots=shots,
            test_case_results_csv_path=Path(results_csv) if results_csv else None,
            report_path=report if report.exists() else None,
        )


if __name__ == "__main__":
    bootstrap_existing_runs()
    app.run(host="127.0.0.1", port=5000, debug=False)
