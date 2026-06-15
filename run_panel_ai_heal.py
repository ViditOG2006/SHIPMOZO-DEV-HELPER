"""AI-guided self-heal: execute OpenRouter script, verify, save for batch run."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

from panel_e2e.ai_script import execute_nav_script, load_ai_script, save_ai_script_for_replay
from panel_e2e.e2e_log import e2e_log
from panel_e2e.rate_calculator import _on_rate_calculator_page, quick_search_to_rate_calculator
from panel_page_state import page_is_broken_for_e2e
from panel_url import panel_origin
from shipmozo_login import async_login_and_save_state


async def main() -> None:
    run_id = sys.argv[1] if len(sys.argv) > 1 else "heal"
    script_path = sys.argv[2] if len(sys.argv) > 2 else ""
    force = "--force" in sys.argv

    if run_id:
        os.environ["HEAL_PROGRESS_RUN_ID"] = run_id

    script = load_ai_script(script_path) if script_path else None
    attempts: list[dict] = []
    p = browser = context = page = None

    try:
        p, browser, context, page = await async_login_and_save_state()
        origin = await panel_origin(page)
        e2e_log("heal", f"Logged in — {page.url}")

        if script:
            attempts.append({
                "id": "ai_script",
                "ok": False,
                "logLine": f'OpenRouter plan: {script.get("rationale", "")[:120]}',
                "source": script.get("source", "ai"),
                "stepCount": len(script.get("navSteps") or []),
            })

            result = await execute_nav_script(page, script)
            for line in result.get("stepsRun") or []:
                attempts.append({"id": "ai_step", "ok": line.startswith("✓"), "logLine": f"  {line}"})

            broken, reason = await page_is_broken_for_e2e(page)
            if result.get("ok") and not broken and await _on_rate_calculator_page(page):
                nav = save_ai_script_for_replay(script, origin, page.url)
                print(json.dumps({
                    "ok": True,
                    "cached": False,
                    "aiGenerated": True,
                    "script": nav,
                    "origin": origin,
                    "pageUrl": page.url,
                    "attempts": attempts,
                    "rationale": script.get("rationale"),
                    "scenarioPlans": script.get("scenarioPlans") or [],
                }, ensure_ascii=False))
                return

            attempts.append({
                "id": "ai_script",
                "ok": False,
                "logLine": f"✗ AI script failed — fallback Ctrl+B ({'; '.join(result.get('errors') or [])[:100]})",
            })

        if await quick_search_to_rate_calculator(page) and await _on_rate_calculator_page(page):
            broken, _ = await page_is_broken_for_e2e(page)
            if broken:
                attempts.append({"id": "quick_search", "ok": False, "logLine": "✗ Ctrl+B landed on broken page"})
            else:
                fallback = {
                    "version": 1,
                    "module": script.get("module") if script else "Rate Calculator",
                    "rationale": "Ctrl+B fallback after AI script",
                    "navSteps": [],
                    "source": "quick_search_fallback",
                }
                nav = save_ai_script_for_replay(fallback, origin, page.url)
                nav["strategyId"] = "quick_search"
                attempts.append({"id": "quick_search", "ok": True, "logLine": "✓ Ctrl+B fallback succeeded"})
                e2e_log("heal", f"Ctrl+B OK — {page.url}")
                print(json.dumps({
                    "ok": True,
                    "cached": False,
                    "aiGenerated": bool(script),
                    "script": nav,
                    "origin": origin,
                    "pageUrl": page.url,
                    "attempts": attempts,
                }, ensure_ascii=False))
                return

        broken, reason = await page_is_broken_for_e2e(page)
        if broken:
            attempts.append({"id": "broken_route", "ok": False, "logLine": f"✗ {reason}"})

        print(json.dumps({
            "ok": False,
            "error": "AI script and Ctrl+B fallback both failed",
            "attempts": attempts,
            "pageUrl": page.url,
        }))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc), "attempts": attempts}))
    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if p:
            await p.stop()


if __name__ == "__main__":
    asyncio.run(main())
