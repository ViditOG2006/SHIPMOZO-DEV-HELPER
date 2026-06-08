"""Shared page state helpers (no circular imports)."""

from __future__ import annotations

from playwright.async_api import Page

NOT_FOUND_MARKERS = (
    "page can not be found",
    "page cannot be found",
    "page not found",
    "this page doesn't exist",
    "this page does not exist",
    "404 -",
    "404 error",
    "oops",
    "something went wrong",
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
