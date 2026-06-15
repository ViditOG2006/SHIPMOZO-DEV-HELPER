"""Dismiss blocking UI before panel navigation and screenshots."""

from __future__ import annotations

import asyncio
import re

from playwright.async_api import Page


async def dismiss_blocking_overlays(page: Page) -> None:
    """Close alert banners, cookie bars, and modal backdrops that block sidebar clicks."""
    try:
        await page.keyboard.press("Escape")
        await asyncio.sleep(0.15)
    except Exception:
        pass

    close_patterns = (
        re.compile(r"close|dismiss|got it|ok", re.I),
        re.compile(r"×|✕", re.I),
    )
    for role in ("button", "link"):
        try:
            for pat in close_patterns:
                loc = page.get_by_role(role, name=pat)
                count = min(await loc.count(), 4)
                for i in range(count):
                    try:
                        btn = loc.nth(i)
                        if await btn.is_visible():
                            await btn.click(timeout=1200)
                            await asyncio.sleep(0.1)
                    except Exception:
                        continue
        except Exception:
            continue

    for sel in (
        '[aria-label*="close" i]',
        '[aria-label*="dismiss" i]',
        'button[class*="close" i]',
        '[class*="alert" i] button',
        '[class*="banner" i] button',
        '[class*="toast" i] button',
    ):
        try:
            loc = page.locator(sel)
            count = min(await loc.count(), 3)
            for i in range(count):
                try:
                    btn = loc.nth(i)
                    if await btn.is_visible():
                        await btn.click(timeout=1200)
                        await asyncio.sleep(0.1)
                except Exception:
                    continue
        except Exception:
            continue
