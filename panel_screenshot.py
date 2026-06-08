"""Wait for real module content before screenshots."""

from __future__ import annotations

import asyncio
import re
from urllib.parse import urlparse

from playwright.async_api import Page, TimeoutError as PlaywrightTimeoutError

from panel_page_state import page_looks_like_not_found, text_indicates_not_found

CHAT_CONTENT_TIMEOUT_S = 12
DOC_CONTENT_TIMEOUT_S = 22

MODULE_READY_SELECTORS: dict[str, list[str]] = {
    "/orders/quick-add": [
        'input[placeholder*="phone" i]',
        'input[aria-label*="phone" i]',
        'input[name*="phone" i]',
    ],
    "/orders/add": [
        'input[placeholder*="phone" i]',
        'input[placeholder*="name" i]',
        'button:has-text("Create")',
    ],
    "/orders/new": [
        'input[placeholder*="Search" i]',
        ".MuiDataGrid-root",
        "table tbody tr",
    ],
    "/billing": [
        ".MuiDataGrid-root",
        "table tbody tr",
        'button:has-text("Recharge")',
    ],
    "/channels": [
        ".MuiDataGrid-root",
        "table tbody tr",
        'text=Shopify',
        'button:has-text("Connect")',
    ],
    "/integrations": [
        ".MuiDataGrid-root",
        "table tbody tr",
        'text=Shopify',
        'text=Integration',
        'button:has-text("Connect")',
        'button:has-text("Add")',
        "main h1",
        "main h2",
    ],
    "/channels/shopify": [
        ".MuiDataGrid-root",
        "table tbody tr",
        'text=Shopify',
        'button:has-text("Connect")',
        'button:has-text("Sync")',
    ],
    "/ndr": [
        ".MuiDataGrid-root",
        "table tbody tr",
    ],
    "/settings": [
        "form",
        'input:not([type="hidden"])',
        "main h1, main h2",
    ],
}

DEFAULT_READY_SELECTORS = [
    "main table tbody tr",
    "main .MuiDataGrid-row",
    'main input:not([type="hidden"])',
    "main h1",
    "main h2",
]


def _path_key(url: str) -> str:
    path = urlparse(url).path.rstrip("/") or "/"
    for key in sorted(MODULE_READY_SELECTORS.keys(), key=len, reverse=True):
        if path == key or path.startswith(key + "/"):
            return key
    return path


def selectors_for_url(url: str) -> list[str]:
    return MODULE_READY_SELECTORS.get(_path_key(url), DEFAULT_READY_SELECTORS)


async def has_module_anchor(page: Page) -> bool:
    for sel in selectors_for_url(page.url):
        try:
            loc = page.locator(sel).first
            if await loc.count() > 0 and await loc.is_visible():
                return True
        except Exception:
            continue
    return False


async def main_text_length(page: Page) -> int:
    for sel in ("main", '[role="main"]', "body"):
        try:
            loc = page.locator(sel).first
            if await loc.count() == 0:
                continue
            text = await loc.inner_text(timeout=3000)
            return len(re.sub(r"\s+", " ", (text or "").strip()))
        except Exception:
            continue
    return 0


async def page_has_usable_content(page: Page, *, min_len: int = 150) -> bool:
    if await page_looks_like_not_found(page):
        return False
    if await has_module_anchor(page):
        return True
    return await main_text_length(page) >= min_len


async def wait_for_module_content(page: Page, *, timeout_s: float = CHAT_CONTENT_TIMEOUT_S) -> bool:
    """Wait until first module anchor is visible (fast, single pass)."""
    selectors = selectors_for_url(page.url)
    deadline = asyncio.get_event_loop().time() + timeout_s
    per_try_ms = max(2500, int((timeout_s * 1000) / max(len(selectors), 1)))

    while asyncio.get_event_loop().time() < deadline:
        remaining = int((deadline - asyncio.get_event_loop().time()) * 1000)
        if remaining <= 0:
            break
        for sel in selectors:
            try:
                await page.wait_for_selector(
                    sel, state="visible", timeout=min(per_try_ms, remaining)
                )
                await asyncio.sleep(0.6)
                if await has_module_anchor(page):
                    return True
            except PlaywrightTimeoutError:
                continue
            except Exception:
                continue
        await asyncio.sleep(0.4)

    return await has_module_anchor(page)


async def wait_for_loaders_gone(page: Page, *, timeout_s: float = 4) -> None:
    try:
        await page.wait_for_function(
            """() => {
              const vis = (el) => {
                const r = el.getBoundingClientRect();
                const s = getComputedStyle(el);
                if (s.display === 'none' || s.visibility === 'hidden') return false;
                if (r.width < 28 || r.height < 28) return false;
                const cx = r.left + r.width / 2;
                const cy = r.top + r.height / 2;
                const vw = window.innerWidth, vh = window.innerHeight;
                return cx > vw * 0.25 && cx < vw * 0.8 && cy > vh * 0.12 && cy < vh * 0.88;
              };
              for (const el of document.querySelectorAll(
                '.MuiCircularProgress-root, .MuiLinearProgress-root, [role="progressbar"]'
              )) {
                if (vis(el)) return false;
              }
              return true;
            }""",
            timeout=int(timeout_s * 1000),
        )
    except Exception:
        pass


async def get_page_ui_state(page: Page) -> dict:
    anchor = await has_module_anchor(page)
    return {"mainTextLen": 300 if anchor else 0, "isLoading": not anchor, "filterOpen": False}


def is_ready_for_module_screenshot(state: dict) -> bool:
    return not state.get("isLoading")


async def wait_for_page_ready(page: Page, *, max_wait_s: float = 10) -> dict:
    ok = await wait_for_module_content(page, timeout_s=max_wait_s)
    return {"moduleReady": ok, "isLoading": not ok}


async def prepare_for_screenshot(page: Page, *, max_wait_s: float = DOC_CONTENT_TIMEOUT_S) -> tuple[bool, dict]:
    if await page_looks_like_not_found(page):
        return False, {"notFound": True}
    if not await wait_for_module_content(page, timeout_s=max_wait_s):
        return False, await get_page_ui_state(page)
    await wait_for_loaders_gone(page, timeout_s=5)
    return True, await get_page_ui_state(page)


def poor_screenshot_label(label: str) -> bool:
    lower = (label or "").lower()
    return any(
        x in lower
        for x in ("filter", "search/filter", "loading", "scrolled", "full page", "row selected")
    )
