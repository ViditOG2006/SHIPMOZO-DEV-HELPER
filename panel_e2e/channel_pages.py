"""Channel / integration page detection (Shopify, Integrations)."""

from __future__ import annotations

import asyncio
import re
from urllib.parse import urlparse

from playwright.async_api import Page

from panel_doc_module import (
    docs_capture_allow_direct_urls,
    is_channel_target,
    is_specific_channel_target,
    resolve_doc_module,
)
from panel_page_state import page_looks_like_not_found, url_looks_like_broken_nav
from panel_quick_search import navigate_module_via_quick_search
from panel_ui_helpers import dismiss_blocking_overlays
from panel_url import panel_origin


def _path_is_channel_hub(url: str) -> bool:
    path = urlparse(url or "").path.rstrip("/").lower()
    return path in ("/channels", "/integrations")


async def on_channel_hub_page(page: Page) -> bool:
    """True when on the Order Channels / Integrations list hub (not a specific channel)."""
    if await page_looks_like_not_found(page):
        return False
    if url_looks_like_broken_nav(page.url or ""):
        return False
    url = (page.url or "").lower()
    if not ("/channels" in url or "/integrations" in url):
        return False
    if _path_is_channel_hub(url):
        return True
    path = urlparse(url).path.rstrip("/").lower()
    if path.startswith("/channels/") or path.startswith("/integrations/"):
        return False
    return "/channels" in url or "/integrations" in url


async def on_channel_page(page: Page, module_name: str = "", description: str = "") -> bool:
    if await page_looks_like_not_found(page):
        return False
    if url_looks_like_broken_nav(page.url or ""):
        return False

    url = (page.url or "").lower()
    canonical = resolve_doc_module(module_name, description).lower()

    if "shopify" in canonical and "shopify" not in url:
        return False
    if "amazon" in canonical and "amazon" not in url:
        return False
    if "integration" in canonical and "/integrations" not in url and "/channels" not in url:
        return False

    try:
        text = (
            await page.evaluate(
                "() => (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 3000).toLowerCase()"
            )
            or ""
        )
    except Exception:
        return False

    if "shopify" in canonical:
        return "shopify" in text and any(
            w in text for w in ("channel", "connect", "store", "integration", "sync")
        )
    if "amazon" in canonical:
        return "amazon" in text and any(
            w in text for w in ("channel", "connect", "seller", "integration", "sync", "store")
        )
    if "integration" in canonical:
        return any(w in text for w in ("integration", "channel", "connect", "shopify"))
    return "/channels" in url or "/integrations" in url


async def channel_page_usable(page: Page, module_name: str = "", description: str = "") -> bool:
    """Strict channel check, then relaxed URL + content fallback for screenshots."""
    if await on_channel_page(page, module_name, description):
        return True
    if await page_looks_like_not_found(page):
        return False
    if url_looks_like_broken_nav(page.url or ""):
        return False
    url = (page.url or "").lower()
    if "/channels" in url or "/integrations" in url:
        from panel_screenshot import page_has_usable_content

        return await page_has_usable_content(page, min_len=80)
    return False


async def _try_open_channel_from_hub(page: Page, module_name: str = "", description: str = "") -> bool:
    """After Quick Search lands on Integrations/Channels hub, open the specific channel card."""
    canonical = resolve_doc_module(module_name, description).lower()
    labels: list[str] = []
    if "amazon" in canonical:
        labels = ["Amazon", "amazon"]
    elif "shopify" in canonical:
        labels = ["Shopify", "shopify"]
    else:
        return False

    await dismiss_blocking_overlays(page)
    for label in labels:
        for factory in (
            lambda l=label: page.locator(f'[class*="card" i]:has-text("{l}")'),
            lambda l=label: page.locator(f'[class*="channel" i]:has-text("{l}")'),
            lambda l=label: page.get_by_role("link", name=re.compile(re.escape(l), re.I)),
            lambda l=label: page.get_by_role("button", name=re.compile(re.escape(l), re.I)),
            lambda l=label: page.locator(f'a[href*="{l.lower()}"]'),
            lambda l=label: page.locator(f'a:has-text("{l}")'),
            lambda l=label: page.get_by_text(re.compile(rf"^{re.escape(l)}$", re.I)),
        ):
            try:
                loc = factory()
                count = min(await loc.count(), 8)
                for i in range(count):
                    item = loc.nth(i)
                    if not await item.is_visible():
                        continue
                    text = (await item.inner_text() or "").strip().lower()
                    if "quick search" in text:
                        continue
                    await item.click(timeout=5000)
                    await asyncio.sleep(0.35)
                    if not await page_looks_like_not_found(page):
                        return True
            except Exception:
                continue
    return False


async def navigate_channel_to_target(
    page: Page, module_name: str = "", description: str = ""
) -> dict:
    """Quick Search to Order Channels hub, then in-page click for Amazon/Shopify."""
    hub_verify = channel_hub_verify_fn(module_name, description)
    logs: list[str] = []

    qs = await navigate_module_via_quick_search(
        page, module_name, description, verify_fn=hub_verify
    )
    logs.extend(qs.get("logs") or [])

    if is_specific_channel_target(module_name, description):
        if await on_channel_hub_page(page) and not await on_channel_page(
            page, module_name, description
        ):
            opened = await _try_open_channel_from_hub(page, module_name, description)
            logs.append(f"Hub click → channel: {opened}")
            await asyncio.sleep(0.25)
    elif not qs.get("ok") and await on_channel_hub_page(page):
        logs.append("On channel hub after Quick Search (verify miss)")

    if await on_channel_page(page, module_name, description):
        return {
            "ok": True,
            "strategy": "quick_search_hub_click",
            "pageUrl": page.url,
            "logs": logs,
        }
    if await channel_page_usable(page, module_name, description):
        return {
            "ok": True,
            "strategy": "quick_search_hub",
            "pageUrl": page.url,
            "logs": logs,
        }
    return {"ok": False, "pageUrl": page.url, "strategy": "quick_search", "logs": logs}


async def heal_channel_nav(page: Page, module_name: str = "", description: str = "") -> dict:
    """Self-heal: Ctrl+B → Order Channels hub → in-page channel card click."""
    await dismiss_blocking_overlays(page)
    canonical = resolve_doc_module(module_name, description).lower()

    staged = await navigate_channel_to_target(page, module_name, description)
    if staged.get("ok"):
        return staged

    if not docs_capture_allow_direct_urls():
        return {
            "ok": False,
            "pageUrl": page.url,
            "strategy": "quick_search_only",
            "logs": staged.get("logs", []),
        }

    origin = (await panel_origin(page)).rstrip("/")
    urls: list[str] = []
    if "shopify" in canonical:
        urls = [
            f"{origin}/channels/shopify",
            f"{origin}/channels",
            f"{origin}/integrations",
        ]
    elif "amazon" in canonical:
        urls = [
            f"{origin}/channels/amazon",
            f"{origin}/channels",
            f"{origin}/integrations",
        ]
    elif "integration" in canonical:
        urls = [
            f"{origin}/integrations",
            f"{origin}/channels",
            f"{origin}/channels/shopify",
        ]
    else:
        urls = [f"{origin}/channels", f"{origin}/integrations"]

    for url in urls:
        if url_looks_like_broken_nav(url):
            continue
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=45000)
            await asyncio.sleep(2)
            if await page_looks_like_not_found(page):
                continue
            if await on_channel_hub_page(page) and is_specific_channel_target(
                module_name, description
            ):
                await _try_open_channel_from_hub(page, module_name, description)
            if await on_channel_page(page, module_name, description):
                return {"ok": True, "strategy": "direct_url", "pageUrl": page.url, "url": url}
        except Exception:
            continue

    return {"ok": False, "pageUrl": page.url, "strategy": "exhausted"}


def channel_hub_verify_fn(module_name: str, description: str = ""):
    """Verify Quick Search landed on Order Channels / Integrations hub."""
    if not is_channel_target(module_name, description):
        return None

    async def _verify(page: Page) -> bool:
        return await on_channel_hub_page(page)

    return _verify


def channel_verify_fn(module_name: str, description: str = ""):
    if not is_channel_target(module_name, description):
        return None

    async def _verify(page: Page) -> bool:
        return await on_channel_page(page, module_name, description)

    return _verify


def channel_capture_verify_fn(module_name: str, description: str = ""):
    """Looser than on_channel_page — accepts integrations list / channel hub after Quick Search."""
    if not is_channel_target(module_name, description):
        return None

    async def _verify(page: Page) -> bool:
        return await channel_page_usable(page, module_name, description)

    return _verify
