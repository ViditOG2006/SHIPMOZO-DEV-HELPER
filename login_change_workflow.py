from __future__ import annotations

import asyncio
import csv
import json
import textwrap
from dataclasses import asdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from playwright.async_api import async_playwright

from shipmozo_login import EMAIL
from shipmozo_login import LOGIN_URLS
from shipmozo_login import PASSWORD
from shipmozo_login import async_login_and_save_state
from shipmozo_login import first_visible
from shipmozo_login import is_logged_in

OUTPUT_ROOT = Path("output") / "workflow"
OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)


@dataclass
class WorkflowArtifacts:
    run_id: str
    requirement: str
    tech_guide_path: str
    test_cases_csv_path: str
    test_data_csv_path: str
    test_case_results_csv_path: str
    approval_status: str
    verification_screenshots: list[str]
    verification_status: str
    notes: str


def _now_id() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def _run_dir(run_id: str) -> Path:
    path = OUTPUT_ROOT / run_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def build_tech_guide(requirement: str, run_dir: Path) -> Path:
    guide = textwrap.dedent(
        f"""
        # Login Page Tech Guide

        ## Requirement Received
        {requirement}

        ## Current Login Flow (System View)
        1. Open one of the login panel URLs:
           - {LOGIN_URLS[0]}
           - {LOGIN_URLS[1]}
        2. Detect login state using URL/dashboard markers.
        3. Locate login inputs with self-healing selectors:
           - Email/Phone field (email/tel/username/placeholder/aria-label based)
           - Password field (password/name/placeholder/aria-label based)
        4. Fill credentials and click login using resilient button matching.
        5. Verify login completion with dashboard URL hint + markers.
        6. Persist state + screenshot for downstream scripts.

        ## Login Components To Consider For Change
        - Input selectors (`type`, `name`, `placeholder`, `aria-label`)
        - Password validation rules (format, length, special chars)
        - Error messages and helper text behavior
        - Submit button labels/states (disabled/loading variants)
        - Post-login redirect conditions

        ## Developer Change Plan
        1. Update login page UI/validation code for the requirement.
        2. Ensure server/API validation is aligned.
        3. Keep client-side error message deterministic for automation checks.
        4. If labels/placeholders changed, update self-healing selectors in automation scripts.
        5. Re-run login automation smoke.

        ## Self-Healing Update Checklist (Automation)
        - [ ] Add new selector variants for changed fields.
        - [ ] Add/adjust validation-error detection for new password policy.
        - [ ] Keep fallback URL list current.
        - [ ] Re-capture baseline screenshots.

        ## Acceptance Criteria
        - Login automation succeeds for valid credentials.
        - Invalid password scenarios surface expected message(s).
        - Storage state persists for downstream order scripts.
        """
    ).strip()
    path = run_dir / "login_tech_guide.md"
    path.write_text(guide, encoding="utf-8")
    return path


def build_test_cases_csv(requirement: str, run_dir: Path) -> Path:
    # Login-only, password-structure-aware baseline scenarios.
    rows = [
        {
            "TC_ID": "LGN-001",
            "Scenario": "Valid login with compliant password",
            "Type": "Positive",
            "Priority": "P0",
            "Preconditions": "Active account exists",
            "Steps": "Open login page -> Enter valid email/phone -> Enter valid password -> Click Login",
            "Test_Data": "email/phone valid, password compliant",
            "Input_EmailOrPhone": EMAIL,
            "Input_Password": PASSWORD,
            "Input_Notes": "Uses current valid credential pair",
            "Expected_Result": "User lands on dashboard, session created",
        },
        {
            "TC_ID": "LGN-002",
            "Scenario": "Reject password below minimum length",
            "Type": "Negative",
            "Priority": "P0",
            "Preconditions": "Password policy enabled",
            "Steps": "Open login -> Enter valid user -> Enter short password -> Click Login",
            "Test_Data": "password shorter than policy",
            "Input_EmailOrPhone": EMAIL,
            "Input_Password": "Ab1@x",
            "Input_Notes": "Intentionally short password",
            "Expected_Result": "Inline/API error shown, login blocked",
        },
        {
            "TC_ID": "LGN-003",
            "Scenario": "Reject password without required character class",
            "Type": "Negative",
            "Priority": "P0",
            "Preconditions": "Password policy enabled",
            "Steps": "Open login -> Enter valid user -> Enter non-compliant password -> Click Login",
            "Test_Data": "missing required uppercase/lowercase/number/special",
            "Input_EmailOrPhone": EMAIL,
            "Input_Password": "alllowercasepassword",
            "Input_Notes": "Missing uppercase/number/special",
            "Expected_Result": "Validation error shown, login blocked",
        },
        {
            "TC_ID": "LGN-004",
            "Scenario": "Valid login after policy update",
            "Type": "Positive",
            "Priority": "P0",
            "Preconditions": "Policy updated and deployed",
            "Steps": "Use password that exactly matches new policy and login",
            "Test_Data": "new-format password",
            "Input_EmailOrPhone": EMAIL,
            "Input_Password": PASSWORD,
            "Input_Notes": "Replace with updated policy-compliant password when changed",
            "Expected_Result": "Login succeeds, redirected to dashboard",
        },
        {
            "TC_ID": "LGN-005",
            "Scenario": "Password field masks input",
            "Type": "UI",
            "Priority": "P2",
            "Preconditions": "Login page accessible",
            "Steps": "Type password in password field",
            "Test_Data": "any string",
            "Input_EmailOrPhone": "",
            "Input_Password": "MaskCheck@123",
            "Input_Notes": "Visual/attribute check only",
            "Expected_Result": "Characters are masked",
        },
        {
            "TC_ID": "LGN-006",
            "Scenario": "Error clears after correcting password",
            "Type": "UX",
            "Priority": "P1",
            "Preconditions": "Error shown for invalid password",
            "Steps": "Enter invalid password -> trigger error -> replace with valid -> submit",
            "Test_Data": "invalid then valid password",
            "Input_EmailOrPhone": EMAIL,
            "Input_Password": "Invalid@1 -> valid password",
            "Input_Notes": "Two-step validation-recovery flow",
            "Expected_Result": "Error clears and login succeeds",
        },
    ]

    path = run_dir / "login_test_cases.csv"
    fieldnames = list(rows[0].keys())
    with path.open("w", newline="", encoding="utf-8") as fp:
        writer = csv.DictWriter(fp, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    return path


def build_login_test_data_csv(run_dir: Path) -> Path:
    rows = [
        {
            "DATASET_ID": "LGN-DATA-001",
            "TC_ID": "LGN-001",
            "Input_EmailOrPhone": EMAIL,
            "Input_Password": PASSWORD,
            "Expected_Outcome": "login_success",
            "Expected_Message": "dashboard_redirect",
            "Notes": "Baseline valid login credential",
        },
        {
            "DATASET_ID": "LGN-DATA-002",
            "TC_ID": "LGN-002",
            "Input_EmailOrPhone": EMAIL,
            "Input_Password": "Ab1@x",
            "Expected_Outcome": "login_blocked",
            "Expected_Message": "password_too_short",
            "Notes": "Length below policy",
        },
        {
            "DATASET_ID": "LGN-DATA-003",
            "TC_ID": "LGN-003",
            "Input_EmailOrPhone": EMAIL,
            "Input_Password": "alllowercasepassword",
            "Expected_Outcome": "login_blocked",
            "Expected_Message": "missing_required_character_class",
            "Notes": "No uppercase/no special/no digit",
        },
        {
            "DATASET_ID": "LGN-DATA-004",
            "TC_ID": "LGN-003",
            "Input_EmailOrPhone": EMAIL,
            "Input_Password": "ALLUPPERCASE123",
            "Expected_Outcome": "login_blocked",
            "Expected_Message": "missing_required_character_class",
            "Notes": "No lowercase/no special",
        },
        {
            "DATASET_ID": "LGN-DATA-005",
            "TC_ID": "LGN-003",
            "Input_EmailOrPhone": EMAIL,
            "Input_Password": "NoSpecial123",
            "Expected_Outcome": "login_blocked",
            "Expected_Message": "missing_required_character_class",
            "Notes": "No special character",
        },
        {
            "DATASET_ID": "LGN-DATA-006",
            "TC_ID": "LGN-004",
            "Input_EmailOrPhone": EMAIL,
            "Input_Password": PASSWORD,
            "Expected_Outcome": "login_success",
            "Expected_Message": "dashboard_redirect",
            "Notes": "Use this after policy update with compliant password",
        },
        {
            "DATASET_ID": "LGN-DATA-007",
            "TC_ID": "LGN-005",
            "Input_EmailOrPhone": "",
            "Input_Password": "MaskCheck@123",
            "Expected_Outcome": "ui_validation",
            "Expected_Message": "password_field_masked",
            "Notes": "UI-only dataset for mask check",
        },
        {
            "DATASET_ID": "LGN-DATA-008",
            "TC_ID": "LGN-006",
            "Input_EmailOrPhone": EMAIL,
            "Input_Password": "Invalid@1 -> " + PASSWORD,
            "Expected_Outcome": "error_then_success",
            "Expected_Message": "error_clears_then_dashboard_redirect",
            "Notes": "Two-step recovery flow",
        },
    ]
    path = run_dir / "login_test_data.csv"
    with path.open("w", newline="", encoding="utf-8") as fp:
        writer = csv.DictWriter(fp, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    return path


def print_csv_preview(csv_path: Path, max_rows: int = 10) -> None:
    print("\n=== CSV PREVIEW ===")
    with csv_path.open("r", encoding="utf-8") as fp:
        for idx, line in enumerate(fp):
            print(line.rstrip())
            if idx >= max_rows:
                print("... (truncated)")
                break
    print("===================\n")


async def run_login_self_healing_verification(run_dir: Path) -> tuple[str, list[str], str]:
    screenshots: list[str] = []
    p = browser = context = page = None
    try:
        p, browser, context, page = await async_login_and_save_state()
        shot = run_dir / "login_self_healing_dashboard.png"
        await page.screenshot(path=str(shot), full_page=True)
        screenshots.append(str(shot))
        status = "passed"
        notes = f"Login successful. Final URL: {page.url}"
        return status, screenshots, notes
    except Exception as exc:
        status = "failed"
        notes = f"Login self-healing verification failed: {exc}"
        return status, screenshots, notes
    finally:
        for obj in [context, browser]:
            if obj:
                try:
                    await obj.close()
                except Exception:
                    pass
        if p:
            try:
                await p.stop()
            except Exception:
                pass


async def run_login_test_case_suite(
    run_dir: Path, test_cases_csv_path: Path
) -> tuple[str, list[str], str, Path]:
    screenshots: list[str] = []
    results: list[dict[str, str]] = []

    with test_cases_csv_path.open("r", encoding="utf-8") as fp:
        reader = csv.DictReader(fp)
        cases = list(reader)

    cases_by_id = {c.get("TC_ID", ""): c for c in cases}
    dataset_path = run_dir / "login_test_data.csv"
    datasets: list[dict[str, str]] = []
    if dataset_path.exists():
        with dataset_path.open("r", encoding="utf-8") as fp:
            datasets = list(csv.DictReader(fp))
    else:
        # Fallback to one row per case if dataset is missing.
        for c in cases:
            datasets.append(
                {
                    "DATASET_ID": c.get("TC_ID", ""),
                    "TC_ID": c.get("TC_ID", ""),
                    "Input_EmailOrPhone": c.get("Input_EmailOrPhone", ""),
                    "Input_Password": c.get("Input_Password", ""),
                    "Expected_Outcome": "login_success" if c.get("TC_ID") in {"LGN-001", "LGN-004"} else "login_blocked",
                    "Expected_Message": "",
                }
            )

    async def _open_login_page(page) -> None:
        for url in LOGIN_URLS:
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=45000)
                return
            except Exception:
                continue
        raise RuntimeError("Could not open any login URL")

    async def _click_login(page) -> None:
        candidates = [
            page.get_by_role("button", name="Sign In"),
            page.get_by_role("button", name="Log In"),
            page.get_by_role("button", name="Login"),
            page.locator('button[type="submit"]'),
            page.locator('input[type="submit"]'),
            page.locator("button").filter(has_text="Log In"),
            page.locator("button").filter(has_text="Sign In"),
        ]
        for c in candidates:
            try:
                if await c.count() > 0:
                    await c.first.click()
                    return
            except Exception:
                continue
        raise RuntimeError("Login button not found")

    async def _collect_error_texts(page) -> str:
        selectors = [
            '[role="alert"]',
            ".MuiAlert-message",
            ".MuiFormHelperText-root",
            ".Mui-error",
            '[class*="error"]',
            "text=Invalid",
            "text=incorrect",
            "text=required",
            "text=password",
        ]
        chunks: list[str] = []
        for selector in selectors:
            try:
                loc = page.locator(selector)
                count = await loc.count()
                for i in range(min(count, 8)):
                    txt = (await loc.nth(i).inner_text()).strip()
                    if txt and txt not in chunks:
                        chunks.append(txt)
            except Exception:
                continue
        return " | ".join(chunks)

    async def _run_single_login_attempt(dataset_id: str, user: str, pwd: str) -> tuple[bool, str, str]:
        p = browser = context = page = None
        try:
            p = await async_playwright().start()
            browser = await p.chromium.launch(
                headless=False,
                args=["--disable-gpu", "--window-size=1920,1080", "--force-device-scale-factor=1"],
            )
            context = await browser.new_context(viewport={"width": 1920, "height": 1080}, device_scale_factor=1)
            page = await context.new_page()
            page.set_default_timeout(30000)

            await _open_login_page(page)
            if await is_logged_in(page):
                # If already logged in, force a clean login screen by navigating directly.
                await page.goto(LOGIN_URLS[0], wait_until="domcontentloaded", timeout=45000)

            user_input = await first_visible(
                page,
                [
                    'input[type="email"]',
                    'input[type="tel"]',
                    'input[name="email"]',
                    'input[name="username"]',
                    'input[placeholder*="Email"]',
                    'input[placeholder*="phone"]',
                    'input[placeholder*="Email or phone"]',
                ],
                timeout=12000,
            )
            pwd_input = await first_visible(
                page,
                [
                    'input[type="password"]',
                    'input[name="password"]',
                    'input[placeholder*="Password"]',
                ],
                timeout=12000,
            )
            if not user_input or not pwd_input:
                raise RuntimeError("Login inputs not found")

            await user_input.fill(user)
            await pwd_input.fill(pwd)
            await _click_login(page)
            await asyncio.sleep(2.5)

            success = await is_logged_in(page)
            errors = await _collect_error_texts(page)
            shot = run_dir / f"{dataset_id}_result.png"
            await page.screenshot(path=str(shot), full_page=True)
            screenshots.append(str(shot))
            return success, errors, shot.name
        finally:
            for obj in [context, browser]:
                if obj:
                    try:
                        await obj.close()
                    except Exception:
                        pass
            if p:
                try:
                    await p.stop()
                except Exception:
                    pass

    for ds in datasets:
        tc_id = ds.get("TC_ID", "")
        case = cases_by_id.get(tc_id, {})
        scenario = case.get("Scenario", tc_id)
        expected = case.get("Expected_Result", ds.get("Expected_Outcome", ""))
        dataset_id = ds.get("DATASET_ID", tc_id or "DATASET")
        input_user = ds.get("Input_EmailOrPhone", "")
        input_password = ds.get("Input_Password", "")
        expected_outcome = ds.get("Expected_Outcome", "")

        status = "failed"
        actual = ""
        evidence = ""

        if tc_id == "LGN-005":
            p = browser = context = page = None
            try:
                p = await async_playwright().start()
                browser = await p.chromium.launch(
                    headless=False,
                    args=["--disable-gpu", "--window-size=1920,1080", "--force-device-scale-factor=1"],
                )
                context = await browser.new_context(viewport={"width": 1920, "height": 1080}, device_scale_factor=1)
                page = await context.new_page()
                await _open_login_page(page)
                pwd = await first_visible(
                    page,
                    ['input[type="password"]', 'input[name="password"]', 'input[placeholder*="Password"]'],
                    timeout=10000,
                )
                if not pwd:
                    status = "failed"
                    actual = "Password field not found."
                else:
                    attr_type = await pwd.get_attribute("type")
                    shot = run_dir / f"{dataset_id}_mask.png"
                    await page.screenshot(path=str(shot), full_page=True)
                    screenshots.append(str(shot))
                    evidence = shot.name
                    if attr_type == "password":
                        status = "passed"
                        actual = "Password input type='password' (masked)."
                    else:
                        status = "failed"
                        actual = f"Password field type is '{attr_type}', expected 'password'."
            except Exception as exc:
                status = "failed"
                actual = f"Mask-check failed: {exc}"
            finally:
                for obj in [context, browser]:
                    if obj:
                        try:
                            await obj.close()
                        except Exception:
                            pass
                if p:
                    try:
                        await p.stop()
                    except Exception:
                        pass
        elif expected_outcome == "error_then_success":
            try:
                parts = [p.strip() for p in input_password.split("->", 1)]
                invalid_pwd = parts[0]
                valid_pwd = parts[1] if len(parts) > 1 else PASSWORD
                first_ok, first_errors, first_ev = await _run_single_login_attempt(
                    f"{dataset_id}_step1", input_user, invalid_pwd
                )
                second_ok, second_errors, second_ev = await _run_single_login_attempt(
                    f"{dataset_id}_step2", input_user, valid_pwd
                )
                evidence = f"{first_ev}; {second_ev}"
                if (not first_ok) and second_ok:
                    status = "passed"
                    actual = (
                        f"First invalid attempt blocked ({first_errors or 'no visible error'}), "
                        "second corrected attempt succeeded."
                    )
                else:
                    status = "failed"
                    actual = (
                        f"Unexpected sequence. first_ok={first_ok}, second_ok={second_ok}, "
                        f"errors1={first_errors}, errors2={second_errors}"
                    )
            except Exception as exc:
                status = "failed"
                actual = f"Two-step flow failed: {exc}"
        else:
            try:
                ok, errs, ev = await _run_single_login_attempt(dataset_id, input_user, input_password)
                evidence = ev
                if expected_outcome == "login_success":
                    status = "passed" if ok else "failed"
                    actual = "Login succeeded." if ok else f"Login blocked. Errors: {errs or 'none'}"
                elif expected_outcome == "login_blocked":
                    status = "passed" if not ok else "failed"
                    actual = (
                        f"Login blocked as expected. Errors: {errs or 'none'}"
                        if not ok
                        else "Login unexpectedly succeeded."
                    )
                else:
                    status = "passed" if ok else "failed"
                    actual = "Executed with generic expectation."
            except Exception as exc:
                status = "failed"
                actual = f"Execution failed: {exc}"

        results.append(
            {
                "TC_ID": tc_id,
                "DATASET_ID": dataset_id,
                "Scenario": scenario,
                "Input_EmailOrPhone": input_user,
                "Input_Password": input_password,
                "Expected_Result": expected,
                "Actual_Result": actual,
                "Status": status,
                "Evidence": evidence,
            }
        )

    results_path = run_dir / "login_test_case_results.csv"
    with results_path.open("w", newline="", encoding="utf-8") as fp:
        writer = csv.DictWriter(
            fp,
            fieldnames=[
                "TC_ID",
                "DATASET_ID",
                "Scenario",
                "Input_EmailOrPhone",
                "Input_Password",
                "Expected_Result",
                "Actual_Result",
                "Status",
                "Evidence",
            ],
        )
        writer.writeheader()
        writer.writerows(results)

    has_failure = any(r["Status"] == "failed" for r in results)
    overall = "failed" if has_failure else "passed"
    notes = "Dataset-driven automated login suite complete."
    return overall, screenshots, notes, results_path


def write_report(run_dir: Path, artifacts: WorkflowArtifacts) -> Path:
    report_path = run_dir / "workflow_report.json"
    report_path.write_text(json.dumps(asdict(artifacts), indent=2), encoding="utf-8")
    return report_path


def ask_yes_no(prompt: str) -> bool:
    while True:
        answer = input(f"{prompt} [y/n]: ").strip().lower()
        if answer in {"y", "yes"}:
            return True
        if answer in {"n", "no"}:
            return False
        print("Please type y or n.")


def main() -> None:
    run_id = _now_id()
    run_dir = _run_dir(run_id)

    print("\n=== Login Change End-to-End Workflow ===")
    requirement = input("Enter your login-page change requirement: ").strip()
    if not requirement:
        print("Requirement is empty. Exiting.")
        return

    # Step 1: Generate tech guide
    tech_guide_path = build_tech_guide(requirement, run_dir)
    print(f"\n[1/6] Tech guide generated: {tech_guide_path}")

    # Step 2: Developer change stage (manual checkpoint)
    print(
        "\n[2/6] Developer change stage:\n"
        "Apply login code changes now (UI/API/validation), then return here."
    )
    input("Press Enter after developer changes are completed...")

    # Step 3: Generate CSV test cases
    test_csv_path = build_test_cases_csv(requirement, run_dir)
    test_data_csv_path = build_login_test_data_csv(run_dir)
    print(f"\n[3/6] Test-case CSV generated: {test_csv_path}")
    print(f"[3/6] Test-data CSV generated: {test_data_csv_path}")

    # Step 4: CSV verification preview
    print("\n[4/6] Test-case CSV preview for your verification:")
    print_csv_preview(test_csv_path)

    # Step 5: Approval gate
    approved = ask_yes_no("[5/6] Approve test cases and proceed to self-healing run?")
    if not approved:
        artifacts = WorkflowArtifacts(
            run_id=run_id,
            requirement=requirement,
            tech_guide_path=str(tech_guide_path),
            test_cases_csv_path=str(test_csv_path),
            test_data_csv_path=str(test_data_csv_path),
            test_case_results_csv_path="",
            approval_status="rejected",
            verification_screenshots=[],
            verification_status="not_run",
            notes="Stopped because approval not granted.",
        )
        report_path = write_report(run_dir, artifacts)
        print(f"Approval rejected. Workflow report: {report_path}")
        return

    # Step 6: Self-healing test execution + screenshot evidence
    print("\n[6/6] Running test-case-wise login verification...")
    verification_status, screenshots, notes, test_results_path = asyncio.run(
        run_login_test_case_suite(run_dir, test_csv_path)
    )

    artifacts = WorkflowArtifacts(
        run_id=run_id,
        requirement=requirement,
        tech_guide_path=str(tech_guide_path),
        test_cases_csv_path=str(test_csv_path),
        test_data_csv_path=str(test_data_csv_path),
        test_case_results_csv_path=str(test_results_path),
        approval_status="approved",
        verification_screenshots=screenshots,
        verification_status=verification_status,
        notes=notes,
    )
    report_path = write_report(run_dir, artifacts)

    print("\n=== Workflow Complete ===")
    print(f"Run ID: {run_id}")
    print(f"Tech Guide: {tech_guide_path}")
    print(f"CSV: {test_csv_path}")
    print(f"Test Data CSV: {test_data_csv_path}")
    print(f"Test Results CSV: {test_results_path}")
    print(f"Verification Status: {verification_status}")
    if screenshots:
        print("Screenshots:")
        for shot in screenshots:
            print(f"  - {shot}")
    print(f"Report: {report_path}")
    print(f"Notes: {notes}")


if __name__ == "__main__":
    main()
