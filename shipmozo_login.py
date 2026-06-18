from __future__ import annotations

import asyncio
import json
import os
import re
import time
from pathlib import Path
from typing import Iterable

from playwright.async_api import Error as PlaywrightError
from playwright.async_api import Page
from playwright.async_api import TimeoutError as PlaywrightTimeoutError
from playwright.async_api import async_playwright

from panel_ui_helpers import dismiss_blocking_overlays
from panel_url import default_panel_base, login_urls
from panel_e2e.e2e_log import e2e_log

E2E_FAST = os.getenv("E2E_FAST", "1").lower() in {"1", "true", "yes"}
_ON_RENDER = os.getenv("RENDER", "").lower() in {"true", "1", "yes"} or bool(
    os.getenv("RENDER_EXTERNAL_URL", "").strip()
)

LOGIN_URLS = login_urls()

DASHBOARD_URL_HINT = "/orders/new"
LOGIN_PATH_HINT = "/login"
_default_login_wait = "60" if _ON_RENDER else "30"
LOGIN_WAIT_S = int(os.getenv("LOGIN_WAIT_S", _default_login_wait))
OUTPUT_DIR = Path("output")
OUTPUT_DIR.mkdir(exist_ok=True)
STATE_PATH = OUTPUT_DIR / "shipmozo-state.json"
SCREENSHOT_PATH = OUTPUT_DIR / "shipmozo-dashboard.png"


def panel_credentials() -> tuple[str, str]:
    """Resolve panel login — on Render require explicit env (no local dev defaults)."""
    email = os.getenv("SHIPMOZO_EMAIL", "").strip()
    password = os.getenv("SHIPMOZO_PASSWORD", "").strip()
    if _ON_RENDER:
        if not email or not password:
            raise RuntimeError(
                "SHIPMOZO_EMAIL and SHIPMOZO_PASSWORD must be set in Render Environment "
                "(Dashboard → Environment). Local .env is not used on Render."
            )
        return email, password
    return email or "tech@shipmozo.com", password or "12345678"


HEADLESS = os.getenv("HEADLESS", "false").lower() in {"1", "true", "yes"}

EMAIL_SELECTORS = [
    'input[type="email"]',
    'input[type="tel"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[placeholder*="Email"]',
    'input[placeholder*="email"]',
    'input[placeholder*="phone"]',
    'input[placeholder*="Email or phone"]',
    'input[aria-label*="Email"]',
    'input[aria-label*="phone"]',
    'input[autocomplete="username"]',
]

PASSWORD_SELECTORS = [
    'input[type="password"]',
    'input[name="password"]',
    'input[placeholder*="Password"]',
    'input[placeholder*="password"]',
    'input[aria-label*="Password"]',
    'input[autocomplete="current-password"]',
]


async def first_visible(page: Page, selectors: Iterable[str], timeout: int = 3000):
    for selector in selectors:
        try:
            locator = page.locator(selector).first
            await locator.wait_for(state="visible", timeout=timeout)
            return locator
        except Exception:
            continue
    return None


def _emails_match(a: str, b: str) -> bool:
    return (a or "").strip().lower() == (b or "").strip().lower()


def _state_is_stale() -> bool:
    """Remember-me localStorage without auth cookies cannot skip login."""
    if not STATE_PATH.exists():
        return False
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return True
    cookies = data.get("cookies") or []
    return len(cookies) == 0


def _login_page_urls() -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for base in login_urls():
        for suffix in ("/login", ""):
            url = f"{base.rstrip('/')}{suffix}"
            if url not in seen:
                seen.add(url)
                out.append(url)
    return out


def _is_on_login_page(url: str) -> bool:
    return LOGIN_PATH_HINT in (url or "").lower()


async def is_logged_in(page: Page) -> bool:
    try:
        url = page.url or ""
        low = url.lower()
        if _is_on_login_page(url):
            return False
        if DASHBOARD_URL_HINT in url:
            return True
        if "/profile" in low or "/onboarding" in low:
            return True
        if not E2E_FAST:
            await page.wait_for_load_state("domcontentloaded")
        dashboard_markers = [
            "text=Add Order",
            "text=Shipment Booking",
            "text=Orders",
            "text=New",
            "text=Analytics",
        ]
        for marker in dashboard_markers:
            if await page.locator(marker).count() > 0:
                return True
    except Exception:
        pass
    return False


async def _leave_post_login_interstitials(page: Page) -> None:
    """Skip profile-completion / onboarding after successful auth."""
    low = (page.url or "").lower()
    if "profile" not in low and "onboarding" not in low:
        return
    base = default_panel_base().rstrip("/")
    target = f"{base}/orders/new"
    e2e_log("login", f"leaving interstitial — goto {target}")
    try:
        await page.goto(target, wait_until="domcontentloaded", timeout=45_000 if _ON_RENDER else 20_000)
        await dismiss_blocking_overlays(page)
    except Exception as exc:
        e2e_log("login", f"interstitial skip failed: {exc}")


async def _click_login_button(page: Page) -> None:
    click_timeout = 15_000 if _ON_RENDER else 5_000
    button_candidates = [
        page.get_by_role("button", name=re.compile(r"^log\s*in$", re.I)),
        page.get_by_role("button", name=re.compile(r"^sign\s*in$", re.I)),
        page.get_by_role("button", name="Log In"),
        page.get_by_role("button", name="Sign In"),
        page.get_by_role("button", name="Login"),
        page.locator('button[type="submit"]'),
        page.locator('input[type="submit"]'),
        page.locator("button").filter(has_text=re.compile(r"log\s*in", re.I)),
        page.locator("button").filter(has_text=re.compile(r"sign\s*in", re.I)),
    ]
    for candidate in button_candidates:
        try:
            if await candidate.count() > 0:
                target = candidate.first
                await target.wait_for(state="visible", timeout=3000)
                await target.click(timeout=click_timeout)
                return
        except Exception:
            continue
    raise RuntimeError("Login button not found")


async def _submit_login_form(page: Page, password_field) -> None:
    """Submit login — Enter on password field is most reliable for React forms."""
    await asyncio.sleep(0.25)
    try:
        await password_field.press("Enter")
        await asyncio.sleep(0.8)
        if not _is_on_login_page(page.url or "") or await is_logged_in(page):
            return
    except Exception:
        pass
    await _click_login_button(page)
    try:
        await page.wait_for_load_state("domcontentloaded", timeout=8000)
    except Exception:
        pass
    if _ON_RENDER or not E2E_FAST:
        try:
            await page.wait_for_url(
                re.compile(r".*(/orders|/dashboard|/home).*", re.I),
                timeout=min(LOGIN_WAIT_S * 1000, 45_000),
            )
        except Exception:
            pass


async def _fill_field(field, value: str) -> None:
    """Clear React-controlled inputs then fill."""
    timeout = 15_000 if _ON_RENDER else 5_000
    try:
        await field.scroll_into_view_if_needed(timeout=timeout)
    except Exception:
        pass
    try:
        await field.focus(timeout=timeout)
    except Exception:
        pass
    try:
        await field.fill("", timeout=timeout)
        await field.fill(value, timeout=timeout)
    except Exception:
        try:
            await field.click(timeout=timeout, force=True)
            try:
                await field.press("Control+a")
            except Exception:
                pass
            await field.press_sequentially(value, delay=30)
        except Exception:
            pass
    filled = (await field.input_value()).strip()
    if filled != value.strip() and value.strip():
        await field.evaluate(
            "(el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }",
            value,
        )


async def _find_login_fields(page: Page):
    timeout = 15_000 if _ON_RENDER else 8_000
    email_field = await first_visible(page, EMAIL_SELECTORS, timeout=timeout)
    if not email_field:
        for pat in (
            re.compile(r"email", re.I),
            re.compile(r"phone", re.I),
            re.compile(r"username", re.I),
        ):
            try:
                loc = page.get_by_placeholder(pat)
                if await loc.count() > 0:
                    email_field = loc.first
                    await email_field.wait_for(state="visible", timeout=3000)
                    break
            except Exception:
                continue
    password_field = await first_visible(page, PASSWORD_SELECTORS, timeout=timeout)
    if not password_field:
        try:
            loc = page.get_by_placeholder(re.compile(r"password", re.I))
            if await loc.count() > 0:
                password_field = loc.first
        except Exception:
            pass
    return email_field, password_field


async def _fill_login_credentials(page: Page, email_field, password_field) -> str:
    """Always type SHIPMOZO_EMAIL / SHIPMOZO_PASSWORD from env (never rely on remember-me)."""
    email, password = panel_credentials()
    e2e_log("login", f"filling credentials for {email}")

    await _fill_field(email_field, email)
    await dismiss_blocking_overlays(page)
    await _fill_field(password_field, password)

    email_val = (await email_field.input_value()).strip()
    pwd_val = (await password_field.input_value()).strip()
    if not email_val:
        raise RuntimeError(
            "Email field empty after fill — check SHIPMOZO_EMAIL "
            + ("in Render Environment" if _ON_RENDER else "in .env")
        )
    if not pwd_val:
        raise RuntimeError(
            "Password field empty after fill — check SHIPMOZO_PASSWORD "
            + ("in Render Environment" if _ON_RENDER else "in .env")
        )

    e2e_log("login", f"credentials filled email_len={len(email_val)} pwd_len={len(pwd_val)}")
    return email_val


async def _wait_for_login_complete(page: Page, *, timeout_s: int = LOGIN_WAIT_S) -> None:
    e2e_log("login", f"waiting for login (max {timeout_s}s) url={page.url}")
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if await is_logged_in(page):
            return
        url = page.url or ""
        if not _is_on_login_page(url) and "/orders" in url:
            return
        await asyncio.sleep(0.35)
    url = page.url or ""
    if await is_logged_in(page):
        return
    hint = "still on login page" if _is_on_login_page(url) else f"stuck at {url}"
    where = "Render Environment" if _ON_RENDER else ".env"
    raise RuntimeError(
        f"Login did not complete within {timeout_s}s ({hint}). "
        f"Check SHIPMOZO_EMAIL / SHIPMOZO_PASSWORD in {where}."
    )


async def login(page: Page) -> None:
    e2e_log("login", f"fill login form url={page.url}")
    await dismiss_blocking_overlays(page)

    email_field, password_field = await _find_login_fields(page)
    if not email_field:
        if await is_logged_in(page):
            return
        raise RuntimeError("Email/phone input not found on login page")

    if not password_field:
        if await is_logged_in(page):
            return
        raise RuntimeError("Password input not found on login page")

    used_email = await _fill_login_credentials(page, email_field, password_field)
    e2e_log("login", f"submitting for {used_email}")
    await _submit_login_form(page, password_field)

    if _is_on_login_page(page.url or "") and not await is_logged_in(page):
        e2e_log("login", "still on login after submit — retry fill+submit once")
        email_field, password_field = await _find_login_fields(page)
        if email_field and password_field:
            await _fill_login_credentials(page, email_field, password_field)
            await _submit_login_form(page, password_field)

    await _wait_for_login_complete(page)
    if await is_logged_in(page):
        await _leave_post_login_interstitials(page)
    if not await is_logged_in(page):
        where = "Render Environment" if _ON_RENDER else ".env"
        raise RuntimeError(
            f"Login failed for {used_email}. Current URL: {page.url}. "
            f"Verify SHIPMOZO_EMAIL and SHIPMOZO_PASSWORD in {where}."
        )


async def _navigate_with_healing(page: Page, url: str) -> None:
    for attempt in range(2):
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=45000)
            return
        except PlaywrightTimeoutError:
            if attempt == 1:
                raise
            await page.reload(wait_until="domcontentloaded", timeout=30000)
        except PlaywrightError:
            if attempt == 1:
                raise
            await asyncio.sleep(0.25)


async def _open_session(*, use_state: bool):
    p = await async_playwright().start()
    chromium_args = [
        "--disable-gpu",
        "--window-size=1920,1080",
        "--force-device-scale-factor=1",
        "--high-dpi-support=1",
    ]
    if _ON_RENDER or os.getenv("PLAYWRIGHT_NO_SANDBOX", "").lower() in {"1", "true", "yes"}:
        chromium_args.extend(
            [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--single-process",
            ]
        )
    browser = await p.chromium.launch(
        headless=HEADLESS,
        args=chromium_args,
    )
    context_opts: dict = {
        "viewport": {"width": 1920, "height": 1080},
        "device_scale_factor": 1,
    }
    record_video = os.getenv("RECORD_VIDEO", "").lower() in {"1", "true", "yes"}
    video_dir = os.getenv("E2E_VIDEO_DIR", "").strip()
    if record_video:
        vid_path = Path(video_dir) if video_dir else OUTPUT_DIR / "e2e-videos"
        vid_path.mkdir(parents=True, exist_ok=True)
        context_opts["record_video_dir"] = str(vid_path)
        context_opts["record_video_size"] = {"width": 1280, "height": 720}
    if use_state and STATE_PATH.exists():
        context_opts["storage_state"] = str(STATE_PATH)
    context = await browser.new_context(**context_opts)
    page = await context.new_page()
    screenshot_ms = int(os.getenv("DOCS_SCREENSHOT_TIMEOUT_MS", "0") or "0")
    if _ON_RENDER:
        action_ms = screenshot_ms if screenshot_ms >= 8000 else 45_000
        page.set_default_timeout(action_ms)
        page.set_default_navigation_timeout(60_000)
    elif E2E_FAST:
        page.set_default_timeout(8000)
        page.set_default_navigation_timeout(15000)
    else:
        page.set_default_timeout(30000)
        page.set_default_navigation_timeout(45000)
    return p, browser, context, page


async def _attempt_login(page: Page, context) -> None:
    email, _pwd = panel_credentials()  # fail fast if missing on Render
    e2e_log("login", f"attempt_login email={email} url={page.url}")
    base = default_panel_base().rstrip("/")
    nav_timeout = 45_000 if _ON_RENDER or not E2E_FAST else 15_000
    if STATE_PATH.exists():
        try:
            await page.goto(f"{base}/orders/new", wait_until="domcontentloaded", timeout=nav_timeout)
            if await is_logged_in(page):
                e2e_log("login", f"session restored via saved state url={page.url}")
                await _leave_post_login_interstitials(page)
                await context.storage_state(path=str(STATE_PATH))
                return
        except Exception:
            pass

    primary_login = f"{base}/login"
    urls = [primary_login] + [u for u in _login_page_urls() if u != primary_login]

    last_error: Exception | None = None
    login_attempted = False
    for url in urls:
        try:
            e2e_log("login", f"goto {url}")
            await page.goto(url, wait_until="domcontentloaded", timeout=nav_timeout)
        except Exception as exc:
            last_error = exc
            continue

        await dismiss_blocking_overlays(page)

        if await is_logged_in(page):
            e2e_log("login", f"session restored from state url={page.url}")
            await context.storage_state(path=str(STATE_PATH))
            return

        has_login_form = (
            _is_on_login_page(page.url or "")
            or await first_visible(page, EMAIL_SELECTORS, timeout=5000)
            or await first_visible(page, PASSWORD_SELECTORS, timeout=3000)
        )
        if not has_login_form:
            e2e_log("login", f"no login form at {page.url} — skip")
            continue

        login_attempted = True
        try:
            await login(page)
            if await is_logged_in(page):
                e2e_log("login", f"success url={page.url}")
                await _leave_post_login_interstitials(page)
                await context.storage_state(path=str(STATE_PATH))
                return
        except Exception as exc:
            e2e_log("login", f"failed: {exc}")
            last_error = exc
            break

    if await is_logged_in(page):
        await context.storage_state(path=str(STATE_PATH))
        return

    if last_error:
        raise RuntimeError(f"Login failed. Current URL: {page.url}. {last_error}") from last_error
    if login_attempted:
        raise RuntimeError(
            f"Login failed. Current URL: {page.url}. "
            "Check SHIPMOZO_EMAIL / SHIPMOZO_PASSWORD in .env."
        )
    raise RuntimeError(
        f"Could not open login page. Current URL: {page.url}. "
        "Check SHIPMOZO_PANEL_URL in .env."
    )


async def async_login_and_save_state():
    """
    Logs in and returns:
    (playwright, browser, context, page)
    Caller must close these objects.
    """
    stale_state = _state_is_stale()
    if stale_state and STATE_PATH.exists():
        STATE_PATH.unlink(missing_ok=True)

    last_error: Exception | None = None
    for fresh_attempt in range(2):
        p = browser = context = page = None
        try:
            use_state = (
                fresh_attempt == 0
                and not stale_state
                and STATE_PATH.exists()
            )
            if fresh_attempt == 1:
                if STATE_PATH.exists():
                    STATE_PATH.unlink(missing_ok=True)
                use_state = False

            p, browser, context, page = await _open_session(use_state=use_state)
            await _attempt_login(page, context)
            return p, browser, context, page
        except Exception as exc:
            last_error = exc
            if context:
                await context.close()
            if browser:
                await browser.close()
            if p:
                await p.stop()
            if fresh_attempt == 1 or not stale_state:
                raise

    if last_error:
        raise last_error
    raise RuntimeError("Login failed — check SHIPMOZO_EMAIL / SHIPMOZO_PASSWORD in .env.")

