"""Fast navigation to Rate Calculator — replay script or Ctrl+B only (no AI, no strategy sweep)."""



from __future__ import annotations



from pathlib import Path



from playwright.async_api import Page



from panel_e2e.ai_script import execute_nav_script, load_ai_script

from panel_e2e.e2e_log import e2e_log

from panel_e2e.rate_calculator import _on_rate_calculator_page, quick_search_to_rate_calculator



AI_SCRIPT_PATH = Path("output/runtime/e2e-ai-script.json")





async def fast_nav_to_rate_calculator(page: Page, nav_script_path: str = "") -> tuple[dict, bool]:

    if await _on_rate_calculator_page(page):

        return {

            "ok": True,

            "cached": True,

            "script": {"strategyId": "already_there"},

            "attempts": [{"id": "already_there", "ok": True, "logLine": "✓ Already on Rate Calculator"}],

        }, True



    steps_run: list[str] = []

    path = nav_script_path or (str(AI_SCRIPT_PATH) if AI_SCRIPT_PATH.exists() else "")

    ai_script = load_ai_script(path) if path else None



    if ai_script:

        e2e_log("nav-fast", f"Replay nav script ({len(ai_script.get('navSteps') or [])} steps)")

        result = await execute_nav_script(page, ai_script)

        steps_run.extend(result.get("stepsRun") or [])

        if result.get("ok") and await _on_rate_calculator_page(page):

            return {

                "ok": True,

                "cached": True,

                "script": {"strategyId": "ai_script", "aiScriptPath": path, "pageUrl": page.url},

                "attempts": [{"id": "ai_script", "ok": True, "logLine": "✓ Replayed nav script"}],

            }, True



    e2e_log("nav-fast", "Ctrl+B quick search")

    if await quick_search_to_rate_calculator(page) and await _on_rate_calculator_page(page):

        return {

            "ok": True,

            "cached": False,

            "script": {"strategyId": "quick_search", "pageUrl": page.url},

            "attempts": [{"id": "quick_search", "ok": True, "logLine": "✓ Ctrl+B"}],

        }, True



    return {

        "ok": False,

        "script": None,

        "attempts": steps_run

        and [{"id": "ai_script", "ok": False, "logLine": "✗ Nav script failed"}]

        or [{"id": "quick_search", "ok": False, "logLine": "✗ Quick search failed"}],

    }, False

