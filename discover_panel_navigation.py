#!/usr/bin/env python
"""
Crawl the live Shipmozo panel and build data/panel-navigation.json.

Merges crawl results with the default seed so orders/channels/billing routes stay available.

Usage:
  python discover_panel_navigation.py
  npm run discover-nav
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

from playwright.async_api import Page

from panel_navigation import (
    NAV_MAP_PATH,
    default_navigation_map,
    is_junk_nav_href,
    is_junk_nav_label,
    looks_like_dynamic_id,
    merge_navigation_maps,
    merge_page_lists,
    normalize_page_entry,
    save_navigation_map,
)
from shipmozo_login import LOGIN_URLS, async_login_and_save_state

PANEL_BASE = LOGIN_URLS[0].rstrip("/")
MAX_CRAWL_PAGES = 80
MAX_DEPTH = 3

START_URLS = [
    PANEL_BASE,
    f"{PANEL_BASE}/dashboard",
    f"{PANEL_BASE}/orders/new",
    f"{PANEL_BASE}/billing",
    f"{PANEL_BASE}/channels",
    f"{PANEL_BASE}/settings",
    f"{PANEL_BASE}/ndr",
]


async def expand_sidebar_sections(page: Page) -> None:
    """Click collapsed sidebar groups so nested links appear."""
    selectors = [
        "aside [aria-expanded='false']",
        "nav [aria-expanded='false']",
        '[class*="sidebar" i] [aria-expanded="false"]',
        '[class*="Sidebar" i] button',
        "aside .MuiListItemButton-root",
        "nav .MuiListItemButton-root",
        '[class*="menu" i] .MuiListItemButton-root',
    ]
    for sel in selectors:
        try:
            loc = page.locator(sel)
            count = await loc.count()
            for i in range(min(count, 25)):
                item = loc.nth(i)
                try:
                    if await item.is_visible():
                        await item.click(timeout=1500)
                        await asyncio.sleep(0.25)
                except Exception:
                    continue
        except Exception:
            continue


async def extract_links_from_page(page: Page) -> list[dict[str, str]]:
    pages: list[dict[str, str]] = []
    seen: set[str] = set()
    skip = ("logout", "sign out", "log out", "javascript:", "mailto:", "tel:")

    selectors = [
        "nav a[href]",
        "aside a[href]",
        '[class*="sidebar" i] a[href]',
        '[class*="Sidebar" i] a[href]',
        '[class*="menu" i] a[href]',
        '[role="navigation"] a[href]',
        '[class*="nav" i] a[href]',
        "header a[href]",
        'a[href^="/"]',
    ]

    for sel in selectors:
        try:
            loc = page.locator(sel)
            count = await loc.count()
            for i in range(min(count, 120)):
                link = loc.nth(i)
                href = await link.get_attribute("href")
                if not href or href.startswith("#"):
                    continue
                text = re.sub(r"\s+", " ", (await link.inner_text() or "").strip())
                if is_junk_nav_label(text) or looks_like_dynamic_id(text):
                    continue
                lower = f"{text} {href}".lower()
                if any(s in lower for s in skip):
                    continue

                absolute = urljoin(page.url, href)
                parsed = urlparse(absolute)
                if parsed.scheme not in ("http", "https"):
                    continue
                if (
                    PANEL_BASE not in absolute
                    and "shipmozo" not in absolute
                    and "appiify" not in absolute
                ):
                    continue
                if "/login" in absolute.lower() or is_junk_nav_href(absolute):
                    continue

                if absolute in seen:
                    continue
                seen.add(absolute)
                entry = normalize_page_entry(text, absolute)
                if entry:
                    pages.append(entry)
        except Exception:
            continue

    return pages


async def crawl_panel() -> dict:
    p = browser = context = page = None
    all_pages: list[dict] = []
    seed_hrefs = [p["href"] for p in default_navigation_map()["pages"]]
    queue: list[tuple[str, int]] = []
    seen_queue: set[str] = set()
    for url in START_URLS + seed_hrefs:
        if url not in seen_queue:
            seen_queue.add(url)
            queue.append((url, 0))
    visited: set[str] = set()

    try:
        p, browser, context, page = await async_login_and_save_state()
        await asyncio.sleep(2)

        while queue and len(visited) < MAX_CRAWL_PAGES:
            url, depth = queue.pop(0)
            if url in visited:
                continue
            visited.add(url)

            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=45000)
                await asyncio.sleep(1.2)
                await expand_sidebar_sections(page)
                await asyncio.sleep(0.8)
            except Exception:
                continue

            found = await extract_links_from_page(page)
            all_pages = merge_page_lists(all_pages, found)

            if depth < MAX_DEPTH:
                for entry in found:
                    href = entry["href"]
                    if href not in visited and href not in seen_queue:
                        seen_queue.add(href)
                        queue.append((href, depth + 1))

        crawled = {
            "version": 1,
            "discoveredAt": datetime.now(timezone.utc).isoformat(),
            "baseUrl": PANEL_BASE,
            "source": "live_crawl",
            "crawledUrls": len(visited),
            "pageCount": len(all_pages),
            "pages": all_pages,
        }
        return merge_navigation_maps(crawled, keep_source="merged")
    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if p:
            await p.stop()


async def main() -> None:
    print("Discovering Shipmozo panel navigation (login + crawl + merge seed)...", flush=True)
    data = await crawl_panel()
    save_navigation_map(data)
    print(f"Saved {data['pageCount']} pages to {NAV_MAP_PATH}", flush=True)
    print(
        json.dumps(
            {
                "ok": True,
                "pageCount": data["pageCount"],
                "crawledUrls": data.get("crawledUrls"),
                "discoveredAt": data.get("discoveredAt"),
                "source": data.get("source"),
            }
        )
    )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        sys.exit(1)
