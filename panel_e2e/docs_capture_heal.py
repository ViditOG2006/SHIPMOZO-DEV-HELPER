"""Apply OpenAI-suggested navigation fixes during doc screenshot capture."""

from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any

from playwright.async_api import Page

from panel_doc_module import (
    is_add_order_target,
    is_channel_target,
    is_new_orders_target,
    is_quick_add_target,
    is_rate_calculator_target,
    resolve_doc_module,
)
from panel_e2e.channel_pages import channel_page_usable
from panel_e2e.rate_calculator import _on_rate_calculator_page
from panel_navigate import page_looks_like_not_found
from panel_page_state import url_looks_like_broken_nav
from panel_screenshot import has_module_anchor, wait_for_module_content
from panel_ui_helpers import dismiss_blocking_overlays, page_has_blocking_dialog
from panel_quick_search import navigate_module_via_quick_search


def load_heal_plan_from_env() -> dict[str, Any] | None:
    raw = os.getenv("DOCS_CAPTURE_HEAL_PLAN", "").strip()
    if not raw:
        return None
    try:
        plan = json.loads(raw)
        return plan if isinstance(plan, dict) else None
    except Exception:
        return None


def url_is_manage_courier_trap(url: str) -> bool:
    low = (url or "").lower()
    return "manage-courier" in low or "manage_courier" in low


async def verify_heal_texts(page: Page, texts: list[str]) -> bool:
    if not texts:
        return True
    try:
        hay = (await page.content()).lower()
    except Exception:
        return False
    hits = sum(1 for t in texts if str(t).lower() in hay)
    return hits >= min(2, len(texts))


async def verify_module_target(
    page: Page, module_name: str = "", description: str = ""
) -> tuple[bool, str]:
    if await page_looks_like_not_found(page):
        return False, "404 or not-found page"
    if await page_has_blocking_dialog(page):
        return False, "blocking confirmation dialog (unsaved changes)"
    if url_looks_like_broken_nav(page.url or ""):
        return False, f"broken route: {page.url}"
    if url_is_manage_courier_trap(page.url or ""):
        return False, "manage-courier URL is a 404 trap"

    url = (page.url or "").lower()
    try:
        text = (
            await page.evaluate(
                "() => (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 2500).toLowerCase()"
            )
            or ""
        )
    except Exception:
        text = ""

    if "login" in url or "sign in" in text[:300]:
        return False, "login page"

    if is_rate_calculator_target(module_name, description):
        if not await _on_rate_calculator_page(page):
            return False, "not on Rate Calculator (missing pincode/calculate markers)"
        if "pincode" not in text and "origin" not in text:
            return False, "Rate Calculator missing pincode fields"
        if "calculate" not in text:
            return False, "Rate Calculator missing calculate action"
        return True, "rate calculator verified"

    if is_channel_target(module_name, description):
        canonical = resolve_doc_module(module_name, description).lower()
        if "amazon" in canonical and "/channels/amazon" in url and not allow_direct_channel_urls():
            return False, "direct /channels/amazon URL blocked — use Order Channels hub click"
        if not await channel_page_usable(page, module_name, description):
            return False, f"channel page not verified for {canonical}"
        if "amazon" in canonical and "amazon" not in text:
            return False, "Amazon channel content not visible"
        if "shopify" in canonical and "shopify" not in text:
            return False, "Shopify channel content not visible"
        return True, "channel verified"

    if is_add_order_target(module_name, description) or is_quick_add_target(module_name, description):
        if "/orders/new" in url and "/orders/add" not in url and "/quick-add" not in url:
            return False, "on New Orders list, not Add Order form"
        if is_quick_add_target(module_name, description):
            if "/quick-add" not in url and "/orders/add" not in url:
                return False, "not on Quick Add or Add Order URL"
        elif "/orders/add" not in url:
            return False, "not on Add Order URL (/orders/add)"
        if not await has_module_anchor(page):
            ready = await wait_for_module_content(page, timeout_s=8.0)
            if not ready:
                return False, "Add Order form fields not visible yet"
        if "new orders" in text and "/orders/add" not in url:
            return False, "New Orders list content — need Add Order form"
        return True, "add order form verified"

    if is_new_orders_target(module_name, description):
        if "/orders/new" not in url:
            return False, "not on New Orders URL (/orders/new)"
        if "/orders/add" in url:
            return False, "on Add Order form, not New Orders list"
        if not await has_module_anchor(page):
            ready = await wait_for_module_content(page, timeout_s=6.0)
            if not ready:
                return False, "New Orders list not ready"
        return True, "new orders verified"

    return True, "generic module ok"


def allow_direct_channel_urls() -> bool:
    return os.getenv("DOCS_CAPTURE_ALLOW_DIRECT_URL", "0").lower() in {"1", "true", "yes"}


async def _click_visible_text(page: Page, text: str, *, contains: str = "") -> bool:
    if not text:
        return False
    try:
        if contains:
            pat = re.compile(rf".*{re.escape(contains)}.*{re.escape(text)}.*", re.I)
            loc = page.get_by_text(pat)
        else:
            loc = page.get_by_text(re.compile(re.escape(text), re.I))
        if await loc.count() == 0:
            return False
        await loc.first.click(timeout=4000)
        await asyncio.sleep(0.8)
        return True
    except Exception:
        return False


async def apply_capture_heal_plan(
    page: Page,
    plan: dict[str, Any],
    *,
    module_name: str = "",
    description: str = "",
) -> dict[str, Any]:
    """Run heal plan: navSteps, quick search, hub/channel clicks; verify target module."""
    if not plan:
        return {"ok": False, "error": "empty heal plan"}

    await dismiss_blocking_overlays(page)
    steps_run: list[str] = []
    module_name = module_name or plan.get("moduleName") or ""
    description = description or plan.get("description") or ""

    nav_steps = plan.get("navSteps") or []
    if nav_steps:
        from panel_e2e.ai_script import execute_nav_script

        script = {
            "navSteps": nav_steps,
            "verifyTexts": plan.get("verifyTexts") or [],
        }
        result = await execute_nav_script(page, script)
        steps_run.extend(result.get("stepsRun") or [])
        verified, reason = await verify_module_target(page, module_name, description)
        if result.get("ok") and verified:
            return {
                "ok": True,
                "method": "navSteps",
                "stepsRun": steps_run,
                "pageUrl": page.url,
                "verifyReason": reason,
            }
        if not verified:
            return {
                "ok": False,
                "method": "navSteps",
                "error": reason,
                "stepsRun": steps_run,
                "pageUrl": page.url,
            }

    qs = plan.get("quickSearchQuery") or plan.get("quick_search_query") or ""
    if qs:
        result = await navigate_module_via_quick_search(page, qs, description)
        steps_run.append(f"quick_search:{qs} → {result.get('ok')}")
        if not result.get("ok"):
            return {
                "ok": False,
                "method": "quickSearch",
                "error": result.get("error") or f"Quick Search failed for {qs}",
                "stepsRun": steps_run,
                "pageUrl": page.url,
            }

    hub = plan.get("hubClickText") or plan.get("hub_click_text") or ""
    if hub:
        clicked = await _click_visible_text(page, hub)
        steps_run.append(f"hub_click:{hub} → {clicked}")
        if not clicked:
            return {
                "ok": False,
                "method": "hubClick",
                "error": f"Could not click hub item: {hub}",
                "stepsRun": steps_run,
                "pageUrl": page.url,
            }

    channel = plan.get("channelClickText") or plan.get("channel_click_text") or ""
    if channel:
        clicked = await _click_visible_text(page, channel)
        steps_run.append(f"channel_click:{channel} → {clicked}")
        if not clicked:
            return {
                "ok": False,
                "method": "channelClick",
                "error": f"Could not click channel: {channel}",
                "stepsRun": steps_run,
                "pageUrl": page.url,
            }

    verify_texts = plan.get("verifyTexts") or []
    if verify_texts and not await verify_heal_texts(page, verify_texts):
        return {
            "ok": False,
            "method": "verifyTexts",
            "error": f"verifyTexts not found on page: {verify_texts}",
            "stepsRun": steps_run,
            "pageUrl": page.url,
        }

    verified, reason = await verify_module_target(page, module_name, description)
    if nav_steps or qs or hub or channel:
        if not verified and is_rate_calculator_target(module_name, description):
            from panel_e2e.rate_calculator import quick_search_to_rate_calculator

            if await quick_search_to_rate_calculator(page):
                verified, reason = await verify_module_target(page, module_name, description)
                steps_run.append("fallback:quick_search_to_rate_calculator")
        return {
            "ok": verified,
            "method": "composite",
            "stepsRun": steps_run,
            "pageUrl": page.url,
            "verifyReason": reason,
            "error": None if verified else reason,
        }

    return {"ok": False, "error": "heal plan had no actionable steps", "stepsRun": steps_run}
