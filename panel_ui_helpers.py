"""Dismiss blocking UI before panel navigation and screenshots."""

from __future__ import annotations

import asyncio
import re

from playwright.async_api import Page


_UNSAVED_DIALOG_PATTERNS = (
    re.compile(r"unsaved changes", re.I),
    re.compile(r"are you sure", re.I),
    re.compile(r"will be lost", re.I),
)

_STAY_ON_PAGE_BUTTON_PATTERNS = (
    re.compile(r"^dismiss$", re.I),
    re.compile(r"stay", re.I),
    re.compile(r"keep editing", re.I),
    re.compile(r"continue editing", re.I),
    re.compile(r"^no$", re.I),
    re.compile(r"^cancel$", re.I),
)


async def page_has_blocking_dialog(page: Page) -> bool:
    """True when a modal/dialog is visibly blocking the page."""
    try:
        dialogs = page.locator('[role="dialog"], [class*="modal" i][class*="show" i], [class*="Modal" i]')
        count = min(await dialogs.count(), 6)
        for i in range(count):
            dlg = dialogs.nth(i)
            if not await dlg.is_visible():
                continue
            text = (await dlg.inner_text(timeout=1200)) or ""
            compact = re.sub(r"\s+", " ", text).strip().lower()
            if len(compact) < 8:
                continue
            if any(p.search(compact) for p in _UNSAVED_DIALOG_PATTERNS):
                return True
            if "?" in compact and any(w in compact for w in ("sure", "lost", "leave", "discard")):
                return True
    except Exception:
        pass
    return False


async def dismiss_unsaved_changes_dialog(page: Page) -> bool:
    """Close 'unsaved changes will be lost' prompts — stay on the current form."""
    if not await page_has_blocking_dialog(page):
        return False

    for pat in _STAY_ON_PAGE_BUTTON_PATTERNS:
        try:
            btn = page.get_by_role("button", name=pat)
            count = min(await btn.count(), 4)
            for i in range(count):
                candidate = btn.nth(i)
                if await candidate.is_visible():
                    await candidate.click(timeout=2000)
                    await asyncio.sleep(0.25)
                    if not await page_has_blocking_dialog(page):
                        return True
        except Exception:
            continue

    try:
        dlg = page.locator('[role="dialog"]').first
        if await dlg.count() > 0 and await dlg.is_visible():
            inner_btn = dlg.get_by_role("button", name=re.compile(r"dismiss|stay|no|keep", re.I))
            if await inner_btn.count() > 0:
                await inner_btn.first.click(timeout=2000)
                await asyncio.sleep(0.25)
                return not await page_has_blocking_dialog(page)
    except Exception:
        pass

    try:
        await page.keyboard.press("Escape")
        await asyncio.sleep(0.2)
    except Exception:
        pass
    return not await page_has_blocking_dialog(page)


async def dismiss_blocking_overlays(page: Page) -> None:
    """Close alert banners, cookie bars, and modal backdrops that block sidebar clicks."""
    await dismiss_unsaved_changes_dialog(page)

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
