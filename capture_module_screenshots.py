from __future__ import annotations

import asyncio
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

from playwright.async_api import Page

from panel_navigation import is_junk_nav_label, load_navigation_map, merge_page_lists
from panel_navigate import navigate_for_chat, page_looks_like_not_found
from panel_screenshot import (
    has_module_anchor,
    page_has_usable_content,
    poor_screenshot_label,
    wait_for_loaders_gone,
)
from shipmozo_login import HEADLESS, LOGIN_URLS
from shipmozo_login import async_login_and_save_state
from shipmozo_login import first_visible

PANEL_BASE = LOGIN_URLS[0].rstrip("/")
NAV_CATALOG = [
    {
        "text": p["text"],
        "href": p["href"],
        "path": p.get("path", ""),
        "keywords": p.get("keywords", []),
    }
    for p in load_navigation_map().get("pages", [])
]

MODULE_NAV_HINTS: dict[str, list[str]] = {
    "dashboard": [
        "text=Dashboard",
        'a:has-text("Dashboard")',
        '[href*="dashboard"]',
        '[href*="/home"]',
        'nav a:has-text("Dashboard")',
    ],
    "new orders": ["text=New Orders", "text=New", 'a:has-text("New Orders")', 'a:has-text("New")'],
    "all orders": ["text=All Orders", 'a:has-text("All Orders")'],
    "scheduled orders": ["text=Scheduled", 'a:has-text("Scheduled")'],
    "courier assigned": ["text=Courier Assigned", 'a:has-text("Courier")'],
    "reverse": ["text=Reverse", 'a:has-text("Reverse")'],
    "integrations": [
        "text=Integrations",
        'a:has-text("Integrations")',
        '[href*="/integrations"]',
    ],
    "integration": [
        "text=Integrations",
        'a:has-text("Integrations")',
        '[href*="/integrations"]',
    ],
    "shopify": [
        "text=Shopify",
        'a:has-text("Shopify")',
        '[href*="shopify"]',
        '[href*="/channels"]',
    ],
    "channels": [
        "text=Channels",
        'a:has-text("Channels")',
        '[href*="/channels"]',
    ],
}

DIRECT_URL_HINTS: dict[str, list[str]] = {
    "dashboard": [
        f"{PANEL_BASE}/dashboard",
        f"{PANEL_BASE}/home",
        f"{PANEL_BASE}/",
    ],
    "integrations": [
        f"{PANEL_BASE}/integrations",
        f"{PANEL_BASE}/channels",
    ],
    "integration": [
        f"{PANEL_BASE}/integrations",
        f"{PANEL_BASE}/channels",
    ],
    "shopify": [
        f"{PANEL_BASE}/channels/shopify",
        f"{PANEL_BASE}/channels",
        f"{PANEL_BASE}/integrations",
    ],
    "channels": [
        f"{PANEL_BASE}/channels",
        f"{PANEL_BASE}/integrations",
    ],
    "billing": [
        f"{PANEL_BASE}/billing/all-recharges",
        f"{PANEL_BASE}/billing",
    ],
}

FALLBACK_PANEL_PAGES: list[dict[str, str]] = NAV_CATALOG


def slugify(value: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return s or "module"


def is_dashboard_module(module_name: str) -> bool:
    return "dashboard" in module_name.lower()


MODULE_ALIASES_TEST = {
    "/orders/add": "Quick Add",
    "/orders/new": "New Orders",
    "/orders/all": "All Orders",
    "/integrations": "Integrations",
    "/channels/shopify": "Shopify",
    "/billing": "Billing",
    "orders/add": "Quick Add",
    "orders/new": "New Orders",
}


def normalize_module_for_test(module_name: str, description: str = "") -> str:
    raw = (module_name or "").strip()
    if not raw and description:
        low = description.lower()
        if "shopify" in low:
            return "Shopify"
        if "integration" in low:
            return "Integrations"
        if "billing" in low:
            return "Billing"
        if "order" in low:
            return "Quick Add"
    if not raw:
        return "New Orders"
    key = raw.lower()
    if key in MODULE_ALIASES_TEST:
        return MODULE_ALIASES_TEST[key]
    if raw in MODULE_ALIASES_TEST:
        return MODULE_ALIASES_TEST[raw]
    if raw.startswith("/"):
        slug = raw.strip("/").split("/")[-1]
        return slug.replace("-", " ").title() or "New Orders"
    return raw


def infer_chat_query_for_test(module_name: str, chat_query: str, description: str = "") -> str:
    if chat_query and chat_query.strip():
        return chat_query.strip()
    hay = f"{module_name} {description}".lower()
    if "order" in hay and any(x in hay for x in ("create", "new", "add")):
        return "How do I create a new order in Shipmozo?"
    if "billing" in hay:
        return "How does billing work in Shipmozo?"
    if "shopify" in hay or "integration" in hay:
        return "How do I set up Shopify integration?"
    return f"How do I use {normalize_module_for_test(module_name, description)}?"


def score_nav_page(module_name: str, description: str, nav_page: dict) -> int:
    key = f"{module_name} {description}".lower()
    parts = [p for p in re.split(r"[^a-z0-9]+", key) if len(p) >= 3]
    hay = " ".join(
        [
            nav_page.get("text", ""),
            nav_page.get("href", ""),
            nav_page.get("path", ""),
            " ".join(nav_page.get("keywords", [])),
        ]
    ).lower()
    score = 0
    for part in parts:
        if part in hay:
            score += 2
        path = nav_page.get("path", "").lower()
        if path and part in path.replace("/", " "):
            score += 3
    name_key = module_name.lower().strip()
    if name_key and name_key in hay:
        score += 4
    return score


def rank_nav_pages(module_name: str, description: str, discovered: list[dict]) -> list[dict]:
    scored: list[tuple[int, dict]] = []
    for nav_page in merge_page_lists(discovered, NAV_CATALOG):
        if is_junk_nav_label(nav_page.get("text", "")):
            continue
        score = score_nav_page(module_name, description, nav_page)
        if score > 0:
            scored.append((score, nav_page))
    scored.sort(key=lambda x: (-x[0], x[1].get("text", "")))
    seen: set[str] = set()
    ranked: list[dict] = []
    for _, nav_page in scored:
        href = nav_page.get("href", "")
        if href in seen:
            continue
        seen.add(href)
        ranked.append(nav_page)
    return ranked


def is_login_dashboard_shot(shot: dict) -> bool:
    label = (shot.get("label") or "").lower()
    shot_id = shot.get("id", "")
    return shot_id == "dashboard_after_login" or "after login" in label


async def try_direct_urls(page: Page, module_name: str, description: str = "") -> bool:
    key = f"{module_name} {description}".lower()
    urls: list[str] = []
    for hint_key, hint_urls in DIRECT_URL_HINTS.items():
        if hint_key in key or key in hint_key:
            urls.extend(hint_urls)
    for nav_page in NAV_CATALOG:
        if score_nav_page(module_name, description, nav_page) >= 4:
            urls.append(nav_page["href"])

    seen: set[str] = set()
    for url in urls:
        if url in seen:
            continue
        seen.add(url)
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=45000)
            await asyncio.sleep(2)
            if await page_looks_like_not_found(page):
                continue
            if await page_has_usable_content(page) or await has_module_anchor(page):
                return True
        except Exception:
            continue
    return False


async def save_shot(
    page: Page,
    out_dir: Path,
    shot_id: str,
    label: str,
    step: int,
    *,
    full_page: bool = False,
    content_ready: bool = False,
) -> dict | None:
    if poor_screenshot_label(label):
        return None
    if not content_ready and not await has_module_anchor(page):
        if not await page_has_usable_content(page):
            return None
    await wait_for_loaders_gone(page, timeout_s=4)

    filename = f"{step:02d}_{shot_id}.png"
    target = out_dir / filename
    await page.screenshot(path=str(target), full_page=full_page)
    return {
        "id": shot_id,
        "label": label,
        "step": step,
        "filename": filename,
        "path": str(target),
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "url": page.url,
    }


def build_nav_selectors(module_name: str) -> list[str]:
    key = module_name.lower().strip()
    selectors: list[str] = []

    for hint_key, hints in MODULE_NAV_HINTS.items():
        if hint_key in key or key in hint_key:
            selectors.extend(hints)

    selectors.extend(
        [
            f"text={module_name}",
            f'a:has-text("{module_name}")',
            f'nav a:has-text("{module_name}")',
            f'aside a:has-text("{module_name}")',
            f'[aria-label*="{module_name}"]',
            f'[title*="{module_name}"]',
        ]
    )

    seen: set[str] = set()
    unique: list[str] = []
    for sel in selectors:
        if sel not in seen:
            seen.add(sel)
            unique.append(sel)
    return unique


async def try_click_selector(page: Page, selector: str) -> bool:
    try:
        loc = page.locator(selector).first
        if await loc.count() == 0:
            return False
        await loc.scroll_into_view_if_needed(timeout=3000)
        await loc.click(timeout=8000)
        await page.wait_for_load_state("domcontentloaded")
        await asyncio.sleep(2)
        return True
    except Exception:
        return False


async def try_role_link(page: Page, module_name: str) -> bool:
    try:
        link = page.get_by_role("link", name=re.compile(re.escape(module_name), re.I)).first
        if await link.count() == 0:
            return False
        await link.scroll_into_view_if_needed(timeout=3000)
        await link.click(timeout=8000)
        await page.wait_for_load_state("domcontentloaded")
        await asyncio.sleep(2)
        return True
    except Exception:
        return False


async def open_module_self_heal(
    page: Page, module_name: str, description: str = "", attempts: int = 3
) -> bool:
    for _ in range(attempts):
        if await try_direct_urls(page, module_name, description):
            return True
        if await try_role_link(page, module_name):
            return True
        for sel in build_nav_selectors(module_name):
            if await try_click_selector(page, sel):
                return True
        await asyncio.sleep(1)
    return False


async def discover_sidebar_pages(page: Page, max_pages: int = 12) -> list[dict[str, str]]:
    pages: list[dict[str, str]] = []
    seen: set[str] = set()
    skip_words = ("logout", "sign out", "log out", "help", "support", "javascript:")

    containers = [
        "nav a[href]",
        "aside a[href]",
        '[class*="sidebar" i] a[href]',
        '[class*="Sidebar" i] a[href]',
        '[class*="menu" i] a[href]',
        '[role="navigation"] a[href]',
        'a[href^="/"]',
        "a[href]",
    ]

    for container in containers:
        try:
            links = page.locator(container)
            count = await links.count()
            for i in range(count):
                link = links.nth(i)
                href = await link.get_attribute("href")
                if not href:
                    continue
                text = (await link.inner_text() or "").strip()
                text = re.sub(r"\s+", " ", text)
                if not text or len(text) > 60:
                    continue
                lower = f"{text} {href}".lower()
                if any(word in lower for word in skip_words):
                    continue
                if href.startswith("#"):
                    continue

                absolute = urljoin(page.url, href)
                parsed = urlparse(absolute)
                if parsed.netloc and PANEL_BASE not in absolute and "shipmozo" not in absolute:
                    continue

                key = f"{text}|{absolute}"
                if key in seen:
                    continue
                seen.add(key)
                pages.append({"text": text, "href": absolute})
        except Exception:
            continue

    return pages[:max_pages]


async def capture_scroll_sections(
    page: Page, out_dir: Path, prefix: str, step: int, label_prefix: str
) -> tuple[list[dict], int]:
    """One stable module screenshot (sidebar + main content), no filter/scroll extras."""
    shots: list[dict] = []
    shot = await save_shot(
        page,
        out_dir,
        f"{prefix}_module",
        f"Module view: {label_prefix}",
        step + 1,
    )
    if shot:
        shots.append(shot)
        step += 1
    return shots, step


async def capture_dashboard_all_pages(page: Page, out_dir: Path, step: int) -> tuple[list[dict], int]:
    shots: list[dict] = []
    opened = await open_module_self_heal(page, "Dashboard")
    await asyncio.sleep(2)

    section_shots, step = await capture_scroll_sections(
        page,
        out_dir,
        "dashboard_main",
        step,
        "Dashboard main" + (" (nav opened)" if opened else ""),
    )
    shots.extend(section_shots)

    sidebar_pages = await discover_sidebar_pages(page, max_pages=12)
    if len(sidebar_pages) < 4:
        seen_hrefs = {p["href"] for p in sidebar_pages}
        for fallback in FALLBACK_PANEL_PAGES:
            if fallback["href"] not in seen_hrefs:
                sidebar_pages.append(fallback)
                seen_hrefs.add(fallback["href"])

    for nav_page in sidebar_pages[:4]:
        try:
            reached, ready = await navigate_for_chat(page, nav_page)
            if not reached or await page_looks_like_not_found(page):
                continue
            shot = await save_shot(
                page,
                out_dir,
                f"page_{slugify(nav_page['text'])}",
                f"Module view: {nav_page['text']}",
                step + 1,
                content_ready=ready,
            )
            if shot:
                shots.append(shot)
                step += 1
        except Exception:
            continue

    return shots, step


async def capture_module(
    session_id: str, module_name: str, out_dir: Path, description: str = ""
) -> list[dict]:
    out_dir.mkdir(parents=True, exist_ok=True)
    shots: list[dict] = []
    p = browser = context = page = None
    step = 0

    try:
        p, browser, context, page = await async_login_and_save_state()

        if is_dashboard_module(module_name):
            step += 1
            login_shot = await save_shot(
                page, out_dir, "dashboard_after_login", "Navigation: sidebar after login", step
            )
            if login_shot:
                shots.append(login_shot)
            extra, step = await capture_dashboard_all_pages(page, out_dir, step)
            shots.extend(extra)
            return shots

        # Direct URL first (integrations, shopify from notes, etc.)
        if await try_direct_urls(page, module_name, description):
            shot = await save_shot(
                page,
                out_dir,
                f"module_{slugify(module_name)}_direct",
                f"Module view: {module_name}",
                step + 1,
                content_ready=True,
            )
            if shot:
                shots.append(shot)
                step += 1

        discovered = await discover_sidebar_pages(page, max_pages=30)
        ranked = rank_nav_pages(module_name, description, discovered)

        for nav_page in ranked[:3]:
            if len([s for s in shots if not is_login_dashboard_shot(s)]) >= 2:
                break
            try:
                reached, ready = await navigate_for_chat(page, nav_page)
                if not reached or await page_looks_like_not_found(page):
                    continue
                shot = await save_shot(
                    page,
                    out_dir,
                    f"module_{slugify(nav_page['text'])}",
                    f"Module view: {nav_page['text']}",
                    step + 1,
                    content_ready=ready,
                )
                if shot:
                    shots.append(shot)
                    step += 1
            except Exception:
                continue

        module_shots = [s for s in shots if not is_login_dashboard_shot(s)]
        if not module_shots:
            opened = await open_module_self_heal(page, module_name, description)
            await asyncio.sleep(2)
            shot = await save_shot(
                page,
                out_dir,
                "module_main_view",
                f"Module view: {module_name}" + (" (nav opened)" if opened else ""),
                step + 1,
                content_ready=opened,
            )
            if shot:
                shots.append(shot)
                step += 1
                module_shots = [shot]

        if not module_shots:
            section_shots, step = await capture_scroll_sections(
                page, out_dir, slugify(module_name), step, module_name
            )
            shots.extend(section_shots)
            module_shots = section_shots

        # Login/dashboard shot only as last resort
        if not module_shots:
            step += 1
            login_shot = await save_shot(
                page, out_dir, "dashboard_after_login", "Navigation: sidebar after login", step
            )
            if login_shot:
                shots.append(login_shot)
            return shots

        return [s for s in shots if not is_login_dashboard_shot(s)] or shots
    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if p:
            await p.stop()


async def main() -> None:
    if len(sys.argv) < 3:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "Usage: capture_module_screenshots.py <session_id> <module_name>",
                }
            )
        )
        sys.exit(2)

    session_id = sys.argv[1]
    module_name = sys.argv[2]
    description = sys.argv[3] if len(sys.argv) > 3 else ""
    out_dir = Path("output") / "cloud-images" / session_id / "raw"

    try:
        shots = await capture_module(session_id, module_name, out_dir, description)
        print(
            json.dumps(
                {
                    "ok": True,
                    "session_id": session_id,
                    "module_name": module_name,
                    "headless": HEADLESS,
                    "screenshots": shots,
                }
            )
        )
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e), "screenshots": []}))
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
