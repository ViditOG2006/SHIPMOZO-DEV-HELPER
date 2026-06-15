"""Custom panel UI checks from plain-text requirements (filters, Shopify, etc.)."""

from __future__ import annotations

import re

from playwright.async_api import Page

from panel_page_state import page_looks_like_not_found
from panel_quick_search import navigate_via_quick_search
from panel_screenshot import wait_for_loaders_gone
from panel_ui_helpers import dismiss_blocking_overlays


async def _page_has_any_text(page: Page, patterns: list[str]) -> bool:
    blob = ""
    try:
        blob = (await page.locator("body").inner_text(timeout=5000) or "").lower()
    except Exception:
        return False
    for pat in patterns:
        p = str(pat or "").strip().lower()
        if p and p in blob:
            return True
    return False


async def run_panel_ui_check(
    page: Page,
    *,
    module_query: str = "",
    verify_texts: list[str] | None = None,
    check_notes: str = "",
    scenario_id: str = "UI-000",
) -> dict:
    steps: list[str] = []
    query = (module_query or "").strip() or (check_notes or "").split("-")[0].strip()
    patterns = [t for t in (verify_texts or []) if str(t).strip()]
    if not patterns and check_notes:
        patterns = [w for w in re.findall(r"[a-zA-Z]{4,}", check_notes.lower())[:6]]

    await dismiss_blocking_overlays(page)
    steps.append(f"panel_ui_check:{scenario_id}")

    if query:
        logs: list[str] = []
        ok_nav = await navigate_via_quick_search(page, query, logs=logs)
        steps.extend(logs[:8])
        if not ok_nav and "warehouse" in query.lower():
            try:
                await page.goto("https://panel.appiify.com/warehouse", wait_until="domcontentloaded", timeout=20000)
                await wait_for_loaders_gone(page)
                ok_nav = "warehouse" in (page.url or "").lower()
                if ok_nav:
                    steps.append("nav:direct_url /warehouse")
            except Exception:
                ok_nav = False
        if not ok_nav:
            return {
                "ok": False,
                "error": f'Could not open "{query}" via Quick Search',
                "stepsRun": steps,
                "pageUrl": page.url,
            }

    await wait_for_loaders_gone(page)
    steps.append(f"url:{page.url}")

    if await page_looks_like_not_found(page):
        return {
            "ok": False,
            "error": "Landed on not-found / broken page",
            "stepsRun": steps,
            "pageUrl": page.url,
        }

    url_low = (page.url or "").lower()
    if patterns:
        found = await _page_has_any_text(page, patterns)
        if not found and "shopify" in (query or check_notes or "").lower():
            if "integration" in url_low or "channel" in url_low:
                found = True
                steps.append("verify:url_integration_fallback")
        if not found and "integration" in (query or check_notes or "").lower():
            if "integration" in url_low:
                found = True
                steps.append("verify:url_integration_path")
        if not found and "warehouse" in (query or check_notes or "").lower():
            if "warehouse" in url_low:
                found = True
                steps.append("verify:url_warehouse_path")
        steps.append(f"verify:{','.join(patterns)}={'ok' if found else 'missing'}")
        if not found:
            try:
                body_preview = (await page.locator("body").inner_text(timeout=4000) or "")[:300]
            except Exception:
                body_preview = ""
            missing = [pat for pat in patterns if not await _page_has_any_text(page, [pat])]
            return {
                "ok": False,
                "error": f"Expected on-page text not found (need any of): {', '.join(missing)}",
                "stepsRun": steps,
                "pageUrl": page.url,
                "uiText": missing,
                "bodyPreview": body_preview.replace("\n", " ").strip()[:240],
            }

    try:
        body = (await page.locator("body").inner_text(timeout=4000) or "")[:500]
    except Exception:
        body = ""

    return {
        "ok": True,
        "stepsRun": steps,
        "pageUrl": page.url,
        "uiText": patterns,
        "bodyPreview": body.replace("\n", " ").strip()[:240],
    }
