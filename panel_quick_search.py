"""Shipmozo panel Quick Search navigation (Ctrl+B from dashboard)."""

from __future__ import annotations

import asyncio
import os
import re
from collections.abc import Awaitable, Callable
from typing import Any

from playwright.async_api import Page

from panel_doc_module import (
    channel_hub_quick_search_module,
    docs_capture_use_nav_map,
    is_add_order_target,
    is_channel_target,
    is_new_orders_target,
    is_quick_add_target,
    is_specific_channel_target,
    resolve_doc_module,
)
from panel_navigate import navigate_module_via_nav_map
from panel_e2e.e2e_log import e2e_log
from panel_page_state import url_looks_like_broken_nav
from panel_ui_helpers import dismiss_blocking_overlays
from shipmozo_login import is_logged_in

VerifyFn = Callable[[Page], Awaitable[bool]]

DOCS_CAPTURE_FAST = os.getenv("DOCS_CAPTURE_FAST", "1").lower() in {"1", "true", "yes"}


def _docs_fast() -> bool:
    return DOCS_CAPTURE_FAST


def _log(logs: list[str] | None, message: str) -> None:
    if logs is not None:
        logs.append(message)


BREADCRUMB_PATTERNS = (
    re.compile(r"Tools\s*[→➜\->]\s*Rate\s*Calculator", re.I),
    re.compile(r"Rate\s*Calculator", re.I),
    re.compile(r"Channels\s*[→➜\->]", re.I),
    re.compile(r"Order\s*Channels", re.I),
    re.compile(r"Integration\s*[→➜\->]\s*Amazon", re.I),
    re.compile(r"Channels\s*[→➜\->]\s*Amazon", re.I),
    re.compile(r"Amazon\s*Integration", re.I),
    re.compile(r"Integration\s*[→➜\->]\s*Shopify", re.I),
    re.compile(r"Shopify\s*Integration", re.I),
)


async def _focus_panel(page: Page) -> None:
    await dismiss_blocking_overlays(page)
    for sel in ("main", "[role='main']", "body"):
        try:
            loc = page.locator(sel).first
            if await loc.count() > 0:
                await loc.click(position={"x": 120, "y": 200}, timeout=2000)
                await asyncio.sleep(0.05)
                return
        except Exception:
            continue


async def _quick_search_input(page: Page):
    candidates = [
        page.get_by_placeholder(re.compile(r"quick\s*search", re.I)),
        page.locator('input[placeholder*="Quick Search" i]'),
        page.locator('input[placeholder*="search pages" i]'),
        page.locator('[role="dialog"] input[type="text"]'),
        page.locator('[class*="modal" i] input[type="text"]'),
        page.locator('[class*="search" i] input').first,
    ]
    for loc in candidates:
        try:
            if await loc.count() > 0 and await loc.first.is_visible():
                return loc.first
        except Exception:
            continue
    return None


async def open_quick_search(page: Page, logs: list[str] | None = None) -> bool:
    await _focus_panel(page)
    for hotkey in ("Control+b", "Shift+b", "Meta+b"):
        try:
            await page.keyboard.press(hotkey)
            await asyncio.sleep(0.22)
            inp = await _quick_search_input(page)
            if inp:
                _log(logs, f"Opened Quick Search ({hotkey})")
                return True
        except Exception:
            continue
    _log(logs, "Could not open Quick Search (Ctrl+B)")
    return False


async def _click_breadcrumb_result(page: Page, logs: list[str] | None = None) -> bool:
    for pat in BREADCRUMB_PATTERNS:
        try:
            loc = page.get_by_text(pat)
            count = min(await loc.count(), 8)
            for i in range(count):
                item = loc.nth(i)
                if not await item.is_visible():
                    continue
                text = (await item.inner_text() or "").strip()
                low = text.lower()
                if "quick search" in low and len(text) < 24:
                    continue
                if "manage courier" in low and "rate calcul" not in low:
                    _log(logs, f'Skipped bad result "{text[:60]}" (manage-courier trap)')
                    continue
                await item.click(timeout=3000)
                await asyncio.sleep(0.2)
                _log(logs, f'Clicked result "{text[:80]}"')
                return True
        except Exception:
            continue
    return False


async def _keyboard_select_first_result(page: Page, logs: list[str] | None = None) -> bool:
    try:
        await page.keyboard.press("ArrowDown")
        await asyncio.sleep(0.08)
        await page.keyboard.press("Enter")
        await asyncio.sleep(0.2)
        _log(logs, "Selected first result (ArrowDown + Enter)")
        return True
    except Exception:
        return False


async def _click_search_result(page: Page, query: str, logs: list[str] | None = None) -> bool:
    if await _click_breadcrumb_result(page, logs):
        return True

    q = re.escape(query.strip())
    if not q:
        return False

    patterns = [
        page.get_by_role("option", name=re.compile(q, re.I)),
        page.locator(f'[class*="search" i] >> text=/{q}/i'),
        page.get_by_text(re.compile(rf".*{q}.*", re.I)),
    ]
    for loc in patterns:
        try:
            count = min(await loc.count(), 6)
            for i in range(count):
                item = loc.nth(i)
                if not await item.is_visible():
                    continue
                text = (await item.inner_text() or "").strip()
                low = text.lower()
                if "quick search" in low and len(text) < 20:
                    continue
                if "manage courier" in low and "rate calcul" not in low:
                    _log(logs, f'Skipped bad result "{text[:60]}"')
                    continue
                await item.click(timeout=3000)
                await asyncio.sleep(0.2)
                _log(logs, f'Clicked "{text[:80]}"')
                return True
        except Exception:
            continue

    return await _keyboard_select_first_result(page, logs)


async def navigate_via_quick_search(
    page: Page,
    query: str,
    *,
    verify_fn: VerifyFn | None = None,
    timeout_s: float = 3.5,
    logs: list[str] | None = None,
) -> bool:
    """Open Ctrl+B search, type query, select result (e.g. Tools → Rate Calculator)."""
    raw = (query or "").strip()
    if not raw:
        return False

    search_terms: list[str] = []
    low = raw.lower()
    if "calcul" in low:
        search_terms.extend(["rate calculator", "Rate Calculator", raw])
    elif "amazon" in low:
        search_terms.extend(
            ["order channels", "channels", "integrations", raw, "amazon integration", "amazon channel"]
        )
    elif "shopify" in low:
        search_terms.extend(
            ["order channels", "channels", "integrations", raw, "shopify integration", "shopify"]
        )
    elif "woocommerce" in low:
        search_terms.extend(
            ["order channels", "channels", "integrations", raw, "woocommerce integration"]
        )
    elif "channel" in low or "integration" in low:
        search_terms.extend(["order channels", "channels", "integrations", raw])
    elif "warehouse" in low:
        search_terms.extend(["warehouse", "Warehouses", "Warehouse", raw])
    elif is_quick_add_target(raw) or ("quick" in low and "add" in low):
        search_terms.extend(["quick add", "Quick Add", "add order", "Add Order", raw])
    elif is_add_order_target(raw) or (
        re.search(r"\b(add|create|place)\b", low) and "order" in low
    ):
        search_terms.extend(["add order", "Add Order", raw])
    elif is_new_orders_target(raw) or ("new" in low and "order" in low):
        search_terms.extend(["new orders", "New Orders", raw])
    elif "order" in low:
        search_terms.extend([raw, "orders"])
    else:
        search_terms.append(raw)

    max_terms = 4 if _docs_fast() else len(search_terms)
    max_attempts = 1 if _docs_fast() else 2
    for term in list(dict.fromkeys(search_terms))[:max_terms]:
        for attempt in range(max_attempts):
            _log(logs, f'— Try Quick Search: "{term}" (attempt {attempt + 1})')
            if not await open_quick_search(page, logs):
                continue
            inp = await _quick_search_input(page)
            if not inp:
                _log(logs, "Quick Search input not found")
                continue
            try:
                await inp.click(timeout=2000)
                await inp.fill("")
                await inp.type(term, delay=12)
                await asyncio.sleep(0.15)
            except Exception:
                try:
                    await inp.fill(term)
                    await asyncio.sleep(0.15)
                except Exception:
                    _log(logs, "Failed to type in Quick Search")
                    continue

            _log(logs, f'Typed "{term}" — waiting for results…')
            clicked = await _click_search_result(page, term, logs)
            if not clicked:
                try:
                    await inp.press("Enter")
                    await asyncio.sleep(0.2)
                    _log(logs, "Pressed Enter on search field")
                except Exception:
                    pass

            if url_looks_like_broken_nav(page.url or ""):
                _log(logs, f"Rejected broken URL after search: {page.url}")
                e2e_log("quick-search", f"Broken URL after click: {page.url}")
                continue

            if "/login" in (page.url or "").lower() or not await is_logged_in(page):
                _log(logs, f"Rejected login redirect after search: {page.url}")
                continue

            deadline = asyncio.get_event_loop().time() + timeout_s
            while asyncio.get_event_loop().time() < deadline:
                if url_looks_like_broken_nav(page.url or ""):
                    _log(logs, f"On broken route: {page.url}")
                    break
                if verify_fn:
                    if await verify_fn(page):
                        _log(logs, f"Verified target page: {page.url}")
                        return True
                else:
                    inp_visible = await _quick_search_input(page)
                    if not inp_visible or not await inp_visible.is_visible():
                        _log(logs, f"Navigated: {page.url}")
                        return True
                await asyncio.sleep(0.1)

            if verify_fn and await verify_fn(page):
                _log(logs, f"Verified after wait: {page.url}")
                return True

    _log(logs, f'Quick Search failed for "{raw}"')
    return False


def _hub_search_queries(module_name: str, description: str = "") -> list[str]:
    """Quick Search terms for Order Channels / Integrations hub (not a specific channel)."""
    seen: set[str] = set()
    out: list[str] = []

    def add(value: str) -> None:
        v = (value or "").strip()
        if not v or v.lower() in seen:
            return
        seen.add(v.lower())
        out.append(v)

    hub = channel_hub_quick_search_module(module_name, description)
    add(hub)
    add("order channels")
    add("Order Channels")
    add("channels")
    add("Channels")
    add("integrations")
    add("Integrations")
    return out


def _search_queries(module_name: str, description: str = "") -> list[str]:
    canonical = resolve_doc_module(module_name, description)
    seen: set[str] = set()
    out: list[str] = []

    def add(value: str) -> None:
        v = (value or "").strip()
        if not v or v.lower() in seen:
            return
        seen.add(v.lower())
        out.append(v)

    canon_low = canonical.lower()
    if "calcul" in canon_low:
        add("rate calculator")
        add("Rate Calculator")
    elif is_quick_add_target(module_name, description):
        add("Quick Add")
        add("quick add")
        add("Add Order")
    elif is_add_order_target(module_name, description):
        add("Add Order")
        add("add order")
    elif is_new_orders_target(module_name, description):
        add("New Orders")
        add("new orders")
    elif is_specific_channel_target(module_name, description):
        out.extend(_hub_search_queries(module_name, description))
        if "amazon" in canon_low:
            add("amazon integration")
        elif "shopify" in canon_low:
            add("shopify integration")
        return out
    elif is_channel_target(module_name, description):
        out.extend(_hub_search_queries(module_name, description))
        return out

    add(canonical)
    mod_low = (module_name or "").lower().strip()
    desc_low = (description or "").lower().strip()
    if mod_low and mod_low not in seen and mod_low != canon_low:
        add(module_name)
    if desc_low and desc_low not in seen and desc_low != mod_low:
        add(description)
    return out


async def navigate_module_via_quick_search(
    page: Page,
    module_name: str,
    description: str = "",
    *,
    verify_fn: VerifyFn | None = None,
    timeout_s: float | None = None,
) -> dict[str, Any]:
    if timeout_s is None:
        timeout_s = 3.5 if _docs_fast() else 6.0
    all_logs: list[str] = []
    queries = _search_queries(module_name, description)
    max_queries = 4 if _docs_fast() else len(queries)
    for query in queries[:max_queries]:
        logs: list[str] = []
        ok = await navigate_via_quick_search(
            page, query, verify_fn=verify_fn, timeout_s=timeout_s, logs=logs
        )
        all_logs.extend(logs)
        if ok and (not verify_fn or await verify_fn(page)):
            return {"ok": True, "query": query, "pageUrl": page.url, "logs": all_logs}

    if docs_capture_use_nav_map():
        nav = await navigate_module_via_nav_map(
            page, module_name, description, verify_fn=verify_fn, max_pages=4
        )
        all_logs.extend(nav.get("logs") or [])
        if nav.get("ok") and (not verify_fn or await verify_fn(page)):
            nav_page = nav.get("navPage") or {}
            return {
                "ok": True,
                "query": f"nav_map:{nav_page.get('text', module_name)}",
                "pageUrl": page.url,
                "logs": all_logs,
                "method": nav.get("method"),
            }

    return {"ok": False, "query": None, "pageUrl": page.url, "logs": all_logs}
