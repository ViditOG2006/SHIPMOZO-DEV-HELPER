"""E2E: create domestic order and verify in New Orders list."""

from __future__ import annotations

import os
import random
from typing import Any

from playwright.async_api import Page

from panel_e2e.e2e_log import e2e_log
from panel_orders import goto_new_orders_domestic, search_new_orders
from panel_url import panel_origin

SESSION_LAST_ORDER_REF = ""


def remember_order_ref(ref: str) -> None:
    global SESSION_LAST_ORDER_REF
    if ref:
        SESSION_LAST_ORDER_REF = ref
        os.environ["ORDER_REF_ID"] = ref


async def run_order_verify_flow(page: Page, form: dict[str, Any], *, scenario_id: str = "") -> dict[str, Any]:
    steps: list[str] = []
    origin = await panel_origin(page)
    ref = str(
        form.get("referenceId")
        or form.get("orderRef")
        or os.environ.get("ORDER_REF_ID")
        or SESSION_LAST_ORDER_REF
        or ""
    ).strip()

    if scenario_id:
        steps.append(f"Scenario {scenario_id}: verify order ref={ref or '(any)'}")
        e2e_log("e2e", f"{scenario_id} — verify in New Orders")

    await goto_new_orders_domestic(page, origin)
    steps.append("Opened New Orders (Forward/Domestic/New) + reset filters")

    found = False
    if ref:
        found = await search_new_orders(page, ref)
        steps.append(f"Search ref {ref}: {'found' if found else 'not found'}")
    else:
        hay = (await page.inner_text("body")).lower()
        found = "order" in hay and len(hay) > 80
        steps.append("No ref — checked list shows order content")

    ui_text = ""
    try:
        ui_text = await page.inner_text("body")
    except Exception:
        pass

    return {
        "ok": found,
        "referenceId": ref or None,
        "stepsRun": steps,
        "pageUrl": page.url,
        "uiText": ui_text[:4000],
        "error": None if found else (f"Order {ref} not visible in New Orders" if ref else "New Orders list empty or filters hiding orders"),
    }


async def run_order_create_flow(page: Page, form: dict[str, Any], *, scenario_id: str = "") -> dict[str, Any]:
    steps: list[str] = []
    origin = await panel_origin(page)
    ref = str(form.get("referenceId") or scenario_id.replace("-", "") or f"TC{random.randint(10000, 99999)}")
    remember_order_ref(ref)

    if scenario_id:
        steps.append(f"Scenario {scenario_id}: create order ref={ref}")
        e2e_log("e2e", f"{scenario_id} — creating order {ref}")

    try:
        import create_order as co
        from create_order import ShipmozoOrderBot

        co.REF_ID = ref
        bot = ShipmozoOrderBot()
        bot.page = page
        bot.context = page.context
        bot.browser = page.context.browser

        add_url = f"{origin.rstrip('/')}/orders/add?type=DOM"
        steps.append(f"Open Add Order ({add_url})")
        await page.goto(add_url, wait_until="domcontentloaded")
        await page.wait_for_load_state("domcontentloaded", timeout=8000)

        await bot.fill_buyer_receiver()
        steps.append("Filled buyer/receiver")
        await bot.fill_order_details()
        steps.append("Filled order details")
        await bot.fill_payment_shipping()
        steps.append("Filled payment/shipping")
        await bot.select_warehouse()
        steps.append("Selected warehouse")
        await bot.fill_weight_dimensions()
        steps.append("Filled weight/dimensions")
        await bot._validate_filled_required_fields()

        save_ok = await bot.save_order()
        if not save_ok:
            return {
                "ok": False,
                "error": f"Save failed: {bot.last_save_errors or 'unknown'}",
                "stepsRun": steps,
                "pageUrl": page.url,
                "referenceId": ref,
                "uiText": await page.inner_text("body") if page else "",
            }
        steps.append("Clicked Save")

        await goto_new_orders_domestic(page, origin)
        steps.append("Opened New Orders (Forward/Domestic/New) + reset filters")
        found = await search_new_orders(page, ref)
        steps.append(f"Search ref {ref}: {'found' if found else 'not found'}")

        ui_text = ""
        try:
            ui_text = await page.inner_text("body")
        except Exception:
            pass

        remember_order_ref(ref)
        return {
            "ok": found,
            "referenceId": ref,
            "stepsRun": steps,
            "pageUrl": page.url,
            "uiText": ui_text[:4000],
            "error": None if found else f"Order {ref} not visible in New Orders (check date filter / tab)",
        }
    except Exception as exc:
        e2e_log("e2e", f"Order create failed: {exc}")
        return {
            "ok": False,
            "error": str(exc),
            "stepsRun": steps,
            "pageUrl": page.url,
            "referenceId": ref,
        }
