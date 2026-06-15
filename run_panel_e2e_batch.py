"""Run multiple E2E scenarios in one browser session (login + replay nav script once)."""



from __future__ import annotations



import asyncio

import json

import sys

from pathlib import Path



from capture_module_screenshots import save_shot

from panel_e2e.e2e_log import e2e_log

from panel_e2e.nav_fast import fast_nav_to_rate_calculator

from panel_e2e.rate_calculator import (

    _on_rate_calculator_page,

    quick_search_to_rate_calculator,

    run_rate_calculator_flow,

)

from panel_page_state import page_is_broken_for_e2e, page_looks_like_not_found

from shipmozo_login import async_login_and_save_state



FLOWS = {

    "rate_calculator_open",

    "rate_calculator_domestic_happy",

    "rate_calculator_domestic_calculate",

    "rate_calculator_international_toggle",

    "rate_calculator_invalid_pincode",

    "rate_calculator_missing_weight",

    "rate_calculator_heavy_parcel",

    "rate_calculator_dimensions",

}





async def run_batch(run_id: str, scenarios: list[dict], *, nav_script_path: str = "") -> dict:

    out_dir = Path("output") / "cloud-images" / run_id / "raw"

    out_dir.mkdir(parents=True, exist_ok=True)



    p = browser = context = page = None

    results: list[dict] = []

    heal: dict = {}



    try:

        p, browser, context, page = await async_login_and_save_state()

        e2e_log("batch", f"Starting E2E batch — {len(scenarios)} scenario(s)")



        heal, nav_ok = await fast_nav_to_rate_calculator(page, nav_script_path)

        if not nav_ok:

            return {

                "ok": False,

                "needsAiHeal": True,

                "error": "Navigation failed — OpenRouter will repair nav script only",

                "heal": heal,

                "results": [],

            }



        nav_script = heal.get("script") if heal.get("ok") else None



        for scenario in scenarios:

            scenario_id = str(scenario.get("id") or "TC-000")

            title = str(scenario.get("title") or scenario_id)

            inputs = scenario.get("inputs") or {}

            flow = str(inputs.get("e2eFlow") or inputs.get("uiAction") or "").strip()

            form = inputs.get("formData") or inputs.get("e2eForm") or {}

            screenshot = None

            e2e_log("batch", f"▶ {scenario_id} — {title} ({flow or 'no flow'})")



            if not flow or flow not in FLOWS:

                results.append(

                    {

                        "scenarioId": scenario_id,

                        "ok": False,

                        "error": f"Unsupported e2e flow: {flow or '(missing)'}",

                        "e2eFlow": flow,

                    }

                )

                continue



            broken, reason = await page_is_broken_for_e2e(page)

            if broken or await page_looks_like_not_found(page) or not await _on_rate_calculator_page(page):

                e2e_log("batch", f"Re-nav before {scenario_id}: {reason or page.url}")

                await quick_search_to_rate_calculator(page)



            result = await run_rate_calculator_flow(

                page,

                flow,

                form,

                nav_script=nav_script,

                skip_nav=bool(nav_script),

                scenario_id=scenario_id,

            )

            e2e_log(

                "batch",

                f"{'✓' if result.get('ok') else '✗'} {scenario_id} — {result.get('pageUrl', page.url)}",

            )



            shot_id = f"e2e_{scenario_id.replace('-', '_').lower()}"

            try:

                screenshot = await save_shot(

                    page,

                    out_dir,

                    shot_id,

                    f"E2E {scenario_id}: {flow}",

                    1,

                    content_ready=True,

                    fast_e2e=True,

                )

            except Exception:

                screenshot = None



            result["screenshot"] = screenshot

            result["e2eFlow"] = flow

            result["scenarioId"] = scenario_id

            results.append(result)



        return {

            "ok": heal.get("ok", False) and all(r.get("ok") is not False for r in results),

            "heal": heal,

            "results": results,

        }

    except Exception as exc:

        return {

            "ok": False,

            "error": str(exc),

            "heal": heal,

            "results": results,

        }

    finally:

        if context:

            await context.close()

        if browser:

            await browser.close()

        if p:

            await p.stop()





async def main() -> None:

    if len(sys.argv) < 3:

        print(json.dumps({"ok": False, "error": "Usage: run_panel_e2e_batch.py <runId> <scenariosJsonPath> [--nav-script path]"}))

        return



    run_id = sys.argv[1]

    scenarios_path = Path(sys.argv[2])

    nav_script_path = ""

    if "--nav-script" in sys.argv:

        idx = sys.argv.index("--nav-script")

        if idx + 1 < len(sys.argv):

            nav_script_path = sys.argv[idx + 1]



    scenarios = json.loads(scenarios_path.read_text(encoding="utf-8"))

    if not isinstance(scenarios, list):

        scenarios = scenarios.get("scenarios") or []



    result = await run_batch(run_id, scenarios, nav_script_path=nav_script_path)

    print(json.dumps(result, ensure_ascii=False))





if __name__ == "__main__":

    asyncio.run(main())

