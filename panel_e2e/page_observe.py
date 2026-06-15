"""Capture live page state for OpenAI screenshot self-heal."""

from __future__ import annotations

from playwright.async_api import Page

from panel_doc_module import is_channel_target, is_rate_calculator_target, resolve_doc_module
from panel_e2e.channel_pages import channel_page_usable, on_channel_hub_page
from panel_e2e.docs_capture_heal import verify_module_target
from panel_e2e.rate_calculator import _on_rate_calculator_page
from panel_page_state import page_is_broken_for_e2e, page_looks_like_not_found, url_looks_like_broken_nav

_CONSOLE_LOG_CAP = 20


def attach_console_collector(page: Page) -> list[str]:
    """Listen for browser console errors/warnings during the heal tick."""
    logs: list[str] = []

    def _on_console(msg) -> None:
        try:
            if msg.type not in ("error", "warning"):
                return
            text = (msg.text or "").strip()
            if not text:
                return
            logs.append(f"[{msg.type}] {text[:500]}")
            if len(logs) > _CONSOLE_LOG_CAP:
                del logs[0]
        except Exception:
            pass

    page.on("console", _on_console)
    return logs


async def _module_verified(
    page: Page, module_name: str = "", description: str = ""
) -> bool | None:
    if not module_name:
        return None
    ok, _reason = await verify_module_target(page, module_name, description)
    return ok


async def capture_page_observation(
    page: Page,
    console_logs: list[str] | None = None,
    *,
    module_name: str = "",
    description: str = "",
) -> dict:
    title = ""
    url = ""
    text_preview = ""
    visible_actions: list[str] = []

    try:
        title = await page.title() or ""
        url = page.url or ""
    except Exception:
        pass

    try:
        text_preview = await page.evaluate(
            """() => (document.body?.innerText || '')
              .replace(/\\s+/g, ' ')
              .trim()
              .slice(0, 2800)"""
        )
    except Exception:
        text_preview = ""

    try:
        visible_actions = await page.evaluate(
            """() => {
              const out = [];
              const nodes = document.querySelectorAll(
                'a, button, [role="button"], [role="tab"], [role="option"], input[placeholder]'
              );
              for (const el of nodes) {
                if (out.length >= 30) break;
                const t = (el.innerText || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').trim();
                if (!t || t.length > 80) continue;
                if (out.includes(t)) continue;
                out.push(t);
              }
              return out;
            }"""
        )
    except Exception:
        visible_actions = []

    broken, broken_reason = await page_is_broken_for_e2e(page)
    is_404 = await page_looks_like_not_found(page)
    on_rc = await _on_rate_calculator_page(page)
    on_channel = await channel_page_usable(page, module_name, description) if module_name else False
    on_channel_hub = await on_channel_hub_page(page)
    module_verified = await _module_verified(page, module_name, description) if module_name else None
    target = resolve_doc_module(module_name, description) if module_name else ""

    text_low = text_preview.lower()
    on_dashboard = (
        "dashboard" in url.lower()
        or ("analytics" in text_low and "wallet transactions" in text_low and not on_rc)
    )
    on_login = "login" in url.lower() or "sign in" in text_low[:400]

    hints: list[str] = []
    if broken or is_404:
        hints.append("Page looks like 404 or broken route — use Ctrl+B Quick Search, never manage-courier URL")
    if on_login:
        hints.append("Login page — session may have expired; re-login then Ctrl+B")
    if on_dashboard and is_rate_calculator_target(module_name, description):
        hints.append("On dashboard — Ctrl+B → Quick Search → rate calculator (skip Manage Courier)")
    if on_dashboard and is_channel_target(module_name, description):
        hints.append("On dashboard — Ctrl+B → Order Channels → click channel card in-page")
    if on_rc and module_verified:
        hints.append("Already on Rate Calculator — navSteps can be empty or minimal verify only")
    elif on_rc and module_verified is False:
        hints.append("Rate Calculator URL markers matched but pincode/calculate missing — re-navigate via Ctrl+B")
    if on_channel_hub and is_channel_target(module_name, description):
        hints.append("On Order Channels hub — click the channel card (Amazon/Shopify), do not goto /channels/amazon URL")
    if on_channel and is_channel_target(module_name, description):
        hints.append("Channel page verified — minimal navSteps ok")
    if "quick search" in text_low:
        hints.append("Quick Search dialog may already be open")
    if "manage-courier" in url.lower():
        hints.append("manage-courier URL is a 404 trap — use Quick Search to Rate Calculator instead")

    return {
        "url": url,
        "title": title,
        "pageTextPreview": text_preview,
        "visibleActions": visible_actions[:30],
        "is404": is_404,
        "isBrokenRoute": broken,
        "brokenReason": broken_reason or None,
        "onRateCalculator": on_rc,
        "onChannel": on_channel,
        "onChannelHub": on_channel_hub,
        "onDashboard": on_dashboard,
        "onLogin": on_login,
        "moduleVerified": module_verified,
        "targetModule": target or None,
        "agentHints": hints,
        "consoleLogs": list(console_logs or [])[-_CONSOLE_LOG_CAP:],
    }
