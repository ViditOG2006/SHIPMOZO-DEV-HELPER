"""Shipmozo panel navigation — fast direct URL for Chat, sidebar fallback for docs."""

from __future__ import annotations

import asyncio
import re
from urllib.parse import urlparse

from playwright.async_api import Page

from panel_page_state import page_looks_like_not_found, text_indicates_not_found
from panel_screenshot import CHAT_CONTENT_TIMEOUT_S, wait_for_module_content
from shipmozo_login import LOGIN_URLS

PANEL_BASE = LOGIN_URLS[0].rstrip("/")

__all__ = [
    "navigate_to_nav_page",
    "navigate_for_chat",
    "navigate_module_via_nav_map",
    "page_looks_like_not_found",
    "text_indicates_not_found",
    "hub_for_href",
    "PANEL_BASE",
]


def hub_for_href(href: str) -> str:
    path = urlparse(href).path.lower()
    if "/billing" in path or "/wallet" in path:
        return f"{PANEL_BASE}/billing"
    if "/channel" in path or "/integration" in path or "/shopify" in path:
        return f"{PANEL_BASE}/channels"
    if "/settings" in path or "/profile" in path:
        return f"{PANEL_BASE}/settings"
    if "/ndr" in path or "/shipment" in path:
        return f"{PANEL_BASE}/ndr"
    if "/orders" in path or "/quick" in path:
        return f"{PANEL_BASE}/orders/new"
    if "/courier" in path or "rate-calculator" in path or "/tools" in path:
        return f"{PANEL_BASE}/dashboard"
    return f"{PANEL_BASE}/dashboard"


async def expand_sidebar_sections(page: Page) -> None:
    for sel in ("aside [aria-expanded='false']", "nav [aria-expanded='false']"):
        try:
            loc = page.locator(sel)
            for i in range(min(await loc.count(), 6)):
                try:
                    item = loc.nth(i)
                    if await item.is_visible():
                        await item.click(timeout=800)
                        await asyncio.sleep(0.1)
                except Exception:
                    continue
        except Exception:
            continue


async def _try_click(page: Page, selector: str) -> bool:
    try:
        loc = page.locator(selector).first
        if await loc.count() == 0:
            return False
        await loc.click(timeout=5000)
        await page.wait_for_load_state("domcontentloaded")
        await asyncio.sleep(0.5)
        return True
    except Exception:
        return False


async def click_nav_link(page: Page, text: str, href: str) -> bool:
    path = urlparse(href).path or "/"
    safe = re.sub(r'["\\]', "", text or "").strip()
    candidates = [f'aside a[href="{path}"]', f'a[href="{path}"]', f'a[href*="{path.strip("/")}"]']
    if safe:
        candidates.append(f'aside a:has-text("{safe}")')
    for sel in candidates:
        if await _try_click(page, sel):
            return True
    return False


async def navigate_for_chat(page: Page, nav_page: dict[str, str]) -> tuple[bool, bool]:
    from panel_ui_helpers import dismiss_blocking_overlays

    await dismiss_blocking_overlays(page)
    """
    Fast Chat navigation: direct goto first, short content wait.
    Returns (reached, content_ready).
    """
    href = nav_page.get("href", "")
    text = nav_page.get("text", "")
    if not href:
        return False, False

    try:
        await page.goto(href, wait_until="domcontentloaded", timeout=28000)
        if not await page_looks_like_not_found(page):
            ready = await wait_for_module_content(page, timeout_s=CHAT_CONTENT_TIMEOUT_S)
            if ready:
                return True, True
    except Exception:
        pass

    hub = hub_for_href(href)
    try:
        await page.goto(hub, wait_until="domcontentloaded", timeout=25000)
        await asyncio.sleep(0.6)
        await expand_sidebar_sections(page)
        if await click_nav_link(page, text, href):
            if not await page_looks_like_not_found(page):
                ready = await wait_for_module_content(page, timeout_s=10)
                return True, ready
    except Exception:
        pass

    return False, False


async def navigate_to_nav_page(
    page: Page,
    nav_page: dict[str, str],
    *,
    ready_wait_s: float = 22,
) -> bool:
    """Module docs: sidebar path with longer wait."""
    href = nav_page.get("href", "")
    text = nav_page.get("text", "")
    if not href:
        return False

    reached, ready = await navigate_for_chat(page, nav_page)
    if reached and ready:
        return True

    try:
        await page.goto(href, wait_until="domcontentloaded", timeout=35000)
        if not await page_looks_like_not_found(page):
            return await wait_for_module_content(page, timeout_s=ready_wait_s)
    except Exception:
        pass

    return False


async def navigate_module_via_nav_map(
    page: Page,
    module_name: str,
    description: str = "",
    *,
    verify_fn=None,
    discovered: list | None = None,
    max_pages: int = 5,
) -> dict:
    """
    Navigate using data/panel-navigation.json when Quick Search fails.
    Tries sidebar click first, then trusted href goto from the nav map.
    """
    from panel_doc_module import docs_capture_allow_nav_map_url, docs_capture_use_nav_map
    from panel_navigation import rank_pages_for_module
    from panel_page_state import url_looks_like_broken_nav
    from panel_ui_helpers import dismiss_blocking_overlays

    if not docs_capture_use_nav_map():
        return {"ok": False, "error": "nav map disabled", "method": "nav_map"}

    ranked = rank_pages_for_module(module_name, description, discovered)
    if not ranked:
        return {"ok": False, "error": "no nav map match", "method": "nav_map"}

    await dismiss_blocking_overlays(page)
    logs: list[str] = []
    allow_goto = docs_capture_allow_nav_map_url()

    for nav_page in ranked[:max_pages]:
        text = nav_page.get("text", "")
        href = nav_page.get("href", "")
        logs.append(f"nav map try: {text} → {href}")

        if href and "manage-courier" in href.lower():
            logs.append("skip manage-courier trap")
            continue

        if await navigate_to_nav_page(page, nav_page, ready_wait_s=12):
            if verify_fn is None or await verify_fn(page):
                return {
                    "ok": True,
                    "method": "nav_map_sidebar",
                    "navPage": nav_page,
                    "pageUrl": page.url,
                    "logs": logs,
                }
            logs.append(f"sidebar reached but verify failed: {page.url}")

        if allow_goto and href and not url_looks_like_broken_nav(href):
            try:
                await page.goto(href, wait_until="domcontentloaded", timeout=28000)
                await asyncio.sleep(1.0)
                if not await page_looks_like_not_found(page):
                    if verify_fn is None or await verify_fn(page):
                        return {
                            "ok": True,
                            "method": "nav_map_goto",
                            "navPage": nav_page,
                            "pageUrl": page.url,
                            "logs": logs,
                        }
                    logs.append(f"goto ok but verify failed: {page.url}")
            except Exception as exc:
                logs.append(f"goto failed: {exc}")

    return {"ok": False, "error": "nav map routes exhausted", "method": "nav_map", "logs": logs}
