"""One agent tick: login → optional execute script → observe → report for OpenRouter loop."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

from panel_e2e.ai_script import execute_nav_script, load_ai_script, save_ai_script_for_replay
from panel_e2e.e2e_log import e2e_log
from panel_e2e.page_observe import attach_console_collector, capture_page_observation
from panel_e2e.rate_calculator import _on_rate_calculator_page, quick_search_to_rate_calculator
from panel_page_state import page_is_broken_for_e2e
from panel_url import panel_origin
from shipmozo_login import async_login_and_save_state


async def main() -> None:
    run_id = sys.argv[1] if len(sys.argv) > 1 else "heal"
    session_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("output/runtime")
    attempt = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    script_path = sys.argv[4] if len(sys.argv) > 4 else ""

    if run_id:
        os.environ["HEAL_PROGRESS_RUN_ID"] = run_id

    session_dir.mkdir(parents=True, exist_ok=True)
    steps_run: list[str] = []
    exec_result: dict | None = None
    p = browser = context = page = None

    try:
        p, browser, context, page = await async_login_and_save_state()
        console_logs = attach_console_collector(page)
        origin = await panel_origin(page)
        e2e_log("agent", f"Attempt {attempt} — logged in at {page.url}")

        script = load_ai_script(script_path) if script_path else None
        if script and script.get("navSteps"):
            e2e_log("agent", f"Executing {len(script['navSteps'])} OpenRouter steps…")
            exec_result = await execute_nav_script(page, script)
            steps_run.extend(exec_result.get("stepsRun") or [])
            e2e_log(
                "agent",
                f"Execute {'OK' if exec_result.get('ok') else 'FAIL'} — {page.url}",
            )

        observation = await capture_page_observation(page, console_logs)
        obs_path = session_dir / f"observation-{attempt}.json"
        obs_path.write_text(json.dumps(observation, indent=2), encoding="utf-8")

        broken, reason = await page_is_broken_for_e2e(page)
        on_rc = await _on_rate_calculator_page(page)
        success = on_rc and not broken

        if success:
            final_script = script or {
                "version": 1,
                "module": "Rate Calculator",
                "rationale": "Already on target page",
                "navSteps": [],
                "verifyTexts": ["pincode", "calculate"],
                "source": "observe_only",
            }
            nav = save_ai_script_for_replay(final_script, origin, page.url)
            print(
                json.dumps(
                    {
                        "ok": True,
                        "attempt": attempt,
                        "observation": observation,
                        "result": exec_result,
                        "stepsRun": steps_run,
                        "pageUrl": page.url,
                        "script": nav,
                        "origin": origin,
                        "aiGenerated": bool(script),
                        "rationale": (script or {}).get("rationale"),
                    },
                    ensure_ascii=False,
                )
            )
            return

        print(
            json.dumps(
                {
                    "ok": False,
                    "attempt": attempt,
                    "observation": observation,
                    "result": exec_result,
                    "stepsRun": steps_run,
                    "pageUrl": page.url,
                    "errors": (exec_result or {}).get("errors") or [],
                    "brokenReason": reason if broken else None,
                    "needsRepair": True,
                },
                ensure_ascii=False,
            )
        )
    except Exception as exc:
        print(json.dumps({"ok": False, "attempt": attempt, "error": str(exc), "stepsRun": steps_run}))
    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if p:
            await p.stop()


if __name__ == "__main__":
    asyncio.run(main())
