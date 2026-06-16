from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

from playwright.async_api import Page


def _load_dotenv() -> None:
    env_path = Path(__file__).resolve().parent / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_dotenv()

from panel_doc_module import (
    docs_capture_allow_direct_urls,
    docs_capture_allow_nav_map_url,
    docs_capture_allow_order_form_url,
    docs_capture_use_nav_map,
    is_add_order_target,
    is_channel_target,
    is_new_orders_target,
    is_quick_add_target,
    is_rate_calculator_target,
    resolve_doc_module,
)
from panel_e2e.channel_pages import (
    navigate_channel_to_target,
    channel_page_usable,
    heal_channel_nav,
    on_channel_page,
)
from panel_e2e.nav_heal import heal_rate_calculator_nav
from panel_e2e.rate_calculator import (
    _on_rate_calculator_page,
    goto_rate_calculator_immediately,
    navigate_to_rate_calculator,
    quick_search_to_rate_calculator,
)
from panel_quick_search import navigate_module_via_quick_search
from panel_ui_helpers import dismiss_blocking_overlays, page_has_blocking_dialog
from panel_orders import goto_new_orders_domestic
from panel_navigation import is_junk_nav_label, load_navigation_map, merge_page_lists, rank_pages_for_module
from panel_navigate import navigate_for_chat, navigate_module_via_nav_map, page_looks_like_not_found
from panel_screenshot import (
    has_module_anchor,
    page_has_usable_content,
    poor_screenshot_label,
    prepare_for_screenshot,
    take_element_screenshot,
    take_page_screenshot,
    wait_for_loaders_gone,
    wait_for_module_content,
)
from panel_url import panel_origin, rate_calculator_urls
from panel_e2e.docs_capture_heal import (
    apply_capture_heal_plan,
    load_heal_plan_from_env,
    verify_module_target,
)
from panel_e2e.page_observe import capture_page_observation
from panel_e2e.e2e_log import e2e_log
from shipmozo_login import HEADLESS, LOGIN_URLS
from shipmozo_login import async_login_and_save_state
from shipmozo_login import first_visible, is_logged_in, panel_credentials

PANEL_BASE = LOGIN_URLS[0].rstrip("/")


def capture_log(message: str) -> None:
    e2e_log("doc-capture", message)


_ON_RENDER = os.getenv("RENDER", "").lower() in {"true", "1", "yes"} or bool(
    os.getenv("RENDER_EXTERNAL_URL", "").strip()
)

DOCS_CAPTURE_FAST = os.getenv("DOCS_CAPTURE_FAST", "1").lower() in {"1", "true", "yes"}


def _record_video_enabled() -> bool:
    return os.getenv("DOCS_RECORD_VIDEO", os.getenv("RECORD_VIDEO", "")).lower() in {
        "1",
        "true",
        "yes",
    }


_default_budget = (
    "180"
    if _ON_RENDER
    else ("120" if DOCS_CAPTURE_FAST else "120")
)
DOCS_CAPTURE_BUDGET_S = float(os.getenv("DOCS_CAPTURE_BUDGET_S", _default_budget))
DOCS_CAPTURE_SINGLE_SHOT = os.getenv("DOCS_CAPTURE_SINGLE_SHOT", "").lower() in {"1", "true", "yes"}
DOCS_CAPTURE_HEAL_ENABLED = os.getenv(
    "DOCS_CAPTURE_HEAL_ENABLED", "false" if _ON_RENDER else "true"
).lower() not in {
    "0",
    "false",
    "no",
    "off",
}
_default_heal_attempts = (
    os.getenv("DOCS_CAPTURE_HEAL_ATTEMPTS")
    if os.getenv("DOCS_CAPTURE_HEAL_ATTEMPTS")
    else ("1" if _ON_RENDER else ("5" if DOCS_CAPTURE_HEAL_ENABLED else "3"))
)
DOCS_CAPTURE_INLINE_HEAL_ATTEMPTS = max(1, int(_default_heal_attempts or "3"))
DOCS_CAPTURE_OBSERVE_ONLY = os.getenv("DOCS_CAPTURE_OBSERVE_ONLY", "").lower() in {
    "1",
    "true",
    "yes",
}
_default_post_nav = "2.5"
DOCS_CAPTURE_POST_NAV_WAIT_S = float(os.getenv("DOCS_CAPTURE_POST_NAV_WAIT_S", _default_post_nav))

_default_video_walk = (
    "5"
    if _ON_RENDER and _record_video_enabled()
    else (
        "10"
        if _record_video_enabled()
        else ("0" if _ON_RENDER else "12")
    )
)
DOCS_VIDEO_WALKTHROUGH_S = float(os.getenv("DOCS_VIDEO_WALKTHROUGH_S", _default_video_walk))
_default_add_order_video = (
    "12"
    if _ON_RENDER and _record_video_enabled()
    else (
        "14"
        if _record_video_enabled()
        else ("0" if _ON_RENDER else "18")
    )
)
DOCS_ADD_ORDER_VIDEO_S = float(os.getenv("DOCS_ADD_ORDER_VIDEO_S", _default_add_order_video))

_capture_context = None


def docs_fast() -> bool:
    return DOCS_CAPTURE_FAST


def single_shot_mode() -> bool:
    if DOCS_CAPTURE_SINGLE_SHOT:
        return True
    return DOCS_CAPTURE_BUDGET_S <= 30


def allow_direct_urls() -> bool:
    return docs_capture_allow_direct_urls()


def docs_capture_heal_enabled() -> bool:
    return DOCS_CAPTURE_HEAL_ENABLED


async def page_ready_for_module_shot(
    page: Page, module_name: str, description: str = ""
) -> bool:
    verified, reason = await verify_module_target(page, module_name, description)
    if not verified:
        capture_log(f"verify failed: {reason} | url={page.url}")
    return verified


async def build_page_state(
    page: Page, module_name: str, description: str = ""
) -> dict:
    return await capture_page_observation(
        page, module_name=module_name, description=description
    )


async def run_pre_capture_heal_loop(
    page: Page, module_name: str, description: str, canonical: str
) -> dict:
    """Observe → heal → verify before any screenshot or video."""
    last_obs: dict | None = None
    attempts = DOCS_CAPTURE_INLINE_HEAL_ATTEMPTS if docs_capture_heal_enabled() else 1

    for attempt in range(1, attempts + 1):
        capture_log(f"pre-capture heal attempt {attempt}/{attempts} url={page.url}")
        await dismiss_blocking_overlays(page)
        last_obs = await build_page_state(page, module_name, description)
        if last_obs.get("moduleVerified"):
            capture_log(f"pre-capture verified on attempt {attempt}")
            return {"ok": True, "observation": last_obs, "attempts": attempt}

        if not docs_capture_heal_enabled():
            capture_log("inline heal disabled — trying direct module navigation")
            if is_rate_calculator_target(module_name, description):
                await navigate_to_rate_calculator(page)
            elif is_channel_target(module_name, description):
                await navigate_channel_to_target(page, module_name, description)
            elif is_add_order_target(module_name, description):
                await navigate_to_add_order_form(page, module_name, description)
            elif is_new_orders_target(module_name, description):
                origin = await panel_origin(page)
                await goto_new_orders_domestic(page, origin)
            else:
                await navigate_module_via_quick_search(page, module_name, description)
            await _pause(0.8)
            last_obs = await build_page_state(page, module_name, description)
            if last_obs.get("moduleVerified"):
                capture_log("direct navigation verified module")
                return {"ok": True, "observation": last_obs, "attempts": attempt}
            break

        healed = await heal_navigation_for_module(page, module_name, description, canonical)
        capture_log(f"heal_navigation_for_module -> {healed} url={page.url}")
        await _pause(0.8)
        if healed:
            continue

    last_obs = await build_page_state(page, module_name, description)
    return {
        "ok": bool(last_obs.get("moduleVerified")),
        "observation": last_obs,
        "attempts": attempts,
    }


async def heal_navigation_for_module(
    page: Page, module_name: str, description: str, canonical: str
) -> bool:
    """Inline verify+heal during capture (Python nav heal, before Node LLM retry)."""
    if not docs_capture_heal_enabled():
        return False

    heal_plan = load_heal_plan_from_env()
    if heal_plan:
        result = await apply_capture_heal_plan(
            page, heal_plan, module_name=module_name, description=description
        )
        if result.get("ok") and await page_ready_for_module_shot(page, module_name, description):
            return True

    if is_rate_calculator_target(module_name, description):
        if await quick_search_to_rate_calculator(page):
            return True
        heal = await heal_rate_calculator_nav(page, force=True)
        if heal.get("ok") or await _on_rate_calculator_page(page):
            return True
        return await navigate_to_rate_calculator(page)

    if is_channel_target(module_name, description):
        staged = await navigate_channel_to_target(page, module_name, description)
        if staged.get("ok"):
            return True
        heal = await heal_channel_nav(page, module_name, description)
        if heal.get("ok") or await channel_page_usable(page, module_name, description):
            return True
        return await open_module_self_heal(page, canonical or module_name, description)

    if is_add_order_target(module_name, description):
        if await navigate_to_add_order_form(page, module_name, description):
            return True
        if docs_capture_use_nav_map():
            nav = await navigate_module_via_nav_map(page, module_name, description, max_pages=4)
            if nav.get("ok") and await page_ready_for_module_shot(page, module_name, description):
                return True
        return await open_module_self_heal(page, canonical or module_name, description)

    return await open_module_self_heal(page, canonical or module_name, description)


async def ensure_module_reachable(
    page: Page, module_name: str, description: str, canonical: str
) -> bool:
    if await page_ready_for_module_shot(page, module_name, description):
        return True
    if not docs_capture_heal_enabled():
        return False
    for _ in range(DOCS_CAPTURE_INLINE_HEAL_ATTEMPTS):
        if await heal_navigation_for_module(page, module_name, description, canonical):
            await _pause(0.8)
            if await page_ready_for_module_shot(page, module_name, description):
                return True
    return await page_ready_for_module_shot(page, module_name, description)


def _nav_timeout_ms() -> int:
    return 12_000 if docs_fast() else 45_000


async def _pause(seconds: float) -> None:
    await asyncio.sleep(seconds * 0.35 if docs_fast() else seconds)

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
    "add order": [
        "text=Add Order",
        'a:has-text("Add Order")',
        '[href*="/orders/add"]',
        'button:has-text("Create")',
    ],
    "quick add": [
        "text=Quick Add",
        'a:has-text("Quick Add")',
        '[href*="/orders/quick-add"]',
    ],
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
    "amazon": [
        "text=Amazon",
        'a:has-text("Amazon")',
        '[href*="amazon"]',
        '[href*="/channels"]',
    ],
    "channels": [
        "text=Channels",
        'a:has-text("Channels")',
        '[href*="/channels"]',
    ],
    "rate calculator": [
        "text=Rate Calculator",
        'a:has-text("Rate Calculator")',
        '[href*="rate-calculator"]',
        'nav a:has-text("Rate")',
    ],
    "tools": [
        "text=Rate Calculator",
        'a:has-text("Rate Calculator")',
        '[href*="rate-calculator"]',
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
    "amazon": [
        f"{PANEL_BASE}/channels/amazon",
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
    "rate calculator": [
        f"{PANEL_BASE}/courier/rate-calculator",
        f"{PANEL_BASE}/tools/rate-calculator",
    ],
    "rate": [
        f"{PANEL_BASE}/courier/rate-calculator",
    ],
    "add order": [
        f"{PANEL_BASE}/orders/add?type=DOM",
        f"{PANEL_BASE}/orders/add",
    ],
    "quick add": [
        f"{PANEL_BASE}/orders/quick-add",
    ],
}

FALLBACK_PANEL_PAGES: list[dict[str, str]] = NAV_CATALOG


def slugify(value: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return s or "module"


def is_dashboard_module(module_name: str) -> bool:
    return "dashboard" in module_name.lower()


def normalize_module_for_test(module_name: str, description: str = "") -> str:
    return resolve_doc_module(module_name, description)


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
    from panel_navigation import score_page_for_module

    return score_page_for_module(module_name, description, nav_page)


def rank_nav_pages(module_name: str, description: str, discovered: list[dict]) -> list[dict]:
    return rank_pages_for_module(module_name, description, discovered)


def is_login_dashboard_shot(shot: dict) -> bool:
    label = (shot.get("label") or "").lower()
    shot_id = shot.get("id", "")
    return shot_id == "dashboard_after_login" or "after login" in label


def filter_good_module_shots(shots: list[dict]) -> list[dict]:
    return [
        s
        for s in (shots or [])
        if not s.get("rejected") and not is_login_dashboard_shot(s) and not s.get("notFound")
    ]


async def try_direct_urls(page: Page, module_name: str, description: str = "") -> bool:
    nav_map_ok = docs_capture_use_nav_map() and docs_capture_allow_nav_map_url()
    if not allow_direct_urls():
        if not (
            is_add_order_target(module_name, description)
            and docs_capture_allow_order_form_url()
        ) and not nav_map_ok:
            return False
    canonical = resolve_doc_module(module_name, description)
    key = f"{canonical} {module_name} {description}".lower()
    urls: list[str] = []
    if is_add_order_target(module_name, description):
        origin = await panel_origin(page)
        if is_quick_add_target(module_name, description):
            urls.extend([f"{origin}/orders/quick-add", f"{origin}/orders/add?type=DOM"])
        else:
            urls.extend([f"{origin}/orders/add?type=DOM", f"{origin}/orders/add"])
    if is_rate_calculator_target(module_name, description):
        origin = await panel_origin(page)
        urls.extend(rate_calculator_urls(origin))
    for hint_key, hint_urls in DIRECT_URL_HINTS.items():
        if hint_key in key or key in hint_key:
            urls.extend(hint_urls)
    if "calcul" in key:
        urls.extend(DIRECT_URL_HINTS.get("rate calculator", []))
    for nav_page in NAV_CATALOG:
        if score_nav_page(module_name, description, nav_page) >= 4:
            urls.append(nav_page["href"])
    for nav_page in rank_pages_for_module(module_name, description)[:4]:
        href = nav_page.get("href")
        if href:
            urls.append(href)

    seen: set[str] = set()
    for url in urls:
        if url in seen:
            continue
        seen.add(url)
        try:
            await page.goto(url, wait_until="commit" if docs_fast() else "domcontentloaded", timeout=_nav_timeout_ms())
            await _pause(2)
            if await page_looks_like_not_found(page):
                continue
            if is_add_order_target(module_name, description):
                if await page_ready_for_module_shot(page, module_name, description):
                    return True
                continue
            if is_rate_calculator_target(module_name, description):
                if await _on_rate_calculator_page(page):
                    return True
                continue
            if await page_has_usable_content(page) or await has_module_anchor(page):
                return True
        except Exception:
            continue
    return False


async def finalize_doc_video(
    page: Page, context, out_dir: Path, module_name: str
) -> dict | None:
    if not _record_video_enabled():
        return None
    try:
        video = page.video
        if not video:
            capture_log("video finalize skip: page.video is None")
            return None
        try:
            await page.close()
        except Exception:
            pass
        # Playwright only writes the .webm after the browser context closes.
        try:
            await context.close()
        except Exception:
            pass
        src = await video.path()
        if not src:
            capture_log("video finalize skip: no path after context close")
            return None
        src_path = Path(src)
        if not src_path.exists():
            capture_log(f"video finalize skip: file missing {src_path}")
            return None
        dest_dir = out_dir / "videos"
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / f"walkthrough_{slugify(module_name)}.webm"
        shutil.copy2(src_path, dest)
        capture_log(f"video saved {dest.name} ({src_path.stat().st_size} bytes)")
        return {
            "id": f"video_{slugify(module_name)}_walkthrough",
            "label": f"Module walkthrough: {module_name}",
            "filename": dest.name,
            "path": str(dest),
            "type": "video/webm",
            "captured_at": datetime.now(timezone.utc).isoformat(),
        }
    except Exception as exc:
        capture_log(f"video finalize failed: {exc}")
        return None


async def finish_capture_bundle(
    page: Page | None,
    out_dir: Path,
    module_name: str,
    shots: list[dict],
    *,
    description: str = "",
    context=None,
) -> dict[str, list]:
    page_state: dict | None = None
    if page:
        try:
            await wait_for_walkthrough_video(page, module_name, description)
            page_state = await build_page_state(page, module_name, description)
        except Exception:
            page_state = None
    videos: list[dict] = []
    ctx = context or _capture_context
    if page and ctx:
        vid = await finalize_doc_video(page, ctx, out_dir, module_name)
        if vid:
            videos.append(vid)
    bundle: dict = {"shots": shots or [], "videos": videos}
    if page_state:
        bundle["pageState"] = page_state
    return bundle


async def _finalize_bundle(
    page: Page | None,
    bundle: dict,
    *,
    module_name: str = "",
    description: str = "",
) -> dict:
    """Attach live page observation for OpenAI heal loop (before page/video close)."""
    if page and not bundle.get("pageState"):
        try:
            bundle["pageState"] = await build_page_state(page, module_name, description)
        except Exception:
            pass
    heal_plan = load_heal_plan_from_env()
    if heal_plan and bundle.get("healApplied") is None:
        bundle["healPlanRequested"] = True
    return bundle


async def save_shot(
    page: Page,
    out_dir: Path,
    shot_id: str,
    label: str,
    step: int,
    *,
    full_page: bool = False,
    content_ready: bool = False,
    require_rate_calculator: bool = False,
    fast_e2e: bool = False,
    module_name: str = "",
    description: str = "",
) -> dict | None:
    capture_log(f"save_shot {shot_id!r} step={step} url={page.url}")
    if docs_fast():
        fast_e2e = True
    if poor_screenshot_label(label):
        capture_log(f"save_shot skip: poor label {label!r}")
        return None
    if await page_looks_like_not_found(page):
        capture_log(f"save_shot skip: 404/not-found url={page.url}")
        return None
    if not await is_logged_in(page):
        capture_log(f"save_shot skip: not logged in url={page.url}")
        return None
    if require_rate_calculator and not await _on_rate_calculator_page(page):
        capture_log("save_shot skip: not on rate calculator")
        return None
    if module_name and not await page_ready_for_module_shot(page, module_name, description):
        capture_log(f"save_shot skip: module not verified module={module_name!r}")
        return None

    await dismiss_blocking_overlays(page)
    if await page_has_blocking_dialog(page):
        capture_log("save_shot rejected: blocking dialog")
        return {
            "id": shot_id,
            "label": label,
            "step": step,
            "rejected": True,
            "rejectReason": "blocking confirmation dialog (unsaved changes)",
            "url": page.url,
        }

    if docs_fast():
        filename = f"{step:02d}_{shot_id}.png"
        target = out_dir / filename
        await take_page_screenshot(page, str(target), full_page=full_page)
        if module_name and not await page_ready_for_module_shot(page, module_name, description):
            capture_log(f"save_shot post-shot verify failed — deleting {filename}")
            try:
                target.unlink(missing_ok=True)
            except Exception:
                pass
            return None
        capture_log(f"save_shot ok {filename} url={page.url}")
        return {
            "id": shot_id,
            "label": label,
            "step": step,
            "filename": filename,
            "path": str(target),
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "url": page.url,
        }

    if not content_ready:
        ready, state = await prepare_for_screenshot(page)
        if not ready or state.get("notFound"):
            capture_log(f"save_shot skip: not ready state={state}")
            return None
        content_ready = True
    elif not await has_module_anchor(page):
        if require_rate_calculator and await _on_rate_calculator_page(page):
            content_ready = True
        elif docs_fast() and await page_has_usable_content(page, min_len=60):
            content_ready = True
        elif not await page_has_usable_content(page):
            return None
    if not fast_e2e:
        loader_timeout = 1.0 if content_ready else 4
        await wait_for_loaders_gone(page, timeout_s=loader_timeout)

    filename = f"{step:02d}_{shot_id}.png"
    target = out_dir / filename
    await take_page_screenshot(page, str(target), full_page=full_page)
    if module_name and not await page_ready_for_module_shot(page, module_name, description):
        try:
            target.unlink(missing_ok=True)
        except Exception:
            pass
        return {
            "id": shot_id,
            "label": label,
            "step": step,
            "rejected": True,
            "rejectReason": "post-screenshot verification failed (404/login/wrong module)",
            "url": page.url,
        }
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


async def wait_for_walkthrough_video(
    page: Page, module_name: str, description: str = ""
) -> None:
    """Hold on the target page so screen recording captures form load + scroll."""
    if not _record_video_enabled():
        return
    duration = DOCS_VIDEO_WALKTHROUGH_S
    if is_add_order_target(module_name, description):
        duration = max(duration, DOCS_ADD_ORDER_VIDEO_S)
    await wait_for_loaders_gone(page, timeout_s=5)
    steps = 5
    pause = (duration / steps) * (0.4 if docs_fast() else 1.0)
    for i in range(steps):
        await asyncio.sleep(pause)
        try:
            await page.evaluate(
                "(step) => window.scrollBy({ top: 180 * (step + 1), behavior: 'smooth' })",
                i,
            )
        except Exception:
            pass
    await asyncio.sleep(pause)
    try:
        await page.evaluate("window.scrollTo({ top: 0, behavior: 'smooth' })")
    except Exception:
        pass
    await asyncio.sleep(0.8 if docs_fast() else 1.5)


async def navigate_to_add_order_form(
    page: Page, module_name: str, description: str = ""
) -> bool:
    async def _verified(p: Page) -> bool:
        ok, _ = await verify_module_target(p, module_name, description)
        return ok

    if docs_capture_allow_order_form_url() or allow_direct_urls():
        origin = await panel_origin(page)
        for url in (
            f"{origin}/orders/add?type=DOM",
            f"{origin}/orders/add",
            f"{origin}/orders/quick-add",
        ):
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=_nav_timeout_ms())
                await dismiss_blocking_overlays(page)
                await _pause(DOCS_CAPTURE_POST_NAV_WAIT_S)
                await wait_for_module_content(page, timeout_s=10.0 if docs_fast() else 18.0)
                if await _verified(page) and not await page_has_blocking_dialog(page):
                    return True
            except Exception:
                continue

    quick = await navigate_module_via_quick_search(
        page, module_name, description, verify_fn=_verified, timeout_s=6.0 if docs_fast() else 10.0
    )
    if quick.get("ok") and await _verified(page):
        await dismiss_blocking_overlays(page)
        await _pause(DOCS_CAPTURE_POST_NAV_WAIT_S)
        await wait_for_module_content(page, timeout_s=10.0 if docs_fast() else 18.0)
        return not await page_has_blocking_dialog(page)

    if docs_capture_use_nav_map():
        nav = await navigate_module_via_nav_map(
            page, module_name, description, verify_fn=_verified, max_pages=4
        )
        if nav.get("ok") and await _verified(page):
            await dismiss_blocking_overlays(page)
            await _pause(DOCS_CAPTURE_POST_NAV_WAIT_S)
            await wait_for_module_content(page, timeout_s=10.0 if docs_fast() else 18.0)
            return not await page_has_blocking_dialog(page)

    return False


async def open_module_self_heal(
    page: Page, module_name: str, description: str = "", attempts: int = 3
) -> bool:
    async def _verified(p: Page) -> bool:
        if not module_name:
            return True
        ok, _ = await verify_module_target(p, module_name, description)
        return ok

    for _ in range(attempts):
        quick = await navigate_module_via_quick_search(
            page, module_name, description, verify_fn=_verified if module_name else None
        )
        if quick.get("ok") and not await page_looks_like_not_found(page):
            if module_name and not await page_ready_for_module_shot(page, module_name, description):
                if is_add_order_target(module_name, description):
                    if await navigate_to_add_order_form(page, module_name, description):
                        return True
                continue
            return True

        if docs_capture_use_nav_map():
            discovered = await discover_sidebar_pages(page, max_pages=20)
            nav = await navigate_module_via_nav_map(
                page,
                module_name,
                description,
                verify_fn=_verified if module_name else None,
                discovered=discovered,
                max_pages=4,
            )
            if nav.get("ok") and await page_ready_for_module_shot(page, module_name, description):
                return True

        if allow_direct_urls() and await try_direct_urls(page, module_name, description):
            if await page_ready_for_module_shot(page, module_name, description):
                return True
        if await try_role_link(page, module_name):
            if await page_ready_for_module_shot(page, module_name, description):
                return True
        for sel in build_nav_selectors(module_name):
            if await try_click_selector(page, sel):
                if await page_ready_for_module_shot(page, module_name, description):
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


async def _element_shot(
    page: Page,
    out_dir: Path,
    shot_id: str,
    label: str,
    step: int,
    locator,
) -> tuple[dict | None, int]:
    try:
        if await locator.count() == 0:
            return None, step
        target = locator.first
        await target.scroll_into_view_if_needed(timeout=4000)
        await asyncio.sleep(0.3)
        filename = f"{step:02d}_{shot_id}.png"
        path = out_dir / filename
        await take_element_screenshot(target, str(path))
        return (
            {
                "id": shot_id,
                "label": label,
                "step": step,
                "filename": filename,
                "path": str(path),
                "captured_at": datetime.now(timezone.utc).isoformat(),
                "url": page.url,
            },
            step + 1,
        )
    except Exception:
        return None, step


async def capture_rate_calculator_screenshots(
    page: Page,
    out_dir: Path,
    module_name: str,
    step: int = 0,
    target_module: str = "",
    description: str = "",
) -> list[dict]:
    """Navigate via self-healing nav and capture Rate Calculator screenshots."""
    shots: list[dict] = []
    verify_name = target_module or module_name
    await dismiss_blocking_overlays(page)

    if not await page_ready_for_module_shot(page, verify_name, description):
        heal = await heal_rate_calculator_nav(page, force=True)
        if not heal.get("ok"):
            await goto_rate_calculator_immediately(page)
        if not await page_ready_for_module_shot(page, verify_name, description):
            await navigate_to_rate_calculator(page)
        if not await page_ready_for_module_shot(page, verify_name, description):
            return shots

    await _pause(1.5)
    step += 1
    main = await save_shot(
        page,
        out_dir,
        "tools_module_overview",
        "Tools Module Overview",
        step,
        content_ready=True,
        require_rate_calculator=True,
        module_name=verify_name,
        description=description,
    )
    if main and not main.get("rejected"):
        shots.append(main)
        step = main["step"]

    if docs_fast():
        return shots

    field_specs = [
        ("input_origin", "Input Origin", r"origin|pickup|from", 'input[placeholder*="pin" i]'),
        ("input_destination", "Input Destination", r"delivery|destination|to", None),
        ("input_weight", "Input Weight", r"weight", 'input[placeholder*="weight" i]'),
        (
            "input_dimensions",
            "Input Dimensions",
            r"length|width|height|dimension",
            'input[placeholder*="length" i], input[placeholder*="dimension" i]',
        ),
        ("calculate_button", "Calculate Button", r"calculate", 'button:has-text("Calculate")'),
    ]

    for shot_id, label, _label_pat, css in field_specs:
        loc = None
        if css:
            loc = page.locator(css)
        else:
            try:
                loc = page.get_by_label(re.compile(r"delivery|destination", re.I))
            except Exception:
                loc = page.locator('input[placeholder*="deliver" i], input[placeholder*="pin" i]').nth(1)
        shot, step = await _element_shot(page, out_dir, shot_id, label, step + 1, loc)
        if shot:
            shots.append(shot)

    if len(shots) < 2:
        fallback = await save_shot(
            page,
            out_dir,
            f"module_{slugify(module_name)}_rate_calc",
            f"Module view: {module_name}",
            step + 1,
            content_ready=True,
            require_rate_calculator=True,
            module_name=verify_name,
            description=description,
        )
        if fallback and not fallback.get("rejected") and not shots:
            shots.append(fallback)

    return shots


async def _capture_channel_fast(
    page: Page,
    out_dir: Path,
    module_name: str,
    description: str,
    canonical: str,
) -> dict[str, list]:
    shots: list[dict] = []
    step = 0

    loop = await run_pre_capture_heal_loop(page, module_name, description, canonical)
    if not loop.get("ok"):
        staged = await navigate_channel_to_target(page, module_name, description)
        if not staged.get("ok") and docs_capture_heal_enabled():
            await heal_channel_nav(page, module_name, description)

    if await page_ready_for_module_shot(page, module_name, description):
        main = await save_shot(
            page,
            out_dir,
            f"module_{slugify(canonical)}_main",
            f"Module view: {canonical}",
            step + 1,
            content_ready=True,
            fast_e2e=True,
            module_name=module_name,
            description=description,
        )
        if main and not main.get("rejected"):
            shots.append(main)
            step = main["step"]
        if not single_shot_mode() and await on_channel_page(page, module_name, description):
            section_shots, step = await capture_scroll_sections(
                page,
                out_dir,
                slugify(canonical),
                step,
                canonical,
            )
            shots.extend(section_shots)

    if not filter_good_module_shots(shots):
        await run_pre_capture_heal_loop(page, module_name, description, canonical)
        main = await save_shot(
            page,
            out_dir,
            f"module_{slugify(canonical)}_healed",
            f"Module view: {canonical} (healed)",
            step + 1,
            content_ready=True,
            fast_e2e=True,
            module_name=module_name,
            description=description,
        )
        if main and not main.get("rejected"):
            shots.append(main)

    module_shots = filter_good_module_shots(shots)
    return await _finalize_bundle(
        page,
        await finish_capture_bundle(page, out_dir, canonical or module_name, module_shots),
        module_name=module_name,
        description=description,
    )


async def _capture_add_order_fast(
    page: Page,
    out_dir: Path,
    module_name: str,
    description: str,
    canonical: str,
) -> dict[str, list]:
    shots: list[dict] = []
    step = 0

    await navigate_to_add_order_form(page, module_name, description)
    if not await page_ready_for_module_shot(page, module_name, description) and docs_capture_use_nav_map():
        await navigate_module_via_nav_map(page, module_name, description, max_pages=4)
        await dismiss_blocking_overlays(page)

    if await page_ready_for_module_shot(page, module_name, description):
        await dismiss_blocking_overlays(page)
        await _pause(DOCS_CAPTURE_POST_NAV_WAIT_S)
        await wait_for_module_content(page, timeout_s=12.0 if docs_fast() else 20.0)
        main = await save_shot(
            page,
            out_dir,
            f"module_{slugify(canonical)}_add_order",
            f"Add Order form — overview",
            step + 1,
            content_ready=True,
            fast_e2e=True,
            module_name=module_name,
            description=description,
        )
        if main and not main.get("rejected"):
            shots.append(main)
            step = main["step"]

        if not single_shot_mode():
            form_specs = [
                ("add_order_buyer", "Add Order — buyer / receiver details", 'text=Buyer', 'text=Receiver', 'text=Phone'),
                ("add_order_product", "Add Order — product & SKU section", 'text=Product', 'text=SKU', 'text=Quantity'),
                ("add_order_shipping", "Add Order — shipping & payment", 'text=Shipping', 'text=Payment', 'text=Create'),
            ]
            for shot_id, label, *anchors in form_specs:
                await dismiss_blocking_overlays(page)
                scrolled = False
                for anchor in anchors:
                    try:
                        text_val = anchor.replace("text=", "")
                        loc = page.get_by_text(re.compile(re.escape(text_val), re.I)).first
                        if await loc.count() > 0 and await loc.is_visible():
                            await loc.scroll_into_view_if_needed(timeout=3000)
                            await asyncio.sleep(0.5 if docs_fast() else 0.9)
                            scrolled = True
                            break
                    except Exception:
                        continue
                if not scrolled:
                    try:
                        await page.evaluate("(i) => window.scrollTo({ top: 320 * i, behavior: 'instant' })", len(shots))
                        await asyncio.sleep(0.5)
                    except Exception:
                        pass
                extra = await save_shot(
                    page,
                    out_dir,
                    shot_id,
                    label,
                    step + 1,
                    content_ready=True,
                    fast_e2e=True,
                    module_name=module_name,
                    description=description,
                )
                if extra and not extra.get("rejected"):
                    shots.append(extra)
                    step = extra["step"]

    if not filter_good_module_shots(shots):
        await navigate_to_add_order_form(page, module_name, description)
        await dismiss_blocking_overlays(page)
        healed = await save_shot(
            page,
            out_dir,
            f"module_{slugify(canonical)}_healed",
            f"Add Order form (retry)",
            step + 1,
            content_ready=True,
            fast_e2e=True,
            module_name=module_name,
            description=description,
        )
        if healed and not healed.get("rejected"):
            shots.append(healed)

    module_shots = filter_good_module_shots(shots)
    return await _finalize_bundle(
        page,
        await finish_capture_bundle(page, out_dir, canonical or module_name, module_shots, description=description),
        module_name=module_name,
        description=description,
    )


async def _capture_new_orders_fast(
    page: Page,
    out_dir: Path,
    module_name: str,
    description: str,
    canonical: str,
) -> dict[str, list]:
    shots: list[dict] = []
    step = 0
    origin = await panel_origin(page)

    await goto_new_orders_domestic(page, origin)
    await dismiss_blocking_overlays(page)
    await _pause(DOCS_CAPTURE_POST_NAV_WAIT_S)
    await wait_for_module_content(page, timeout_s=12.0 if docs_fast() else 20.0)

    if await page_ready_for_module_shot(page, module_name, description):
        main = await save_shot(
            page,
            out_dir,
            f"module_{slugify(canonical)}_list",
            "New Orders list — overview",
            step + 1,
            content_ready=True,
            fast_e2e=True,
            module_name=module_name,
            description=description,
        )
        if main and not main.get("rejected"):
            shots.append(main)
            step = main["step"]

        if not single_shot_mode():
            for shot_id, label, scroll_y in (
                ("new_orders_filters", "New Orders — filters & tabs", 0),
                ("new_orders_table", "New Orders — order table", 450),
            ):
                await dismiss_blocking_overlays(page)
                try:
                    await page.evaluate("(y) => window.scrollTo({ top: y, behavior: 'instant' })", scroll_y)
                    await asyncio.sleep(0.6 if docs_fast() else 1.0)
                except Exception:
                    pass
                extra = await save_shot(
                    page,
                    out_dir,
                    shot_id,
                    label,
                    step + 1,
                    content_ready=True,
                    fast_e2e=True,
                    module_name=module_name,
                    description=description,
                )
                if extra and not extra.get("rejected"):
                    shots.append(extra)
                    step = extra["step"]

    if not filter_good_module_shots(shots):
        quick = await navigate_module_via_quick_search(page, module_name, description)
        if quick.get("ok"):
            await dismiss_blocking_overlays(page)
            healed = await save_shot(
                page,
                out_dir,
                f"module_{slugify(canonical)}_healed",
                "New Orders list (retry)",
                step + 1,
                content_ready=True,
                fast_e2e=True,
                module_name=module_name,
                description=description,
            )
            if healed and not healed.get("rejected"):
                shots.append(healed)

    module_shots = filter_good_module_shots(shots)
    return await _finalize_bundle(
        page,
        await finish_capture_bundle(page, out_dir, canonical or module_name, module_shots, description=description),
        module_name=module_name,
        description=description,
    )


async def _capture_module_general_fast(
    page: Page,
    out_dir: Path,
    module_name: str,
    description: str,
    canonical: str,
) -> dict[str, list]:
    shots: list[dict] = []
    step = 0
    await run_pre_capture_heal_loop(page, module_name, description, canonical)
    if not await page_ready_for_module_shot(page, module_name, description) and docs_capture_use_nav_map():
        await navigate_module_via_nav_map(page, module_name, description, max_pages=4)
        await run_pre_capture_heal_loop(page, module_name, description, canonical)
    if await page_ready_for_module_shot(page, module_name, description):
        shot = await save_shot(
            page,
            out_dir,
            f"module_{slugify(canonical)}_quick_search",
            f"Module view: {canonical} (quick search)",
            step + 1,
            content_ready=True,
            fast_e2e=True,
            module_name=module_name,
            description=description,
        )
        if shot and not shot.get("rejected"):
            shots.append(shot)
            step += 1
            if single_shot_mode():
                module_shots = filter_good_module_shots(shots)
                return await _finalize_bundle(
                    page,
                    await finish_capture_bundle(page, out_dir, canonical or module_name, module_shots),
                    module_name=module_name,
                    description=description,
                )
    if len(filter_good_module_shots(shots)) < 2 and not single_shot_mode() and allow_direct_urls() and await try_direct_urls(page, module_name, description):
        shot = await save_shot(
            page,
            out_dir,
            f"module_{slugify(canonical)}_direct",
            f"Module view: {canonical}",
            step + 1,
            content_ready=True,
            fast_e2e=True,
            module_name=module_name,
            description=description,
        )
        if shot and not shot.get("rejected"):
            shots.append(shot)
    if not filter_good_module_shots(shots):
        await run_pre_capture_heal_loop(page, module_name, description, canonical)
        shot = await save_shot(
            page,
            out_dir,
            f"module_{slugify(canonical)}_healed",
            f"Module view: {canonical} (healed)",
            step + 1,
            content_ready=True,
            fast_e2e=True,
            module_name=module_name,
            description=description,
        )
        if shot and not shot.get("rejected"):
            shots.append(shot)
    module_shots = filter_good_module_shots(shots)
    return await _finalize_bundle(
        page,
        await finish_capture_bundle(page, out_dir, canonical or module_name, module_shots),
        module_name=module_name,
        description=description,
    )


async def capture_module(
    session_id: str, module_name: str, out_dir: Path, description: str = ""
) -> dict[str, list]:
    global _capture_context
    out_dir.mkdir(parents=True, exist_ok=True)
    shots: list[dict] = []
    p = browser = context = page = None
    step = 0
    canonical = resolve_doc_module(module_name, description)
    rate_calc = is_rate_calculator_target(module_name, description)

    try:
        email, _pwd = panel_credentials()
        capture_log(
            f"start session={session_id} module={module_name!r} canonical={canonical!r} "
            f"fast={docs_fast()} budget={DOCS_CAPTURE_BUDGET_S}s render={_ON_RENDER} email={email}"
        )
        capture_log("opening browser + login…")
        p, browser, context, page = await async_login_and_save_state()
        _capture_context = context
        capture_log(
            f"login ok url={page.url} video={'on' if _record_video_enabled() else 'off'} "
            f"walkthrough={DOCS_VIDEO_WALKTHROUGH_S}s"
        )
        post_login_url = (page.url or "").lower()
        if "profile" in post_login_url or "onboarding" in post_login_url:
            origin = await panel_origin(page)
            target = f"{origin}/orders/new"
            capture_log(f"post-login interstitial — goto {target}")
            try:
                await page.goto(target, wait_until="domcontentloaded", timeout=_nav_timeout_ms())
                await dismiss_blocking_overlays(page)
                capture_log(f"after interstitial skip url={page.url}")
            except Exception as exc:
                capture_log(f"post-login goto failed: {exc}")
        await dismiss_blocking_overlays(page)

        heal_plan = load_heal_plan_from_env()
        if heal_plan:
            heal_result = await apply_capture_heal_plan(
                page, heal_plan, module_name=module_name, description=description
            )
            if heal_result.get("ok"):
                await _pause(1.0)

        if DOCS_CAPTURE_OBSERVE_ONLY:
            if not heal_plan:
                await navigate_module_via_quick_search(page, module_name, description)
            loop = await run_pre_capture_heal_loop(page, module_name, description, canonical)
            return {
                "shots": [],
                "videos": [],
                "pageState": loop.get("observation"),
                "observeOnly": True,
                "moduleVerified": loop.get("ok"),
            }

        if rate_calc:
            capture_log("capture path: rate_calculator")
            if not await page_ready_for_module_shot(page, module_name, description):
                capture_log("pre-navigate to Rate Calculator")
                await dismiss_blocking_overlays(page)
                nav_ok = await navigate_to_rate_calculator(page)
                capture_log(f"navigate_to_rate_calculator -> {nav_ok} url={page.url}")
                if not nav_ok:
                    await quick_search_to_rate_calculator(page)
            loop = await run_pre_capture_heal_loop(page, module_name, description, canonical)
            if not loop.get("ok"):
                await dismiss_blocking_overlays(page)
                await heal_rate_calculator_nav(page, force=True)
                await goto_rate_calculator_immediately(page)
                await run_pre_capture_heal_loop(page, module_name, description, canonical)
            rate_shots = await capture_rate_calculator_screenshots(
                page, out_dir, canonical or module_name, step, module_name, description
            )
            if not filter_good_module_shots(rate_shots) and docs_capture_heal_enabled():
                await heal_rate_calculator_nav(page, force=True)
                await run_pre_capture_heal_loop(page, module_name, description, canonical)
                rate_shots = await capture_rate_calculator_screenshots(
                    page, out_dir, canonical or module_name, step, module_name, description
                )
            return await _finalize_bundle(
                page,
                await finish_capture_bundle(
                    page, out_dir, canonical or module_name, filter_good_module_shots(rate_shots)
                ),
                module_name=module_name,
                description=description,
            )

        if docs_fast():
            if is_channel_target(module_name, description):
                capture_log("capture path: channel_fast")
                return await _capture_channel_fast(
                    page, out_dir, module_name, description, canonical
                )
            if is_new_orders_target(module_name, description):
                capture_log("capture path: new_orders_fast")
                return await _capture_new_orders_fast(
                    page, out_dir, module_name, description, canonical
                )
            if is_add_order_target(module_name, description):
                capture_log("capture path: add_order_fast")
                return await _capture_add_order_fast(
                    page, out_dir, module_name, description, canonical
                )
            capture_log("capture path: module_general_fast")
            return await _capture_module_general_fast(
                page, out_dir, module_name, description, canonical
            )

        if is_channel_target(module_name, description):
            staged = await navigate_channel_to_target(page, module_name, description)
            if not staged.get("ok") and not await channel_page_usable(page, module_name, description):
                await heal_channel_nav(page, module_name, description)
            if not await channel_page_usable(page, module_name, description) and allow_direct_urls():
                await try_direct_urls(page, module_name, description)

            if await channel_page_usable(page, module_name, description):
                step += 1
                main = await save_shot(
                    page,
                    out_dir,
                    f"module_{slugify(canonical)}_main",
                    f"Module view: {canonical}",
                    step,
                    content_ready=False,
                )
                if main:
                    shots.append(main)
                    step = main["step"]
                section_shots, step = await capture_scroll_sections(
                    page,
                    out_dir,
                    slugify(canonical),
                    step,
                    canonical,
                )
                shots.extend(section_shots)

            module_shots = [s for s in shots if not is_login_dashboard_shot(s)]
            if module_shots:
                return await _finalize_bundle(
                    page,
                    await finish_capture_bundle(page, out_dir, canonical or module_name, module_shots),
                )

        if is_dashboard_module(module_name):
            step += 1
            login_shot = await save_shot(
                page, out_dir, "dashboard_after_login", "Navigation: sidebar after login", step
            )
            if login_shot:
                shots.append(login_shot)
            extra, step = await capture_dashboard_all_pages(page, out_dir, step)
            shots.extend(extra)
            return await _finalize_bundle(
                page, await finish_capture_bundle(page, out_dir, module_name, shots)
            )

        quick = await navigate_module_via_quick_search(page, module_name, description)
        if quick.get("ok"):
            shot = await save_shot(
                page,
                out_dir,
                f"module_{slugify(canonical)}_quick_search",
                f"Module view: {canonical} (quick search)",
                step + 1,
                content_ready=True,
            )
            if shot:
                shots.append(shot)
                step += 1

        if allow_direct_urls() and await try_direct_urls(page, module_name, description):
            shot = await save_shot(
                page,
                out_dir,
                f"module_{slugify(canonical)}_direct",
                f"Module view: {canonical}",
                step + 1,
                content_ready=True,
                require_rate_calculator=rate_calc,
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
            opened = await open_module_self_heal(page, canonical, description)
            await asyncio.sleep(2)
            shot = await save_shot(
                page,
                out_dir,
                "module_main_view",
                f"Module view: {canonical}" + (" (nav opened)" if opened else ""),
                step + 1,
                content_ready=opened,
                require_rate_calculator=rate_calc,
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

        if not module_shots:
            step += 1
            login_shot = await save_shot(
                page, out_dir, "dashboard_after_login", "Navigation: sidebar after login", step
            )
            if login_shot:
                shots.append(login_shot)
            return await _finalize_bundle(
                page, await finish_capture_bundle(page, out_dir, module_name, shots)
            )

        module_only = [s for s in shots if not is_login_dashboard_shot(s)]
        if is_channel_target(module_name, description) or is_rate_calculator_target(
            module_name, description
        ):
            return await _finalize_bundle(
                page, await finish_capture_bundle(page, out_dir, canonical or module_name, module_only)
            )
        return await _finalize_bundle(
            page,
            await finish_capture_bundle(page, out_dir, canonical or module_name, module_only or shots),
        )
    finally:
        _capture_context = None
        if context:
            try:
                await context.close()
            except Exception:
                pass
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
    capture_log(f"main argv session={session_id} module={module_name!r} desc_len={len(description)}")

    try:
        capture_coro = capture_module(session_id, module_name, out_dir, description)
        if docs_fast():
            grace = 30.0 if _ON_RENDER else 0.0
            bundle = await asyncio.wait_for(capture_coro, timeout=DOCS_CAPTURE_BUDGET_S + grace)
        else:
            bundle = await capture_coro
        shots = bundle.get("shots") or []
        videos = bundle.get("videos") or []
        good_shots = filter_good_module_shots(shots)
        observe_only = bool(bundle.get("observeOnly"))
        module_verified = bundle.get("moduleVerified") or bundle.get("pageState", {}).get(
            "moduleVerified"
        )
        capture_ok = bool(good_shots) or bool(videos) or (observe_only and module_verified)
        page_state = bundle.get("pageState") or {}
        if not capture_ok:
            for s in shots:
                if s.get("rejected"):
                    capture_log(
                        f"rejected shot id={s.get('id')} reason={s.get('rejectReason')} url={s.get('url')}"
                    )
            capture_log(
                f"capture failed: good={len(good_shots)} total={len(shots)} "
                f"verified={module_verified} url={page_state.get('url')} "
                f"preview={(page_state.get('pageTextPreview') or '')[:120]!r}"
            )
        else:
            capture_log(
                f"capture ok: good={len(good_shots)} videos={len(videos)} "
                f"rejected={len(shots) - len(good_shots)}"
            )
        err_detail = None
        if not capture_ok:
            verify_reason = page_state.get("verifyReason") or page_state.get("agentHints")
            err_detail = "No module screenshots captured (404/login/wrong page)"
            if page_state.get("onLogin"):
                err_detail += " — still on login page"
            elif page_state.get("is404"):
                err_detail += " — 404/not found"
            elif verify_reason:
                err_detail += f" — {verify_reason}"
        print(
            json.dumps(
                {
                    "ok": capture_ok,
                    "session_id": session_id,
                    "module_name": module_name,
                    "headless": HEADLESS,
                    "fast": docs_fast(),
                    "screenshots": good_shots,
                    "rejectedShots": len(shots) - len(good_shots),
                    "videos": videos,
                    "pageState": page_state,
                    "observeOnly": observe_only,
                    "moduleVerified": module_verified,
                    "error": err_detail,
                }
            )
        )
    except asyncio.TimeoutError:
        limit = DOCS_CAPTURE_BUDGET_S + (90.0 if _ON_RENDER else 0.0)
        capture_log(f"capture timed out after {limit:.0f}s")
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": f"Capture timed out after {limit:.0f}s",
                    "screenshots": [],
                    "videos": [],
                    "fast": docs_fast(),
                }
            )
        )
        sys.exit(1)
    except Exception as e:
        capture_log(f"capture exception: {e}")
        print(json.dumps({"ok": False, "error": str(e), "screenshots": [], "videos": []}))
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
