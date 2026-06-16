"""Wait for real module content before screenshots."""

from __future__ import annotations

import asyncio
import os
import re
from urllib.parse import urlparse

from playwright.async_api import Locator, Page, TimeoutError as PlaywrightTimeoutError

from panel_page_state import page_looks_like_not_found, text_indicates_not_found


def is_render_deploy() -> bool:
    return os.getenv("RENDER", "").lower() in {"true", "1", "yes"} or bool(
        os.getenv("RENDER_EXTERNAL_URL", "").strip()
    )


def screenshot_timeout_ms() -> int:
    explicit = os.getenv("DOCS_SCREENSHOT_TIMEOUT_MS", "").strip()
    if explicit:
        return max(8000, int(explicit))
    if is_render_deploy():
        return 45_000
    return 8000


def screenshot_kwargs(**extra) -> dict:
    return {
        "timeout": screenshot_timeout_ms(),
        "animations": "disabled",
        **extra,
    }


async def take_page_screenshot(page: Page, path: str, *, full_page: bool = False) -> None:
    if is_render_deploy():
        await asyncio.sleep(0.4)
    await page.screenshot(path=path, full_page=full_page, **screenshot_kwargs())


async def take_element_screenshot(locator: Locator, path: str) -> None:
    if is_render_deploy():
        await asyncio.sleep(0.2)
    await locator.screenshot(path=path, **screenshot_kwargs())

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
        'input[placeholder*="pin" i]',
        'button:has-text("Create")',
        'button:has-text("Save")',
        "form",
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
    "/courier/rate-calculator": [
        'input[placeholder*="pincode" i]',
        'input[name*="pincode" i]',
        'button:has-text("Calculate")',
        "text=Origin",
        "text=Domestic",
    ],
    "/couriers/rate-calculator": [
        'input[placeholder*="pincode" i]',
        'button:has-text("Calculate")',
    ],
    "/tools/rate-calculator": [
        'input[placeholder*="pincode" i]',
        'button:has-text("Calculate")',
    ],
    "/courier/manage-courier": [
        'button:has-text("Calculate")',
        '[role="tab"]:has-text("Rate")',
        'input[placeholder*="pincode" i]',
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
    from panel_ui_helpers import dismiss_blocking_overlays, page_has_blocking_dialog

    await dismiss_blocking_overlays(page)
    if await page_has_blocking_dialog(page):
        return False, {"blockingDialog": True}
    if await page_looks_like_not_found(page):
        return False, {"notFound": True}
    wait_s = max_wait_s
    if is_render_deploy():
        wait_s = max(wait_s, 28.0)
    if not await wait_for_module_content(page, timeout_s=wait_s):
        return False, await get_page_ui_state(page)
    loader_timeout = 8.0 if is_render_deploy() else 5.0
    await wait_for_loaders_gone(page, timeout_s=loader_timeout)
    if is_render_deploy():
        await asyncio.sleep(0.5)
    return True, await get_page_ui_state(page)


def poor_screenshot_label(label: str) -> bool:
    lower = (label or "").lower()
    return any(
        x in lower
        for x in ("filter", "search/filter", "loading", "scrolled", "full page", "row selected")
    )
