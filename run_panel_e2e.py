"""Run a Shipmozo panel E2E scenario (Playwright UI automation)."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from capture_module_screenshots import save_shot
from panel_e2e.nav_fast import fast_nav_to_rate_calculator
from panel_e2e.orders import run_order_create_flow, run_order_verify_flow
from panel_e2e.rate_calculator import run_rate_calculator_flow
from shipmozo_login import async_login_and_save_state

ORDER_VERIFY_FLOWS = {"order_verify", "order_verify_new_orders", "orders_verify"}


async def _order_create(page, flow, form, **kwargs):
    return await run_order_create_flow(page, form, scenario_id=kwargs.get("scenario_id", ""))


async def _order_verify(page, flow, form, **kwargs):
    return await run_order_verify_flow(page, form, scenario_id=kwargs.get("scenario_id", ""))


FLOWS = {
    "order_create_domestic": _order_create,
    "order_create": _order_create,
    "order_verify_new_orders": _order_verify,
    "order_verify": _order_verify,
    "orders_verify": _order_verify,
    "rate_calculator_open": run_rate_calculator_flow,
    "rate_calculator_domestic_happy": run_rate_calculator_flow,
    "rate_calculator_domestic_calculate": run_rate_calculator_flow,
    "rate_calculator_international_toggle": run_rate_calculator_flow,
    "rate_calculator_invalid_pincode": run_rate_calculator_flow,
    "rate_calculator_missing_weight": run_rate_calculator_flow,
    "rate_calculator_heavy_parcel": run_rate_calculator_flow,
    "rate_calculator_dimensions": run_rate_calculator_flow,
}


async def run_e2e(scenario: dict, run_id: str) -> dict:
    scenario_id = str(scenario.get("id") or "TC-000")
    inputs = scenario.get("inputs") or {}
    flow = str(inputs.get("e2eFlow") or inputs.get("uiAction") or "").strip()
    form = inputs.get("formData") or inputs.get("e2eForm") or {}

    if not flow:
        return {"ok": False, "error": "inputs.e2eFlow or inputs.uiAction is required for E2E"}

    runner = FLOWS.get(flow)
    if not runner:
        return {"ok": False, "error": f"Unsupported e2e flow: {flow}"}

    out_dir = Path("output") / "cloud-images" / run_id / "raw"
    out_dir.mkdir(parents=True, exist_ok=True)

    p = browser = context = page = None
    screenshot = None
    try:
        p, browser, context, page = await async_login_and_save_state()
        nav_script = None
        if flow.startswith("rate_calculator"):
            heal, nav_ok = await fast_nav_to_rate_calculator(page)
            nav_script = heal.get("script") if nav_ok else None
        if flow.startswith("order_create") or flow in ORDER_VERIFY_FLOWS:
            result = await runner(page, flow, form, scenario_id=scenario_id)
        else:
            result = await runner(
                page,
                flow,
                form,
                nav_script=nav_script,
                skip_nav=bool(nav_script),
            )
        shot_id = f"e2e_{scenario_id.replace('-', '_').lower()}"
        screenshot = await save_shot(
            page,
            out_dir,
            shot_id,
            f"E2E {scenario_id}: {flow}",
            1,
            content_ready=True,
            fast_e2e=True,
        )
        result["screenshot"] = screenshot
        result["e2eFlow"] = flow
        result["scenarioId"] = scenario_id
        return result
    except Exception as exc:
        return {
            "ok": False,
            "error": str(exc),
            "e2eFlow": flow,
            "scenarioId": scenario_id,
            "screenshot": screenshot,
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
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "Usage: run_panel_e2e.py <runId> <scenarioJsonPath>",
                }
            )
        )
        return

    run_id = sys.argv[1]
    scenario_path = Path(sys.argv[2])
    scenario = json.loads(scenario_path.read_text(encoding="utf-8"))
    result = await run_e2e(scenario, run_id)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
