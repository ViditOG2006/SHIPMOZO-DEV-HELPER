"""Shared page state helpers (no circular imports)."""

from __future__ import annotations

from playwright.async_api import Page

NOT_FOUND_MARKERS = (
    "page can not be found",
    "page cannot be found",
    "page not found",
    "this page doesn't exist",
    "this page does not exist",
    "could not be found",
    "looking for could not be found",
    "404 -",
    "404 error",
    "oops",
    "opps",
    "go back home",
    "something went wrong",
)

BROKEN_URL_FRAGMENTS = (
    "/courier/manage-courier",
)


async def page_looks_like_not_found(page: Page) -> bool:
    try:
        title = (await page.title() or "").lower()
        snippet = await page.evaluate(
            """() => (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 2500).toLowerCase()"""
        )
        hay = f"{title} {snippet}"
        return any(m in hay for m in NOT_FOUND_MARKERS)
    except Exception:
        return False


def text_indicates_not_found(text: str, title: str = "") -> bool:
    hay = f"{title} {text}".lower()
    return any(m in hay for m in NOT_FOUND_MARKERS)


def url_looks_like_broken_nav(url: str) -> bool:
    """Routes that often 404 or trap navigation away from the target module."""
    low = (url or "").lower()
    if "manage-courier" in low and "rate-calculator" not in low:
        return True
    return any(frag in low for frag in BROKEN_URL_FRAGMENTS)


async def page_is_broken_for_e2e(page: Page) -> tuple[bool, str]:
    """True when the page is a 404 or a known bad route (e.g. manage-courier trap)."""
    try:
        url = page.url or ""
        if url_looks_like_broken_nav(url):
            return True, f"Broken route: {url}"
        if await page_looks_like_not_found(page):
            return True, f"404 / not found at {url}"
    except Exception as exc:
        return True, str(exc)
    return False, ""
