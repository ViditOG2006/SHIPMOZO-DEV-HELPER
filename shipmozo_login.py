from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Iterable

from playwright.async_api import Error as PlaywrightError
from playwright.async_api import Page
from playwright.async_api import TimeoutError as PlaywrightTimeoutError
from playwright.async_api import async_playwright


EMAIL = os.getenv("SHIPMOZO_EMAIL", "munish@apporio.in")
PASSWORD = os.getenv("SHIPMOZO_PASSWORD", "12345678")
HEADLESS = os.getenv("HEADLESS", "false").lower() in {"1", "true", "yes"}

LOGIN_URLS = [
    "https://panel.appiify.com",
    "https://panel.shipmozo.com",
]

DASHBOARD_URL_HINT = "/orders/new"
OUTPUT_DIR = Path("output")
OUTPUT_DIR.mkdir(exist_ok=True)
STATE_PATH = OUTPUT_DIR / "shipmozo-state.json"
SCREENSHOT_PATH = OUTPUT_DIR / "shipmozo-dashboard.png"


async def first_visible(page: Page, selectors: Iterable[str], timeout: int = 3000):
    for selector in selectors:
        try:
            locator = page.locator(selector).first
            await locator.wait_for(state="visible", timeout=timeout)
            return locator
        except Exception:
            continue
    return None


async def is_logged_in(page: Page) -> bool:
    try:
        await page.wait_for_load_state("domcontentloaded")
        if DASHBOARD_URL_HINT in page.url:
            return True
        dashboard_markers = [
            "text=Shipment Booking",
            "text=Add Order",
            "text=New",
            "text=Courier Assigned",
            "text=Orders",
        ]
        for marker in dashboard_markers:
            if await page.locator(marker).count() > 0:
                return True
    except Exception:
        pass
    return False


async def _click_login_button(page: Page) -> None:
    button_candidates = [
        page.get_by_role("button", name="Sign In"),
        page.get_by_role("button", name="Log In"),
        page.get_by_role("button", name="Login"),
        page.get_by_role("button", name="SIGN IN"),
        page.get_by_role("button", name="LOG IN"),
        page.locator('button[type="submit"]'),
        page.locator('input[type="submit"]'),
        page.locator("button").filter(has_text="Log In"),
        page.locator("button").filter(has_text="Sign In"),
    ]
    for candidate in button_candidates:
        try:
            if await candidate.count() > 0:
                target = candidate.first
                if await target.is_visible():
                    await target.click()
                else:
                    await target.click(force=True)
                return
        except Exception:
            continue
    raise RuntimeError("Login button not found")


async def login(page: Page) -> None:
    email_field = await first_visible(
        page,
        [
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
        ],
        timeout=8000,
    )
    if not email_field:
        if await is_logged_in(page):
            return
        raise RuntimeError("Email/phone input not found")

    password_field = await first_visible(
        page,
        [
            'input[type="password"]',
            'input[name="password"]',
            'input[placeholder*="Password"]',
            'input[placeholder*="password"]',
            'input[aria-label*="Password"]',
            'input[autocomplete="current-password"]',
        ],
        timeout=8000,
    )
    if not password_field:
        if await is_logged_in(page):
            return
        raise RuntimeError("Password input not found")

    await email_field.fill(EMAIL)
    await password_field.fill(PASSWORD)
    await _click_login_button(page)


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
            await asyncio.sleep(1)


async def async_login_and_save_state():
    """
    Logs in and returns:
    (playwright, browser, context, page)
    Caller must close these objects.
    """
    p = await async_playwright().start()
    browser = await p.chromium.launch(
        headless=HEADLESS,
        args=[
            "--disable-gpu",
            "--window-size=1920,1080",
            "--force-device-scale-factor=1",
            "--high-dpi-support=1",
        ],
    )
    context_opts: dict = {
        "viewport": {"width": 1920, "height": 1080},
        "device_scale_factor": 1,
    }
    if STATE_PATH.exists():
        context_opts["storage_state"] = str(STATE_PATH)
    context = await browser.new_context(**context_opts)
    page = await context.new_page()
    page.set_default_timeout(30000)
    page.set_default_navigation_timeout(45000)

    try:
        for url in LOGIN_URLS:
            await _navigate_with_healing(page, url)

            if await is_logged_in(page):
                await context.storage_state(path=str(STATE_PATH))
                return p, browser, context, page

            try:
                await login(page)
                await page.wait_for_load_state("domcontentloaded")
                await asyncio.sleep(3)
                try:
                    await page.wait_for_url(f"**{DASHBOARD_URL_HINT}**", timeout=20000)
                except Exception:
                    pass
                if await is_logged_in(page):
                    await context.storage_state(path=str(STATE_PATH))
                    return p, browser, context, page
            except Exception:
                continue

        try:
            await page.wait_for_url(f"**{DASHBOARD_URL_HINT}", timeout=15000)
        except Exception:
            pass

        if not await is_logged_in(page):
            raise RuntimeError(f"Login failed. Current URL: {page.url}")

        await context.storage_state(path=str(STATE_PATH))
        return p, browser, context, page
    except Exception:
        await context.close()
        await browser.close()
        await p.stop()
        raise

