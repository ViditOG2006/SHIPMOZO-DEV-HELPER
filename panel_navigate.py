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
