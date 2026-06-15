"""Run many E2E scenarios in one browser session (one login)."""



from __future__ import annotations



import json

import os

import sys

import time

from pathlib import Path



from capture_module_screenshots import save_shot

from panel_e2e.e2e_log import e2e_log

from panel_e2e.nav_fast import fast_nav_to_rate_calculator

from panel_e2e.orders import run_order_create_flow, run_order_verify_flow
from panel_e2e.panel_login import run_panel_login_smoke
from panel_e2e.panel_ui import run_panel_ui_check

from panel_e2e.rate_calculator import (

    _on_rate_calculator_page,

    quick_search_to_rate_calculator,

    run_rate_calculator_flow,

)

from panel_page_state import page_is_broken_for_e2e, page_looks_like_not_found
from panel_screenshot import wait_for_loaders_gone

from shipmozo_login import async_login_and_save_state



RC_FLOWS = {

    "rate_calculator_open",

    "rate_calculator_domestic_happy",

    "rate_calculator_domestic_calculate",

    "rate_calculator_international_toggle",

    "rate_calculator_invalid_pincode",

    "rate_calculator_missing_weight",

    "rate_calculator_heavy_parcel",

    "rate_calculator_dimensions",

}



ORDER_CREATE_FLOWS = {"order_create", "order_create_domestic"}

ORDER_VERIFY_FLOWS = {"order_verify", "order_verify_new_orders", "orders_verify"}
PANEL_UI_FLOWS = {"panel_ui_check", "ui_check", "panel_custom"}
LOGIN_UI_FLOWS = {"panel_login_smoke", "panel_login", "login_ui"}





def _skip_screenshots() -> bool:

    return os.getenv("SKIP_SCREENSHOTS", "").lower() in {"1", "true", "yes"}


def _record_video() -> bool:

    return os.getenv("RECORD_VIDEO", "").lower() in {"1", "true", "yes"}


async def _finalize_page_video(page, scenario_id: str) -> str | None:

    if not _record_video():
        return None
    try:
        video = page.video
        if not video:
            return None
        await page.close()
        path = await video.path()
        return str(path) if path else None
    except Exception:
        return None





def _scenario_flow(scenario: dict) -> str:

    inputs = scenario.get("inputs") or {}

    return str(inputs.get("e2eFlow") or inputs.get("uiAction") or "").strip()





def _needs_rc_nav(scenarios: list[dict]) -> bool:

    for scenario in scenarios:

        if _scenario_flow(scenario).startswith("rate_calculator"):

            return True

    return False





async def run_session(run_id: str, scenarios: list[dict], *, nav_script_path: str = "") -> dict:

    out_dir = Path("output") / "cloud-images" / run_id / "raw"

    out_dir.mkdir(parents=True, exist_ok=True)



    p = browser = context = page = None

    results: list[dict] = []

    heal: dict = {}

    nav_script = None



    try:

        p, browser, context, page = await async_login_and_save_state()

        e2e_log("session", f"One browser session — {len(scenarios)} scenario(s)")



        if _needs_rc_nav(scenarios):

            heal, nav_ok = await fast_nav_to_rate_calculator(page, nav_script_path)

            if not nav_ok:

                return {

                    "ok": False,

                    "needsAiHeal": True,

                    "error": "Rate Calculator navigation failed",

                    "heal": heal,

                    "results": [],

                }

            nav_script = heal.get("script")



        for scenario in scenarios:

            scenario_id = str(scenario.get("id") or "TC-000")

            title = str(scenario.get("title") or scenario_id)

            inputs = scenario.get("inputs") or {}

            flow = _scenario_flow(scenario)

            form = inputs.get("formData") or inputs.get("e2eForm") or {}

            started = time.time()

            e2e_log("session", f"▶ {scenario_id} — {title} ({flow or 'no flow'})")



            if flow in RC_FLOWS:

                broken, reason = await page_is_broken_for_e2e(page)

                if broken or await page_looks_like_not_found(page) or not await _on_rate_calculator_page(page):

                    e2e_log("session", f"Re-nav RC: {reason or page.url}")

                    await quick_search_to_rate_calculator(page)

                result = await run_rate_calculator_flow(

                    page,

                    flow,

                    form,

                    nav_script=nav_script,

                    skip_nav=True,

                    scenario_id=scenario_id,

                )

            elif flow in ORDER_CREATE_FLOWS:

                result = await run_order_create_flow(page, form, scenario_id=scenario_id)

            elif flow in ORDER_VERIFY_FLOWS:

                result = await run_order_verify_flow(page, form, scenario_id=scenario_id)

            elif flow in LOGIN_UI_FLOWS:

                work_page = page
                created = False
                if _record_video():
                    created = True
                    work_page = await context.new_page()
                    try:
                        await work_page.goto(page.url, wait_until="domcontentloaded", timeout=20000)
                        await wait_for_loaders_gone(work_page)
                    except Exception:
                        pass
                result = await run_panel_login_smoke(work_page, scenario_id=scenario_id)
                if created:
                    vid = await _finalize_page_video(work_page, scenario_id)
                    if vid:
                        result["video"] = vid

            elif flow in PANEL_UI_FLOWS:

                work_page = page
                created = False
                if _record_video():
                    created = True
                    work_page = await context.new_page()
                    try:
                        await work_page.goto(page.url, wait_until="domcontentloaded", timeout=20000)
                        await wait_for_loaders_gone(work_page)
                    except Exception:
                        pass
                result = await run_panel_ui_check(
                    work_page,
                    module_query=str(inputs.get("moduleQuery") or ""),
                    verify_texts=inputs.get("verifyTexts") or [],
                    check_notes=str(inputs.get("checkNotes") or title),
                    scenario_id=scenario_id,
                )
                if created:
                    vid = await _finalize_page_video(work_page, scenario_id)
                    if vid:
                        result["video"] = vid

            else:

                result = {

                    "ok": False,

                    "error": f"Unsupported e2e flow: {flow or '(missing)'}",

                    "stepsRun": [],

                    "pageUrl": page.url,

                }



            result["durationMs"] = int((time.time() - started) * 1000)

            result["e2eFlow"] = flow



            if not _skip_screenshots():

                shot_id = f"e2e_{scenario_id.replace('-', '_').lower()}"

                try:

                    result["screenshot"] = await save_shot(

                        page,

                        out_dir,

                        shot_id,

                        f"E2E {scenario_id}: {flow}",

                        1,

                        content_ready=True,

                        fast_e2e=True,

                    )

                except Exception:

                    result["screenshot"] = None



            result["scenarioId"] = scenario_id

            results.append(result)

            e2e_log(

                "session",

                f"{'✓' if result.get('ok') else '✗'} {scenario_id} ({result['durationMs']}ms) — {result.get('pageUrl', page.url)}",

            )



        return {

            "ok": all(r.get("ok") is not False for r in results),

            "heal": heal,

            "results": results,

        }

    except Exception as exc:

        return {"ok": False, "error": str(exc), "heal": heal, "results": results}

    finally:

        if context:

            await context.close()

        if browser:

            await browser.close()

        if p:

            await p.stop()





async def main() -> None:

    if len(sys.argv) < 3:

        print(

            json.dumps(

                {

                    "ok": False,

                    "error": "Usage: run_panel_e2e_session.py <runId> <scenariosJsonPath> [--nav-script path]",

                }

            )

        )

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



    result = await run_session(run_id, scenarios, nav_script_path=nav_script_path)

    payload = json.dumps(result, ensure_ascii=False)
    try:
        sys.stdout.buffer.write(payload.encode("utf-8"))
        sys.stdout.buffer.write(b"\n")
        sys.stdout.buffer.flush()
    except Exception:
        print(json.dumps(result, ensure_ascii=True))





if __name__ == "__main__":

    import asyncio



    asyncio.run(main())

