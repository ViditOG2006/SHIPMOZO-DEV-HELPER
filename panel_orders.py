"""Helpers for New Orders list — reset filters so test orders are visible."""

from __future__ import annotations

import asyncio
import os
import re
from datetime import datetime

from playwright.async_api import Page

from panel_e2e.e2e_log import e2e_log
from panel_ui_helpers import dismiss_blocking_overlays


async def _clear_visible_inputs(page: Page, pattern: str) -> int:
    cleared = 0
    try:
        loc = page.locator(pattern)
        count = min(await loc.count(), 6)
        for i in range(count):
            el = loc.nth(i)
            if not await el.is_visible():
                continue
            await el.click(timeout=2000)
            await el.fill("")
            cleared += 1
    except Exception:
        pass
    return cleared


async def reset_new_orders_list_filters(page: Page) -> None:
    """Clear date range / search filters that hide newly created orders."""
    await dismiss_blocking_overlays(page)

    try:
        await page.keyboard.press("Escape")
        await asyncio.sleep(0.2)
    except Exception:
        pass

    # Dismiss corrupted alert banners (automation sometimes types into global fields)
    for pat in (r"^×$", r"close", r"dismiss"):
        try:
            btn = page.get_by_role("button", name=re.compile(pat, re.I))
            if await btn.count() > 0:
                await btn.first.click(timeout=1500)
                await asyncio.sleep(0.15)
        except Exception:
            pass

    cleared = 0
    cleared += await _clear_visible_inputs(
        page,
        'input[placeholder*="date" i], input[placeholder*="from" i], input[placeholder*="to" i]',
    )
    cleared += await _clear_visible_inputs(page, 'input[type="date"]')

    # MUI / custom date range text inputs near "to" label
    try:
        for loc in await page.locator("input").all():
            if not await loc.is_visible():
                continue
            val = await loc.input_value()
            ph = (await loc.get_attribute("placeholder") or "").lower()
            aria = (await loc.get_attribute("aria-label") or "").lower()
            if not val:
                continue
            if any(k in ph + aria for k in ("date", "from", "to", "range")) or re.search(r"\d{2}-\d{2}-\d{4}", val):
                await loc.fill("")
                cleared += 1
    except Exception:
        pass

    for label in ("Clear filters", "Clear", "Reset", "Reset filters"):
        try:
            btn = page.get_by_role("button", name=re.compile(re.escape(label), re.I))
            if await btn.count() > 0 and await btn.first.is_visible():
                await btn.first.click(timeout=2000)
                cleared += 1
                await asyncio.sleep(0.4)
                break
        except Exception:
            continue

    cleared += await _clear_visible_inputs(
        page,
        'input[placeholder*="reference" i], input[placeholder*="search" i], input[type="search"]',
    )

    e2e_log("orders", f"Reset New Orders filters (cleared ~{cleared} field(s)) — {page.url}")


async def search_new_orders(page: Page, query: str) -> bool:
    """Search by reference / order id on Forward > Domestic > New."""
    await reset_new_orders_list_filters(page)
    q = (query or "").strip()
    if not q:
        return False

    search = None
    for sel in (
        'input[placeholder*="reference" i]',
        'input[placeholder*="Search" i]',
        'input[type="search"]',
    ):
        loc = page.locator(sel).first
        try:
            if await loc.count() > 0 and await loc.is_visible():
                search = loc
                break
        except Exception:
            continue

    if not search:
        e2e_log("orders", "Search input not found on New Orders")
        return False

    await search.fill(q)
    await page.keyboard.press("Enter")
    fast = os.getenv("E2E_FAST", "").lower() in {"1", "true", "yes"}
    await asyncio.sleep(0.8 if fast else 2.5)
    hay = (await page.inner_text("body")).lower()
    return q.lower() in hay


async def goto_new_orders_domestic(page: Page, base: str) -> None:
    url = f"{base.rstrip('/')}/orders/new"
    if "/orders/new" not in (page.url or ""):
        await page.goto(url, wait_until="domcontentloaded")
        try:
            await page.wait_for_load_state("networkidle", timeout=12000)
        except Exception:
            pass
    for tab in ("Forward", "Domestic", "New"):
        try:
            t = page.get_by_role("tab", name=re.compile(re.escape(tab), re.I))
            if await t.count() > 0 and await t.first.is_visible():
                await t.first.click(timeout=3000)
                await asyncio.sleep(0.3)
        except Exception:
            try:
                link = page.get_by_text(re.compile(rf"^{re.escape(tab)}$", re.I))
                if await link.count() > 0:
                    await link.first.click(timeout=3000)
                    await asyncio.sleep(0.3)
            except Exception:
                pass
    await reset_new_orders_list_filters(page)


def today_dd_mm_yyyy() -> str:
    return datetime.now().strftime("%d-%m-%Y")
