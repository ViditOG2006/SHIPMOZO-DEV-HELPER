"""Execute OpenRouter-generated navigation / test step scripts."""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from typing import Any

from playwright.async_api import Page

from panel_e2e.e2e_log import e2e_log
from panel_e2e.rate_calculator import _on_rate_calculator_page
from panel_page_state import page_is_broken_for_e2e, url_looks_like_broken_nav
from panel_ui_helpers import dismiss_blocking_overlays

ROOT = Path(__file__).resolve().parent.parent


async def _op_dismiss_overlays(page: Page, _step: dict) -> None:
    await dismiss_blocking_overlays(page)


async def _op_hotkey(page: Page, step: dict) -> None:
    await page.keyboard.press(step.get("keys", "Control+b"))


async def _op_wait(page: Page, step: dict) -> None:
    await asyncio.sleep(max(0, int(step.get("ms", 80))) / 1000.0)


async def _op_fill_placeholder(page: Page, step: dict) -> None:
    ph = step.get("placeholder", "")
    text = step.get("text", "")
    ph_low = ph.lower()
    if "date" in ph_low and "quick" not in ph_low:
        raise RuntimeError(f"Refusing to fill date-like placeholder: {ph}")
    loc = page.get_by_placeholder(re.compile(re.escape(ph), re.I))
    if await loc.count() == 0:
        loc = page.locator(f'input[placeholder*="{ph}" i]')
    if await loc.count() == 0:
        raise RuntimeError(f"Placeholder not found: {ph}")
    target = loc.first
    if not await target.is_visible():
        raise RuntimeError(f"Placeholder not visible (wrong page?): {ph}")
    await target.click(timeout=2000)
    await target.fill(text)


async def _op_fill_label(page: Page, step: dict) -> None:
    label = step.get("label", "")
    text = step.get("text", "")
    loc = page.get_by_label(re.compile(re.escape(label), re.I))
    await loc.first.fill(text, timeout=2500)


async def _op_click_text(page: Page, step: dict) -> None:
    text = step.get("text", "")
    contains = step.get("contains", "")
    if contains:
        pat = re.compile(rf".*{re.escape(contains)}.*{re.escape(text)}.*", re.I)
        loc = page.get_by_text(pat)
    else:
        loc = page.get_by_text(re.compile(re.escape(text), re.I))
    await loc.first.click(timeout=2500)
    await asyncio.sleep(0.05)


async def _op_click_role(page: Page, step: dict) -> None:
    role = step.get("role", "button")
    name = step.get("name", "")
    loc = page.get_by_role(role, name=re.compile(re.escape(name), re.I))
    await loc.first.click(timeout=2500)
    await asyncio.sleep(0.05)


async def _op_press_key(page: Page, step: dict) -> None:
    await page.keyboard.press(step.get("key", "Enter"))
    await asyncio.sleep(0.08)


async def _op_wait_for_text(page: Page, step: dict) -> None:
    text = step.get("text", "")
    timeout_ms = int(step.get("timeout_ms", 2500))
    deadline = asyncio.get_event_loop().time() + timeout_ms / 1000.0
    pat = re.compile(re.escape(text), re.I)
    while asyncio.get_event_loop().time() < deadline:
        try:
            if await page.get_by_text(pat).count() > 0:
                return
        except Exception:
            pass
        if text.lower() in (await page.content()).lower():
            return
        await asyncio.sleep(0.08)
    raise TimeoutError(f"Text not found: {text}")


OP_HANDLERS = {
    "dismiss_overlays": _op_dismiss_overlays,
    "hotkey": _op_hotkey,
    "wait": _op_wait,
    "fill_placeholder": _op_fill_placeholder,
    "fill_label": _op_fill_label,
    "click_text": _op_click_text,
    "click_role": _op_click_role,
    "press_key": _op_press_key,
    "wait_for_text": _op_wait_for_text,
}


async def execute_nav_script(page: Page, script: dict[str, Any]) -> dict[str, Any]:
    steps_run: list[str] = []
    errors: list[str] = []

    for i, step in enumerate(script.get("navSteps") or [], start=1):
        op = step.get("op")
        handler = OP_HANDLERS.get(op)
        label = f"{i}. {op} {json.dumps({k: v for k, v in step.items() if k != 'op'}, ensure_ascii=False)[:80]}"
        if not handler:
            errors.append(f"Unknown op: {op}")
            steps_run.append(f"✗ {label}")
            continue
        try:
            e2e_log("ai-script", label)
            await handler(page, step)
            if url_looks_like_broken_nav(page.url or ""):
                raise RuntimeError(f"Navigated to broken route: {page.url}")
            steps_run.append(f"✓ {label}")
        except Exception as exc:
            errors.append(f"{op}: {exc}")
            steps_run.append(f"✗ {label} — {exc}")
            break

    verified = await _verify_script(page, script)
    return {
        "ok": verified and not errors,
        "verified": verified,
        "stepsRun": steps_run,
        "errors": errors,
        "pageUrl": page.url,
    }


async def _verify_script(page: Page, script: dict[str, Any]) -> bool:
    broken, reason = await page_is_broken_for_e2e(page)
    if broken:
        e2e_log("ai-script", f"Verify failed — {reason}")
        return False
    if await _on_rate_calculator_page(page):
        return True
    verify = script.get("verifyTexts") or []
    if not verify:
        return False
    hay = (await page.content()).lower()
    hits = sum(1 for t in verify if str(t).lower() in hay)
    ok = hits >= min(2, len(verify))
    if not ok:
        e2e_log("ai-script", f"Verify texts missed ({hits}/{len(verify)}) at {page.url}")
    return ok


def load_ai_script(path: str | Path) -> dict[str, Any] | None:
    p = Path(path)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if data.get("navSteps") else None
    except Exception:
        return None


def save_ai_script_for_replay(script: dict[str, Any], origin: str, page_url: str) -> dict[str, Any]:
    if url_looks_like_broken_nav(page_url):
        raise ValueError(f"Refusing to save nav script for broken route: {page_url}")
    out_path = ROOT / "output" / "runtime" / "e2e-ai-script.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(script, indent=2), encoding="utf-8")

    nav_script = {
        "target": "rate_calculator",
        "strategyId": "ai_script",
        "origin": origin,
        "verifiedAt": __import__("time").time(),
        "pageUrl": page_url,
        "aiScriptPath": str(out_path),
        "rationale": script.get("rationale", ""),
        "navSteps": script.get("navSteps"),
    }
    nav_path = ROOT / "output" / "runtime" / "e2e-nav-rate-calculator.json"
    nav_path.write_text(json.dumps(nav_script, indent=2), encoding="utf-8")
    return nav_script
