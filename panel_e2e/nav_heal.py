"""Self-healing navigation: discover the fastest way to Rate Calculator, save & reuse."""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from pathlib import Path
from typing import Any

from playwright.async_api import Page

from panel_navigate import click_nav_link, expand_sidebar_sections
from panel_navigation import load_navigation_map
from panel_quick_search import navigate_via_quick_search
from panel_ui_helpers import dismiss_blocking_overlays
from panel_url import default_panel_base, panel_origin, rewrite_href

from panel_page_state import page_looks_like_not_found
from panel_e2e.rate_calculator import _on_rate_calculator_page, quick_search_to_rate_calculator

ROOT = Path(__file__).resolve().parent.parent
NAV_SCRIPT_PATH = ROOT / "output" / "runtime" / "e2e-nav-rate-calculator.json"
STRATEGY_TIMEOUT_MS = 6000
CACHE_MAX_AGE_S = 6 * 60 * 60


def _now_ms() -> float:
    return time.time() * 1000


def _heal_progress_path() -> Path | None:
    run_id = os.getenv("HEAL_PROGRESS_RUN_ID", "").strip()
    if not run_id:
        return None
    safe = re.sub(r"[^a-zA-Z0-9_-]", "_", run_id)
    return ROOT / "output" / "runtime" / f"heal-progress-{safe}.json"


def _write_heal_progress(attempts: list[dict[str, Any]], *, phase: str = "running", page_url: str = "") -> None:
    path = _heal_progress_path()
    if not path:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "phase": phase,
        "attempts": attempts,
        "pageUrl": page_url,
        "at": time.time(),
    }
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def _format_attempt_log(strategy: dict[str, Any], ok: bool, page: Page, *, extra: str = "") -> str:
    sid = strategy.get("id") or "strategy"
    url = page.url if page else ""
    ms_note = ""
    if sid == "quick_search":
        q = strategy.get("query", "rate calculator")
        base = f'Ctrl+B → search "{q}"'
        if extra:
            base = f"{base} | {extra}"
        if ok:
            return f"✓ {base} → Rate Calculator at {url}"
        return f"✗ {base} — still on dashboard or form not detected ({url})"
    if sid == "manage_courier_tab":
        base = "Courier hub → Rate Calculator tab"
    elif sid == "courier_sidebar":
        base = "Sidebar courier icon → Rate Calculator tab"
    elif sid == "direct_goto":
        base = f"Direct URL {strategy.get('url', '')}"
    elif sid == "cached_replay":
        base = f"Replay cached {strategy.get('strategyId', '')}"
    else:
        base = sid
        if strategy.get("label"):
            base = f'{sid} "{strategy.get("label")}"'
        elif strategy.get("url"):
            base = f"{sid} {strategy.get('url')}"
    if ok:
        return f"✓ {base} ({url})"
    return f"✗ {base} — failed ({url})"


def _enrich_attempt(strategy: dict[str, Any], ok: bool, ms: int, page: Page, **extra: Any) -> dict[str, Any]:
    entry = {
        "id": strategy.get("id"),
        "ok": ok,
        "ms": ms,
        "pageUrl": page.url if page else "",
        "logLine": _format_attempt_log(strategy, ok, page, extra=extra.get("detail", "")),
        **{k: v for k, v in strategy.items() if k != "id"},
        **{k: v for k, v in extra.items() if k != "detail"},
    }
    if extra.get("logs"):
        entry["logs"] = extra["logs"]
    return entry


def _script_is_stale_bad(script: dict[str, Any]) -> bool:
    sid = script.get("strategyId") or ""
    url = str(script.get("url") or script.get("pageUrl") or "").lower()
    if sid in ("manage_courier_tab", "courier_sidebar", "direct_goto") and "manage-courier" in url:
        return True
    if sid in ("manage_courier_tab", "courier_sidebar"):
        return True
    return False


def load_nav_script() -> dict[str, Any] | None:
    if not NAV_SCRIPT_PATH.exists():
        return None
    try:
        data = json.loads(NAV_SCRIPT_PATH.read_text(encoding="utf-8"))
        if not data.get("strategyId"):
            return None
        if _script_is_stale_bad(data):
            try:
                NAV_SCRIPT_PATH.unlink(missing_ok=True)
            except Exception:
                pass
            return None
        return data
    except Exception:
        return None


def save_nav_script(script: dict[str, Any]) -> None:
    NAV_SCRIPT_PATH.parent.mkdir(parents=True, exist_ok=True)
    NAV_SCRIPT_PATH.write_text(json.dumps(script, indent=2), encoding="utf-8")


def _normalize_panel_host(url: str) -> str:
    from urllib.parse import urlparse

    host = urlparse(url or "").netloc.lower()
    return host.replace("appiify.com", "appify.com")


def script_fresh(script: dict[str, Any]) -> bool:
    verified = float(script.get("verifiedAt") or 0)
    if not verified:
        return False
    age_s = time.time() - verified
    if age_s > CACHE_MAX_AGE_S:
        return False
    expected = default_panel_base().rstrip("/")
    origin = str(script.get("origin") or "").rstrip("/")
    if not origin:
        return True
    return _normalize_panel_host(origin) == _normalize_panel_host(expected)


async def _verify_on_page(page: Page, timeout_ms: int = 4000) -> bool:
    deadline = _now_ms() + timeout_ms
    while _now_ms() < deadline:
        if await _on_rate_calculator_page(page):
            return True
        await asyncio.sleep(0.25)
    return await _on_rate_calculator_page(page)


async def _try_direct_goto(page: Page, url: str) -> bool:
    if "manage-courier" in (url or "").lower():
        return False
    try:
        await page.goto(url, wait_until="commit", timeout=STRATEGY_TIMEOUT_MS)
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=2500)
        except Exception:
            pass
        if await page_looks_like_not_found(page):
            return False
        return await _verify_on_page(page, 2500)
    except Exception:
        return False


async def _try_js_route(page: Page, path: str) -> bool:
    origin = await panel_origin(page)
    try:
        await page.evaluate(
            """(path) => {
              try { window.history.pushState({}, '', path); } catch (e) {}
              window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
            }""",
            path,
        )
        await asyncio.sleep(0.6)
        if not await _verify_on_page(page, 2500):
            await page.goto(f"{origin}{path}", wait_until="commit", timeout=STRATEGY_TIMEOUT_MS)
        return await _verify_on_page(page, 3500)
    except Exception:
        return False


async def _try_sidebar_href(page: Page) -> bool:
    try:
        loc = page.locator('aside a[href*="rate-calculator"], nav a[href*="rate-calculator"]').first
        if await loc.count() == 0:
            return False
        await loc.click(timeout=4000)
        await asyncio.sleep(0.35)
        return await _verify_on_page(page, 4000)
    except Exception:
        return False


async def _try_sidebar_icon(page: Page, index: int) -> bool:
    try:
        links = page.locator("aside a, aside button, nav[class*='sidebar'] a")
        if await links.count() <= index:
            return False
        item = links.nth(index)
        if not await item.is_visible():
            return False
        await item.click(timeout=4000)
        await asyncio.sleep(0.4)
        return await _verify_on_page(page, 4000)
    except Exception:
        return False


async def _try_link_text(page: Page, label: str) -> bool:
    try:
        link = page.get_by_role("link", name=label)
        if await link.count() == 0:
            link = page.get_by_text(label, exact=False)
        if await link.count() == 0:
            return False
        await link.first.click(timeout=4000)
        await asyncio.sleep(0.35)
        return await _verify_on_page(page, 4000)
    except Exception:
        return False


async def _click_rate_calculator_tab(page: Page) -> bool:
    import re

    for pat in (r"rate\s*calcul", r"shipment\s*price\s*list"):
        try:
            tab = page.get_by_role("tab", name=re.compile(pat, re.I))
            if await tab.count() == 0:
                tab = page.get_by_text(re.compile(pat, re.I))
            if await tab.count() == 0:
                continue
            await tab.first.click(timeout=5000)
            await asyncio.sleep(0.5)
            return True
        except Exception:
            continue
    return False


async def _try_courier_sidebar(page: Page) -> bool:
    """Icon-only sidebar: open Courier section then Rate Calculator tab."""
    await dismiss_blocking_overlays(page)
    await expand_sidebar_sections(page)

    for sel in (
        'aside a[href*="rate-calculator"]',
        'aside a[href*="manage-courier"]',
        'aside a[href*="courier"]',
        'nav a[href*="courier"]',
    ):
        try:
            loc = page.locator(sel).first
            if await loc.count() == 0 or not await loc.is_visible():
                continue
            await loc.click(timeout=5000)
            await asyncio.sleep(0.7)
            if await _on_rate_calculator_page(page):
                return True
            if await _click_rate_calculator_tab(page):
                return await _verify_on_page(page, 5000)
        except Exception:
            continue

    try:
        links = page.locator("aside a, aside button")
        count = await links.count()
        for idx in (3, 4, 2, 5):
            if count <= idx:
                continue
            try:
                item = links.nth(idx)
                if not await item.is_visible():
                    continue
                await item.click(timeout=4000)
                await asyncio.sleep(0.7)
                if await _on_rate_calculator_page(page):
                    return True
                if await _click_rate_calculator_tab(page):
                    return await _verify_on_page(page, 5000)
            except Exception:
                continue
    except Exception:
        pass
    return False


async def _try_manage_courier_tab(page: Page) -> bool:
    await dismiss_blocking_overlays(page)
    origin = await panel_origin(page)
    if not await _try_direct_goto(page, f"{origin}/courier/manage-courier"):
        if not await _try_courier_sidebar(page):
            return False
    if await _on_rate_calculator_page(page):
        return True
    if not await _click_rate_calculator_tab(page):
        return False
    return await _verify_on_page(page, 5000)


async def _try_nav_map_link(page: Page) -> bool:
    origin = await panel_origin(page)
    for nav in load_navigation_map().get("pages", []):
        text = (nav.get("text") or "").lower()
        if "rate" in text and "calcul" in text:
            href = rewrite_href(nav.get("href", ""), origin)
            if href and await _try_direct_goto(page, href):
                return True
    await expand_sidebar_sections(page)
    target = f"{origin}/courier/rate-calculator"
    if await click_nav_link(page, "Rate Calculator", target):
        return await _verify_on_page(page, 4000)
    return False


async def _try_discover_aside(page: Page) -> bool:
    try:
        links = page.locator("aside a[href]")
        count = min(await links.count(), 24)
        for i in range(count):
            href = (await links.nth(i).get_attribute("href") or "").lower()
            if not any(k in href for k in ("rate", "calcul", "courier")):
                continue
            await links.nth(i).click(timeout=3500)
            await asyncio.sleep(0.35)
            if await _verify_on_page(page, 3000):
                return True
    except Exception:
        pass
    return False


async def _try_quick_search(page: Page, query: str) -> tuple[bool, list[str]]:
    logs: list[str] = []
    ok = await navigate_via_quick_search(
        page,
        query or "rate calculator",
        verify_fn=_on_rate_calculator_page,
        timeout_s=12.0,
        logs=logs,
    )
    return ok, logs


def _quick_search_strategies() -> list[dict[str, Any]]:
    return [
        {"id": "quick_search", "query": "rate calculator"},
        {"id": "quick_search", "query": "Rate Calculator"},
    ]


def _build_strategies(origin: str) -> list[dict[str, Any]]:
    """Fallback strategies — never use manage-courier (404 on many tenants)."""
    base = origin.rstrip("/")
    return [
        *_quick_search_strategies(),
        {"id": "direct_goto", "url": f"{base}/courier/rate-calculator"},
        {"id": "direct_goto", "url": f"{base}/tools/rate-calculator"},
        {"id": "link_text", "label": "Rate Calculator"},
    ]


async def _run_strategy(page: Page, strategy: dict[str, Any]) -> tuple[bool, list[str]]:
    sid = strategy.get("id")
    if sid == "quick_search":
        return await _try_quick_search(page, strategy.get("query", "rate calculator"))
    if sid == "direct_goto":
        return await _try_direct_goto(page, strategy["url"]), []
    if sid == "sidebar_href":
        return await _try_sidebar_href(page), []
    if sid == "sidebar_icon":
        return await _try_sidebar_icon(page, int(strategy.get("index", 4))), []
    if sid == "link_text":
        return await _try_link_text(page, strategy.get("label", "Rate Calculator")), []
    if sid == "manage_courier_tab":
        return await _try_manage_courier_tab(page), []
    if sid == "courier_sidebar":
        return await _try_courier_sidebar(page), []
    if sid == "js_route":
        return await _try_js_route(page, strategy.get("path", "/courier/rate-calculator")), []
    if sid == "nav_map_link":
        return await _try_nav_map_link(page), []
    if sid == "discover_aside":
        return await _try_discover_aside(page), []
    return False, []


def _strategy_from_script(script: dict[str, Any]) -> dict[str, Any]:
    strategy: dict[str, Any] = {"id": script.get("strategyId")}
    for key in ("url", "path", "index", "label", "query"):
        if key in script:
            strategy[key] = script[key]
    return strategy


async def apply_nav_script(page: Page, script: dict[str, Any], *, timeout_ms: int = 5000) -> bool:
    if not script or not script.get("strategyId"):
        return False
    if await _on_rate_calculator_page(page):
        return True
    sid = script.get("strategyId")
    if sid == "ai_script":
        from panel_e2e.ai_script import execute_nav_script, load_ai_script

        ai_path = script.get("aiScriptPath") or ""
        ai_script = load_ai_script(ai_path) if ai_path else None
        if not ai_script and script.get("navSteps"):
            ai_script = {"navSteps": script.get("navSteps"), "verifyTexts": script.get("verifyTexts") or []}
        if ai_script:
            result = await execute_nav_script(page, ai_script)
            return bool(result.get("ok"))
    strategy = _strategy_from_script(script)
    ok, _ = await _run_strategy(page, strategy)
    if ok:
        return True
    url = script.get("url") or ""
    if url and "manage-courier" not in url.lower():
        ok = await _try_direct_goto(page, url)
    return ok and await _verify_on_page(page, min(timeout_ms, 4000))


async def heal_rate_calculator_nav(page: Page, *, force: bool = False) -> dict[str, Any]:
    """Try strategies until Rate Calculator opens; save winning script."""
    await dismiss_blocking_overlays(page)
    origin = await panel_origin(page)
    attempts: list[dict[str, Any]] = []
    _write_heal_progress(attempts, phase="starting", page_url=page.url)

    def _success_payload(*, cached: bool, script: dict[str, Any]) -> dict[str, Any]:
        _write_heal_progress(attempts, phase="done", page_url=page.url)
        last = attempts[-1] if attempts else {}
        return {
            "ok": True,
            "cached": cached,
            "script": script,
            "origin": origin,
            "pageUrl": page.url,
            "ms": last.get("ms", 0),
            "attempts": attempts,
        }

    async def _try_strategy(strategy: dict[str, Any], *, cached: bool = False) -> dict[str, Any] | None:
        t0 = _now_ms()
        try:
            ok, qs_logs = await _run_strategy(page, strategy)
        except Exception as exc:
            entry = _enrich_attempt(
                strategy,
                False,
                int(_now_ms() - t0),
                page,
                cached=cached,
                error=str(exc)[:120],
            )
            attempts.append(entry)
            _write_heal_progress(attempts, page_url=page.url)
            return None

        detail = " | ".join(qs_logs[-3:]) if qs_logs else ""
        entry = _enrich_attempt(
            strategy,
            ok,
            int(_now_ms() - t0),
            page,
            cached=cached,
            detail=detail,
            logs=qs_logs or None,
        )
        attempts.append(entry)
        _write_heal_progress(attempts, page_url=page.url)

        if ok:
            replay = _strategy_from_script(
                {"strategyId": strategy.get("id"), **{k: v for k, v in strategy.items() if k != "id"}}
            )
            script = {
                "target": "rate_calculator",
                "origin": origin,
                "strategyId": strategy.get("id") if strategy.get("id") != "cached_replay" else strategy.get("strategyId"),
                "verifiedAt": time.time(),
                "pageUrl": page.url,
                **{k: v for k, v in replay.items() if k != "id"},
            }
            save_nav_script(script)
            return _success_payload(cached=cached, script=script)
        return None

    # Fast path: Ctrl+B only (~5–15s). Avoid 100s of fallback gotos after login.
    t0 = _now_ms()
    if await quick_search_to_rate_calculator(page):
        script = {
            "target": "rate_calculator",
            "origin": origin,
            "strategyId": "quick_search",
            "query": "rate calculator",
            "verifiedAt": time.time(),
            "pageUrl": page.url,
        }
        save_nav_script(script)
        entry = _enrich_attempt(
            {"id": "quick_search", "query": "rate calculator"},
            True,
            int(_now_ms() - t0),
            page,
            detail="Ctrl+B fast path",
        )
        attempts.append(entry)
        _write_heal_progress(attempts, phase="done", page_url=page.url)
        return _success_payload(cached=False, script=script)

    for strategy in _quick_search_strategies():
        won = await _try_strategy(strategy)
        if won:
            return won
        if await _on_rate_calculator_page(page):
            script = {
                "target": "rate_calculator",
                "origin": origin,
                "strategyId": "quick_search",
                "query": strategy.get("query", "rate calculator"),
                "verifiedAt": time.time(),
                "pageUrl": page.url,
            }
            save_nav_script(script)
            return _success_payload(cached=False, script=script)

    full_heal = os.getenv("PANEL_NAV_FULL_HEAL", "").lower() in ("1", "true", "yes")
    if full_heal:
        cached = load_nav_script()
        if cached and script_fresh(cached) and not force and cached.get("strategyId") == "quick_search":
            strat = {**_strategy_from_script(cached), "id": "cached_replay"}
            won = await _try_strategy(strat, cached=True)
            if won:
                return won
        for strategy in _build_strategies(origin):
            if strategy.get("id") == "quick_search":
                continue
            won = await _try_strategy(strategy)
            if won:
                return won

    _write_heal_progress(attempts, phase="failed", page_url=page.url)
    return {
        "ok": False,
        "cached": False,
        "origin": origin,
        "pageUrl": page.url,
        "attempts": attempts,
        "error": "Could not reach Rate Calculator — Ctrl+B Quick Search and fallbacks failed",
    }
