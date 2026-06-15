"""Panel merchant login UI smoke test."""

from __future__ import annotations

from playwright.async_api import Page

from panel_screenshot import wait_for_loaders_gone
from shipmozo_login import is_logged_in


async def run_panel_login_smoke(page: Page, *, scenario_id: str = "UI-LOGIN") -> dict:
    steps: list[str] = [f"panel_login_smoke:{scenario_id}"]
    await wait_for_loaders_gone(page)
    steps.append(f"url:{page.url}")

    if not await is_logged_in(page):
        return {
            "ok": False,
            "error": "Not logged in — check SHIPMOZO_EMAIL / SHIPMOZO_PASSWORD in .env",
            "stepsRun": steps,
            "pageUrl": page.url,
        }

    url_low = (page.url or "").lower()
    locator_markers = [
        "text=Add Order",
        "text=Orders",
        "text=Analytics",
        "text=Shipment",
        "text=New Orders",
    ]
    found_locators: list[str] = []
    for marker in locator_markers:
        try:
            if await page.locator(marker).count() > 0:
                found_locators.append(marker.replace("text=", ""))
        except Exception:
            continue

    try:
        body = (await page.locator("body").inner_text(timeout=8000) or "").lower()
    except Exception:
        body = ""

    text_markers = ["order", "dashboard", "add order", "analytics", "shipment"]
    found_text = [m for m in text_markers if m in body]
    found = list(dict.fromkeys([*found_locators, *found_text]))
    steps.append(f"dashboard_markers:{','.join(found) or 'none'}")

    on_panel = "panel.appiify" in url_low and "/login" not in url_low
    on_orders = "/orders" in url_low or "/dashboard" in url_low

    if not found and on_panel and (on_orders or found_locators):
        found = found_locators or ["panel_url"]
        steps.append("dashboard_markers:url_fallback")

    if not found:
        return {
            "ok": False,
            "error": "Logged in but dashboard markers not found on page",
            "stepsRun": steps,
            "pageUrl": page.url,
            "uiText": found,
        }

    return {
        "ok": True,
        "stepsRun": steps,
        "pageUrl": page.url,
        "uiText": found,
    }
