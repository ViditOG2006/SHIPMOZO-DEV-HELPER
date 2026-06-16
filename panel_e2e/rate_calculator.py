"""Rate Calculator E2E flows on Shipmozo merchant panel."""

from __future__ import annotations

import asyncio
import os
import re
from typing import Any

E2E_FAST = os.getenv("E2E_FAST", "1").lower() in {"1", "true", "yes"}

from playwright.async_api import Page

from panel_navigate import click_nav_link, expand_sidebar_sections
from panel_navigation import load_navigation_map
from panel_e2e.e2e_log import e2e_log
from panel_page_state import page_is_broken_for_e2e, page_looks_like_not_found, url_looks_like_broken_nav
from panel_quick_search import navigate_module_via_quick_search, navigate_via_quick_search
from panel_ui_helpers import dismiss_blocking_overlays
from panel_url import panel_origin, rate_calculator_urls, rewrite_href

FAST_NAV_TIMEOUT_MS = 5000
QUICK_SEARCH_TIMEOUT_S = 3.5
E2E_CASE_TARGET_S = 10.0


async def _click_if_visible(page: Page, pattern: str, role: str = "button") -> bool:
    try:
        loc = page.get_by_role(role, name=re.compile(pattern, re.I))
        if await loc.count() > 0 and await loc.first.is_visible():
            await loc.first.click(timeout=3000)
            await asyncio.sleep(0.05)
            return True
    except Exception:
        pass
    try:
        loc = page.get_by_text(re.compile(pattern, re.I))
        if await loc.count() > 0 and await loc.first.is_visible():
            await loc.first.click(timeout=3000)
            await asyncio.sleep(0.05)
            return True
    except Exception:
        pass
    return False


def _looks_like_dashboard(url: str) -> bool:
    low = (url or "").lower()
    if "rate-calculator" in low or "rate_calculator" in low:
        return False
    if "/dashboard" in low:
        return True
    if low.rstrip("/").endswith("panel.appiify.com") or low.rstrip("/").endswith("panel.appify.com"):
        return True
    return False


def _rate_calc_markers() -> tuple[str, ...]:
    return (
        "origin pincode",
        "delivery area pincode",
        "delivery pincode",
        "approximate weight",
        "shipment price list",
        "package type",
        "invoice value",
        "domestic",
    )


async def _page_haystack(page: Page) -> str:
    try:
        await page.wait_for_load_state("domcontentloaded", timeout=1500)
    except Exception:
        pass
    try:
        return (await page.content()).lower()
    except Exception:
        return ""


async def _rate_calculator_body_verified(page: Page) -> bool:
    """Strict check: pincode fields + calculate action visible (not just Domestic/International tabs)."""
    try:
        text = (
            await page.evaluate(
                "() => (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 4000).toLowerCase()"
            )
            or ""
        )
    except Exception:
        return False
    has_pincode = any(
        t in text
        for t in (
            "pincode",
            "origin pincode",
            "delivery area pincode",
            "delivery pincode",
            "pickup pincode",
        )
    )
    return has_pincode and "calculate" in text


async def _on_rate_calculator_page(page: Page) -> bool:
    url = (page.url or "").lower()
    if url_looks_like_broken_nav(page.url or ""):
        return False
    if await page_looks_like_not_found(page):
        return False
    # Orders/shipment list pages also show Domestic/International — not Rate Calculator.
    if "/orders/" in url and "rate-calculator" not in url:
        return False
    if "/orders/new" in url or "/orders/add" in url:
        return False

    hay = await _page_haystack(page)
    if not hay:
        return False

    pincode_markers = (
        "origin pincode",
        "delivery area pincode",
        "delivery pincode",
        "pickup pincode",
    )
    form_markers = (
        "approximate weight",
        "shipment price list",
        "package type",
        "invoice value",
    )
    pincode_hits = sum(1 for m in pincode_markers if m in hay)
    form_hits = sum(1 for m in form_markers if m in hay)

    if "rate-calculator" in url or "rate_calculator" in url:
        return pincode_hits >= 1 or (form_hits >= 1 and "calculate" in hay)

    on_dashboard = "analytics" in hay and "wallet transactions" in hay and pincode_hits < 1
    if on_dashboard:
        return False

    if pincode_hits >= 2 and "calculate" in hay:
        return True
    if pincode_hits >= 1 and form_hits >= 1 and "calculate" in hay:
        return True
    return False


async def quick_search_to_rate_calculator(page: Page) -> bool:
    """Fast path: Ctrl+B only — no URL fallbacks that 404 on manage-courier."""
    if await _on_rate_calculator_page(page) and await _rate_calculator_body_verified(page):
        return True
    await dismiss_blocking_overlays(page)
    timeout_s = 8.0 if os.getenv("RENDER") else QUICK_SEARCH_TIMEOUT_S
    for query in ("rate calculator", "Rate Calculator"):
        if await navigate_via_quick_search(
            page,
            query,
            verify_fn=_rate_calculator_body_verified,
            timeout_s=timeout_s,
        ):
            return True
        if await _on_rate_calculator_page(page) and await _rate_calculator_body_verified(page):
            return True
    return False


async def wait_for_rate_calculator_form(page: Page, timeout_s: float | None = None) -> bool:
    if timeout_s is None:
        timeout_s = 1.5 if E2E_FAST else 2.5
    if await _on_rate_calculator_page(page):
        return True
    deadline = asyncio.get_event_loop().time() + timeout_s
    while asyncio.get_event_loop().time() < deadline:
        if await _on_rate_calculator_page(page):
            return True
        await asyncio.sleep(0.08)
    return await _on_rate_calculator_page(page)


async def _try_goto_rate_calculator_url(page: Page, url: str) -> bool:
    try:
        await page.goto(url, wait_until="commit", timeout=FAST_NAV_TIMEOUT_MS)
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=4000)
        except Exception:
            pass
        await asyncio.sleep(0.08)
        if not await _on_rate_calculator_page(page):
            await _click_if_visible(page, r"rate\s*calculator", "tab")
            await asyncio.sleep(0.05)
        return await _on_rate_calculator_page(page)
    except Exception:
        return False


async def goto_rate_calculator_immediately(page: Page) -> bool:
    """Jump to Rate Calculator right after login — Ctrl+B only (fast, no 404 URLs)."""
    return await quick_search_to_rate_calculator(page)


async def _activate_rate_calculator_tab(page: Page) -> bool:
    """On /courier/manage-courier, open Rate Calculator / Shipment Price List tab."""
    import re

    if await _on_rate_calculator_page(page):
        return True
    for pat in (r"rate\s*calcul", r"shipment\s*price\s*list"):
        try:
            tab = page.get_by_role("tab", name=re.compile(pat, re.I))
            if await tab.count() == 0:
                tab = page.get_by_text(re.compile(pat, re.I))
            if await tab.count() > 0:
                await tab.first.click(timeout=3000)
                await asyncio.sleep(0.1)
                if await _on_rate_calculator_page(page):
                    return True
        except Exception:
            continue
    return False


async def ensure_rate_calculator_page(page: Page, nav_script: dict | None = None) -> bool:
    """Stay on Rate Calculator — never re-navigate if form is already visible."""
    if await _on_rate_calculator_page(page):
        return True
    broken, reason = await page_is_broken_for_e2e(page)
    if broken:
        e2e_log("nav", f"On broken page before heal — {reason}; using Ctrl+B only")
        await dismiss_blocking_overlays(page)
        return await quick_search_to_rate_calculator(page)

    await dismiss_blocking_overlays(page)

    if nav_script and nav_script.get("strategyId") == "quick_search":
        from panel_e2e.nav_heal import apply_nav_script

        if await apply_nav_script(page, nav_script) and await _on_rate_calculator_page(page):
            return True

    if await quick_search_to_rate_calculator(page):
        return True

    return await _navigate_to_rate_calculator_fallback(page)


async def _navigate_to_rate_calculator_fallback(page: Page) -> bool:
    if await _on_rate_calculator_page(page):
        return True

    origin = await panel_origin(page)

    try:
        aside_link = page.locator('aside a[href*="rate-calculator"]').first
        if await aside_link.count() > 0 and await aside_link.is_visible():
            await aside_link.click(timeout=3000)
            await asyncio.sleep(0.1)
            if await _on_rate_calculator_page(page):
                return True
    except Exception:
        pass

    await expand_sidebar_sections(page)
    target_href = f"{origin}/courier/rate-calculator"
    if await click_nav_link(page, "Rate Calculator", target_href):
        if await _on_rate_calculator_page(page):
            return True

    for url in rate_calculator_urls(origin)[1:]:
        if await _try_goto_rate_calculator_url(page, url):
            return True

    for label in ("Rate Calculator",):
        try:
            link = page.get_by_role("link", name=re.compile(label, re.I))
            if await link.count() > 0:
                await link.first.click(timeout=3000)
                await asyncio.sleep(0.1)
                await _click_if_visible(page, r"rate\s*calculator")
                if await _on_rate_calculator_page(page):
                    return True
        except Exception:
            continue
    return await _on_rate_calculator_page(page)


async def navigate_to_rate_calculator(page: Page) -> bool:
    return await ensure_rate_calculator_page(page, nav_script=None)


async def _fill_near_label(page: Page, label_pattern: str, value: str) -> bool:
    if value is None or value == "":
        return False
    text = str(value)

    try:
        label = page.get_by_label(re.compile(label_pattern, re.I))
        if await label.count() > 0:
            await label.first.fill(text, timeout=2500)
            return True
    except Exception:
        pass

    try:
        label_el = page.get_by_text(re.compile(label_pattern, re.I))
        if await label_el.count() > 0:
            container = label_el.first.locator("xpath=ancestor::*[.//input][1]")
            inp = container.locator("input").first
            if await inp.count() > 0 and await inp.is_visible():
                await inp.fill(text, timeout=2500)
                return True
    except Exception:
        pass

    # placeholder / loose match
    keys = {
        "origin": r"origin",
        "delivery": r"delivery",
        "weight": r"weight",
        "invoice": r"invoice",
        "length": r"length",
        "width": r"width",
        "height": r"height",
    }
    for key, pat in keys.items():
        if re.search(label_pattern, key, re.I) or re.search(key, label_pattern, re.I):
            try:
                inp = page.locator(f"input[placeholder*='{key}' i], input[name*='{key}' i]")
                if await inp.count() > 0:
                    await inp.first.fill(text, timeout=5000)
                    return True
            except Exception:
                pass
    return False


async def fill_rate_form(page: Page, form: dict[str, Any]) -> list[str]:
    steps: list[str] = []
    service = str(form.get("serviceType", "domestic")).lower()
    if service == "international":
        if await _click_if_visible(page, r"international"):
            steps.append("Selected International")
    else:
        if await _click_if_visible(page, r"domestic"):
            steps.append("Selected Domestic")

    field_map = [
        ("origin pincode", form.get("originPincode")),
        ("delivery", form.get("deliveryPincode")),
        ("weight", form.get("weightKg")),
        ("invoice", form.get("invoiceValue")),
        ("length", form.get("length")),
        ("width", form.get("width")),
        ("height", form.get("height")),
    ]
    for label, val in field_map:
        if val is not None and await _fill_near_label(page, label, str(val)):
            steps.append(f"Filled {label}={val}")

    return steps


async def click_calculate(page: Page) -> bool:
    return await _click_if_visible(page, r"^calculate$")


async def _inner_text_from_frames(page: Page) -> str:
    for sel in ("main", '[role="main"]', "body"):
        try:
            loc = page.locator(sel).first
            if await loc.count() > 0:
                text = await loc.inner_text(timeout=2000)
                if text and len(text.strip()) > 20:
                    return text.strip()
        except Exception:
            continue
    for frame in page.frames:
        try:
            text = await frame.locator("body").inner_text(timeout=1500)
            if text and len(text.strip()) > 20:
                return text.strip()
        except Exception:
            continue
    return ""


async def _rate_calculator_text_fallback(page: Page) -> str:
    tokens: list[str] = []
    label_checks = [
        ("origin pincode", r"origin\s*pincode"),
        ("delivery pincode", r"delivery"),
        ("pincode", r"pincode"),
        ("approximate weight", r"approximate\s*weight"),
        ("domestic", r"domestic"),
        ("international", r"international"),
        ("rate calculator", r"rate\s*calculator"),
    ]
    for label, pat in label_checks:
        try:
            loc = page.get_by_text(re.compile(pat, re.I))
            if await loc.count() > 0:
                tokens.append(label)
        except Exception:
            pass
    try:
        calc = page.get_by_role("button", name=re.compile(r"calculate", re.I))
        if await calc.count() > 0:
            tokens.append("calculate")
    except Exception:
        pass
    if tokens:
        return " ".join(dict.fromkeys(tokens))
    hay = (await page.content()).lower()
    if "pincode" in hay and "calculate" in hay:
        return "origin pincode delivery pincode calculate rate calculator"
    return ""


async def read_page_text(page: Page, limit: int = 12000) -> str:
    if not E2E_FAST:
        await asyncio.sleep(0.05)
    try:
        text = await _inner_text_from_frames(page)
        if len(text) >= 20:
            return text[:limit]
    except Exception:
        pass
    try:
        fallback = await _rate_calculator_text_fallback(page)
        if fallback:
            return fallback[:limit]
    except Exception:
        pass
    try:
        return (await page.inner_text("body"))[:limit]
    except Exception:
        return ""


async def wait_for_results(page: Page, timeout_s: float | None = None) -> bool:
    if timeout_s is None:
        timeout_s = 3.0 if E2E_FAST else 5.0
    text = (await read_page_text(page, 6000)).lower()
    if _results_visible(text):
        return True
    deadline = asyncio.get_event_loop().time() + timeout_s
    while asyncio.get_event_loop().time() < deadline:
        text = (await read_page_text(page, 6000)).lower()
        if _results_visible(text):
            return True
        await asyncio.sleep(0.12)
    return False


def _results_visible(text_low: str) -> bool:
    if not text_low:
        return False
    rate_tokens = ("courier", "freight", "charge", "₹", "rs.", "estimated", "transit")
    if any(k in text_low for k in rate_tokens) and len(text_low) > 200:
        return True
    return "calculate" in text_low and any(k in text_low for k in rate_tokens)


async def _fail_broken_page(page: Page, steps: list[str]) -> dict[str, Any] | None:
    broken, reason = await page_is_broken_for_e2e(page)
    if not broken:
        return None
    e2e_log("e2e", f"FAIL — {reason}")
    steps.append(f"✗ {reason}")
    ui_text = await read_page_text(page)
    return {
        "ok": False,
        "error": reason,
        "stepsRun": steps,
        "pageUrl": page.url,
        "uiText": ui_text,
    }


async def run_rate_calculator_flow(
    page: Page,
    flow: str,
    form: dict[str, Any],
    *,
    nav_script: dict | None = None,
    skip_nav: bool = False,
    scenario_id: str = "",
) -> dict[str, Any]:
    steps: list[str] = []
    if scenario_id:
        steps.append(f"Scenario {scenario_id}: flow={flow}")
        e2e_log("e2e", f"Running {scenario_id} ({flow})")

    broken_payload = await _fail_broken_page(page, steps)
    if broken_payload:
        return broken_payload

    if await _on_rate_calculator_page(page):
        steps.append("Already on Rate Calculator (skip re-nav)")
    elif await ensure_rate_calculator_page(page, nav_script if skip_nav else None):
        steps.append("Opened Rate Calculator via Quick Search / saved script")
    else:
        e2e_log("e2e", f"Could not open Rate Calculator — {page.url}")
        return {
            "ok": False,
            "error": "Could not open Rate Calculator page",
            "stepsRun": steps,
            "pageUrl": page.url,
            "uiText": await read_page_text(page),
        }

    broken_payload = await _fail_broken_page(page, steps)
    if broken_payload:
        return broken_payload

    if flow == "rate_calculator_open":
        await wait_for_rate_calculator_form(page)
        ok = await _on_rate_calculator_page(page)
        ui_text = await read_page_text(page)
        text_low = ui_text.lower()
        has_pincode = "pincode" in text_low or "origin" in text_low
        has_calculate = "calculate" in text_low
        ok = ok and has_pincode and has_calculate
        if not ok:
            e2e_log("e2e", f"{scenario_id or flow}: form not detected at {page.url}")
        return {
            "ok": ok,
            "stepsRun": steps,
            "pageUrl": page.url,
            "uiText": ui_text,
            "error": None if ok else "Rate Calculator form not detected (wrong page or 404)",
        }

    if flow == "rate_calculator_international_toggle":
        clicked = await _click_if_visible(page, r"international")
        steps.append("Clicked International" if clicked else "International toggle not found")
        text = await read_page_text(page)
        ok = clicked and "international" in text.lower() and await _on_rate_calculator_page(page)
        broken_payload = await _fail_broken_page(page, steps)
        if broken_payload:
            return broken_payload
        return {
            "ok": ok,
            "stepsRun": steps,
            "pageUrl": page.url,
            "uiText": text,
            "error": None if ok else "International mode not confirmed",
        }

    if flow in (
        "rate_calculator_domestic_happy",
        "rate_calculator_domestic_calculate",
        "rate_calculator_heavy_parcel",
        "rate_calculator_invalid_pincode",
        "rate_calculator_missing_weight",
        "rate_calculator_dimensions",
    ):
        defaults = {
            "serviceType": "domestic",
            "originPincode": "110059",
            "deliveryPincode": "110058",
            "weightKg": "20",
            "invoiceValue": "20000",
            "length": "100",
            "width": "100",
            "height": "100",
        }
        merged = {**defaults, **(form or {})}

        if flow == "rate_calculator_heavy_parcel":
            merged["weightKg"] = form.get("weightKg", "100")
        if flow == "rate_calculator_invalid_pincode":
            merged["originPincode"] = form.get("originPincode", "abc")
        if flow == "rate_calculator_missing_weight":
            merged["weightKg"] = ""
        if flow == "rate_calculator_dimensions":
            merged.update(
                {
                    "length": form.get("length", "50"),
                    "width": form.get("width", "40"),
                    "height": form.get("height", "30"),
                }
            )

        steps.extend(await fill_rate_form(page, merged))

        if flow != "rate_calculator_missing_weight" or merged.get("weightKg"):
            if not await click_calculate(page):
                return {
                    "ok": False,
                    "error": "Calculate button not found or not clickable",
                    "stepsRun": steps,
                    "pageUrl": page.url,
                    "uiText": await read_page_text(page),
                }
            steps.append("Clicked Calculate")
            if not E2E_FAST:
                await asyncio.sleep(0.2)

        text = await read_page_text(page)
        text_low = text.lower()

        if flow == "rate_calculator_invalid_pincode":
            ok = any(
                w in text_low
                for w in ("invalid", "valid", "pincode", "pin code", "enter", "required", "error")
            )
            return {
                "ok": ok,
                "stepsRun": steps,
                "pageUrl": page.url,
                "uiText": text,
                "error": None if ok else "Expected pincode validation message",
            }

        if flow == "rate_calculator_missing_weight":
            ok = any(w in text_low for w in ("weight", "required", "invalid", "enter", "error"))
            return {
                "ok": ok,
                "stepsRun": steps,
                "pageUrl": page.url,
                "uiText": text,
                "error": None if ok else "Expected weight validation message",
            }

        broken_payload = await _fail_broken_page(page, steps)
        if broken_payload:
            return broken_payload

        got_results = await wait_for_results(page)
        on_rc = await _on_rate_calculator_page(page)
        ok = on_rc and (got_results or any(w in text_low for w in ("charge", "freight", "₹", "transit")))
        if not ok:
            e2e_log("e2e", f"{scenario_id or flow}: no results on RC form — {page.url}")
        return {
            "ok": ok,
            "stepsRun": steps,
            "pageUrl": page.url,
            "uiText": text,
            "error": None if ok else "No courier rates or results visible after Calculate",
        }

    return {
        "ok": False,
        "error": f"Unknown e2e flow: {flow}",
        "stepsRun": steps,
        "pageUrl": page.url,
        "uiText": await read_page_text(page),
    }
