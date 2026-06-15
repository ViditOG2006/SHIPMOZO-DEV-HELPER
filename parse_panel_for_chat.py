from __future__ import annotations

import asyncio
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

from playwright.async_api import Page

from panel_navigation import load_navigation_map, merge_page_lists
from panel_navigate import (
    navigate_for_chat,
    page_looks_like_not_found,
    text_indicates_not_found,
)
from panel_quick_search import navigate_via_quick_search
from panel_ui_helpers import dismiss_blocking_overlays
from panel_screenshot import (
    has_module_anchor,
    page_has_usable_content,
    poor_screenshot_label,
    wait_for_loaders_gone,
)
from shipmozo_login import HEADLESS, LOGIN_URLS
from shipmozo_login import async_login_and_save_state

PANEL_BASE = LOGIN_URLS[0].rstrip("/")
MAX_PAGES_TO_VISIT = int(os.getenv("PANEL_CHAT_MAX_PAGES", "2"))
NAV_MAP = load_navigation_map()
CATALOG_PAGES = [
    {
        "text": p["text"],
        "href": p["href"],
        "keywords": p.get("keywords", []),
    }
    for p in NAV_MAP.get("pages", [])
]

STOP_WORDS = {
    "the", "and", "for", "how", "what", "where", "when", "why", "can", "you",
    "show", "tell", "help", "with", "about", "using", "use", "from", "this",
    "that", "are", "was", "were", "have", "has", "had", "does", "did", "will",
    "would", "could", "should", "may", "might", "must", "need", "want", "like",
    "please", "method", "steps", "screenshot", "screenshots",
}

# Targeted pages per topic (deduped by path; avoids 3× same Shopify visit)
TOPIC_PAGE_HINTS: list[tuple[list[str], list[dict[str, str]]]] = [
    (
        ["shopify", "woocommerce", "channel", "store connect", "integration"],
        [
            {"text": "Channels", "href": f"{PANEL_BASE}/channels"},
            {"text": "Shopify", "href": f"{PANEL_BASE}/channels/shopify"},
        ],
    ),
    (
        ["billing", "invoice", "wallet", "recharge", "remittance", "cod"],
        [
            {"text": "Billing", "href": f"{PANEL_BASE}/billing"},
            {"text": "Wallet", "href": f"{PANEL_BASE}/wallet"},
        ],
    ),
    (
        ["quick order", "quick add", "create order", "add order", "new order", "place order"],
        [
            {"text": "Quick Add", "href": f"{PANEL_BASE}/orders/quick-add"},
            {"text": "Add Order", "href": f"{PANEL_BASE}/orders/add"},
        ],
    ),
    (
        ["ndr", "non delivery"],
        [{"text": "NDR", "href": f"{PANEL_BASE}/ndr"}],
    ),
    (
        ["settings", "profile", "account", "api key"],
        [
            {"text": "Settings", "href": f"{PANEL_BASE}/settings"},
            {"text": "Profile", "href": f"{PANEL_BASE}/profile"},
        ],
    ),
    (
        ["rate calculator", "rate calc", "shipping rate", "freight", "courier rate"],
        [{"text": "Rate Calculator", "href": f"{PANEL_BASE}/courier/rate-calculator"}],
    ),
]


def slugify(value: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return s or "page"


def tokenize_query(query: str) -> list[str]:
    tokens = re.findall(r"[a-z0-9]+", query.lower())
    return [t for t in tokens if len(t) > 2 and t not in STOP_WORDS]


def score_nav_page(page: dict[str, str], tokens: list[str]) -> int:
    hay = f"{page.get('text', '')} {page.get('href', '')} {' '.join(page.get('keywords', []))}".lower()
    score = 0
    for token in tokens:
        if token in hay:
            score += 4 if len(token) > 4 else 3
    return score


def dedupe_pages_by_path(pages: list[dict[str, str]]) -> list[dict[str, str]]:
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for page in pages:
        key = urlparse(page.get("href", "")).path.rstrip("/") or "/"
        if key in seen:
            continue
        seen.add(key)
        out.append(page)
    return out


def pick_pages_to_visit(query: str, discovered: list[dict[str, str]]) -> list[dict[str, str]]:
    tokens = tokenize_query(query)
    q = query.lower()

    hint_pages: list[dict[str, str]] = []
    for keywords, pages in TOPIC_PAGE_HINTS:
        if any(k in q for k in keywords):
            hint_pages.extend(pages)

    combined = dedupe_pages_by_path(merge_page_lists(CATALOG_PAGES, discovered, hint_pages))

    scored: list[tuple[int, dict[str, str]]] = []
    for page in combined:
        s = score_nav_page(page, tokens)
        if s > 0:
            scored.append((s, page))

    scored.sort(key=lambda x: (-x[0], x[1]["text"]))
    if scored:
        return dedupe_pages_by_path([p for _, p in scored[:MAX_PAGES_TO_VISIT]])

    # No keyword match: visit a diverse set (avoid only New Orders)
    diverse: list[dict[str, str]] = []
    priority_hints = ["channel", "integration", "shopify", "billing", "ndr", "settings", "dashboard", "warehouse"]
    for hint in priority_hints:
        for page in combined:
            href = page["href"].lower()
            if hint in href or hint in page["text"].lower():
                diverse.append(page)
                break

    if len(diverse) < MAX_PAGES_TO_VISIT:
        for page in combined:
            if page not in diverse:
                diverse.append(page)
            if len(diverse) >= MAX_PAGES_TO_VISIT:
                break

    return dedupe_pages_by_path(diverse[:MAX_PAGES_TO_VISIT])


async def discover_sidebar_pages(page: Page, max_pages: int = 30) -> list[dict[str, str]]:
    pages: list[dict[str, str]] = []
    seen: set[str] = set()
    skip_words = ("logout", "sign out", "log out", "javascript:")

    containers = [
        "nav a[href]",
        "aside a[href]",
        '[class*="sidebar" i] a[href]',
        '[class*="Sidebar" i] a[href]',
        '[class*="menu" i] a[href]',
        '[role="navigation"] a[href]',
        '[class*="nav" i] a[href]',
        'a[href^="/"]',
    ]

    for container in containers:
        try:
            links = page.locator(container)
            count = await links.count()
            for i in range(count):
                link = links.nth(i)
                href = await link.get_attribute("href")
                if not href or href.startswith("#"):
                    continue
                text = re.sub(r"\s+", " ", (await link.inner_text() or "").strip())
                if not text or len(text) > 80:
                    continue
                lower = f"{text} {href}".lower()
                if any(word in lower for word in skip_words):
                    continue

                absolute = urljoin(page.url, href)
                if PANEL_BASE not in absolute and "shipmozo" not in absolute and "appiify" not in absolute:
                    continue

                if absolute in seen:
                    continue
                seen.add(absolute)
                pages.append({"text": text, "href": absolute})
        except Exception:
            continue

    return pages[:max_pages]


async def extract_page_context(page: Page, page_label: str = "") -> dict:
    data = await page.evaluate(
        """() => {
          const root = document.querySelector('main')
            || document.querySelector('[role="main"]')
            || document.querySelector('.content')
            || document.body;
          const clip = (s, n) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, n);
          const buttons = [...document.querySelectorAll('button, [role="button"], a.btn')]
            .map(el => clip(el.innerText || el.getAttribute('aria-label'), 80))
            .filter(Boolean);
          const links = [...document.querySelectorAll('nav a, aside a')]
            .map(el => ({ text: clip(el.innerText, 60), href: el.getAttribute('href') || '' }))
            .filter(x => x.text);
          const fields = [...document.querySelectorAll('input, select, textarea, label')]
            .map(el => {
              if (el.tagName === 'LABEL') return clip(el.innerText, 80);
              return clip(
                el.getAttribute('placeholder')
                  || el.getAttribute('aria-label')
                  || el.getAttribute('name')
                  || el.id,
                80
              );
            })
            .filter(Boolean);
          return {
            url: location.href,
            title: document.title,
            text: clip(root.innerText, 6000),
            buttons: [...new Set(buttons)].slice(0, 35),
            sidebarLinks: links.slice(0, 25),
            fields: [...new Set(fields)].slice(0, 35),
          };
        }"""
    )
    data["pageLabel"] = page_label
    data["notFound"] = text_indicates_not_found(
        data.get("text", ""),
        data.get("title", ""),
    )
    return data


async def save_shot(
    page: Page,
    out_dir: Path,
    name: str,
    label: str,
    step: int,
    *,
    content_ready: bool = False,
) -> dict | None:
    if poor_screenshot_label(label):
        return None

    if not content_ready and not await has_module_anchor(page):
        if not await page_has_usable_content(page):
            return None

    await wait_for_loaders_gone(page, timeout_s=3)

    filename = f"{step:02d}_{name}.png"
    path = out_dir / filename
    await asyncio.sleep(0.4)
    await page.screenshot(path=str(path), full_page=False)

    return {
        "id": name,
        "label": label,
        "step": step,
        "filename": filename,
        "path": str(path),
        "url": page.url,
        "captured_at": datetime.now(timezone.utc).isoformat(),
    }


async def visit_page(
    page: Page,
    out_dir: Path,
    nav_page: dict[str, str],
    step: int,
) -> tuple[list[dict], list[dict], int]:
    shots: list[dict] = []
    pages_data: list[dict] = []
    label = nav_page.get("text") or "Page"
    shot_id = slugify(label)

    try:
        reached, content_ready = await navigate_for_chat(page, nav_page)
        ctx = await extract_page_context(page, label)
        ctx["url"] = page.url
        ctx["navigated"] = reached
        ctx["contentReady"] = content_ready

        if not reached or ctx.get("notFound") or await page_looks_like_not_found(page):
            ctx["notFound"] = True
            ctx["error"] = "Page not found or could not be opened"
            pages_data.append(ctx)
            return shots, pages_data, step

        shot = await save_shot(
            page, out_dir, shot_id, f"Module view: {label}", step, content_ready=content_ready
        )
        if shot:
            step += 1
            shots.append(shot)
        else:
            ctx["poorScreenshot"] = True
        pages_data.append(ctx)
    except Exception as exc:
        pages_data.append({
            "url": nav_page.get("href"),
            "pageLabel": label,
            "error": str(exc),
            "notFound": True,
        })

    return shots, pages_data, step


async def browse_for_query(query: str, session_id: str) -> dict:
    out_dir = Path("output") / "cloud-images" / session_id / "raw"
    out_dir.mkdir(parents=True, exist_ok=True)

    p = browser = context = page = None
    pages_data: list[dict] = []
    screenshots: list[dict] = []
    visited_paths: set[str] = set()
    step = 0

    try:
        print("Chat browse: logging in...", file=sys.stderr, flush=True)
        p, browser, context, page = await async_login_and_save_state()
        page.set_default_timeout(45000)
        print(f"Chat browse: logged in at {page.url}", file=sys.stderr, flush=True)
        await dismiss_blocking_overlays(page)

        if await navigate_via_quick_search(page, query):
            print(f"Chat browse: quick search opened for {query!r}", file=sys.stderr, flush=True)
            qs_shots, qs_pages, step = await visit_page(
                page,
                out_dir,
                {"text": query, "href": page.url},
                step,
            )
            screenshots.extend(qs_shots)
            pages_data.extend(qs_pages)

        discovered = await discover_sidebar_pages(page, max_pages=12)
        to_visit = pick_pages_to_visit(query, discovered)

        for nav_page in to_visit:
            href = nav_page.get("href", "")
            path_key = urlparse(href).path.rstrip("/") or "/"
            if not href or path_key in visited_paths:
                continue
            visited_paths.add(path_key)
            print(f"Chat browse: visiting {nav_page.get('text')} -> {href}", file=sys.stderr, flush=True)
            new_shots, new_pages, step = await visit_page(page, out_dir, nav_page, step)
            print(
                f"Chat browse: shots={len(new_shots)} ready_pages={len([p for p in new_pages if not p.get('notFound')])}",
                file=sys.stderr,
                flush=True,
            )
            screenshots.extend(new_shots)
            pages_data.extend(new_pages)

        valid_pages = [
            p for p in pages_data if not p.get("notFound") and not p.get("poorScreenshot")
        ]
        bad_urls = {
            (p.get("url") or "").split("?")[0]
            for p in pages_data
            if (p.get("notFound") or p.get("poorScreenshot")) and p.get("url")
        }
        screenshots = [
            s
            for s in screenshots
            if (s.get("url") or "").split("?")[0] not in bad_urls
        ]
        if not valid_pages and pages_data:
            screenshots = [s for s in screenshots if s.get("id") == "after_login"][:1]

        if not pages_data:
            pages_data.append(await extract_page_context(page, "Current view"))
            valid_pages = [
                p for p in pages_data if not p.get("notFound") and not p.get("poorScreenshot")
            ]

        return {
            "ok": True,
            "query": query,
            "session_id": session_id,
            "headless": HEADLESS,
            "nav_map_source": NAV_MAP.get("source"),
            "nav_map_pages": len(CATALOG_PAGES),
            "discovered_count": len(discovered),
            "visited_count": len(visited_paths),
            "visited_pages": [p.get("pageLabel") or p.get("text") for p in valid_pages],
            "skipped_not_found": sum(1 for p in pages_data if p.get("notFound")),
            "pages": valid_pages if valid_pages else pages_data,
            "screenshots": screenshots,
        }
    except Exception as exc:
        return {
            "ok": False,
            "query": query,
            "session_id": session_id,
            "error": str(exc),
            "pages": pages_data,
            "screenshots": screenshots,
        }
    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if p:
            await p.stop()


async def main() -> None:
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "Usage: parse_panel_for_chat.py <session_id> <query>"}))
        sys.exit(2)

    session_id = sys.argv[1]
    query = " ".join(sys.argv[2:])
    result = await browse_for_query(query, session_id)
    print(json.dumps(result))
    if not result.get("ok"):
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
