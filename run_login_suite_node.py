from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from login_change_workflow import run_login_test_case_suite


def main() -> None:
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "Usage: run_login_suite_node.py <run_dir> <test_cases_csv>"}))
        raise SystemExit(2)

    run_dir = Path(sys.argv[1])
    test_cases_csv = Path(sys.argv[2])

    status, screenshots, notes, results_csv = asyncio.run(
        run_login_test_case_suite(run_dir, test_cases_csv)
    )
    print(
        json.dumps(
            {
                "ok": True,
                "verification_status": status,
                "verification_notes": notes,
                "verification_screenshots": screenshots,
                "test_case_results_csv_path": str(results_csv),
            }
        )
    )


if __name__ == "__main__":
    main()
