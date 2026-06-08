from __future__ import annotations

import asyncio
import os
import random
import re
import traceback
from datetime import datetime
from pathlib import Path
from typing import Iterable

from playwright.async_api import Locator
from playwright.async_api import Request
from playwright.async_api import Response

from shipmozo_login import async_login_and_save_state

BASE = os.getenv("PANEL_BASE", "https://panel.appiify.com")
QUICK_ADD_URL = f"{BASE}/orders/quick-add"
ORDERS_NEW_URL = f"{BASE}/orders/new"
OUTPUT_DIR = Path("output")
OUTPUT_DIR.mkdir(exist_ok=True)

PHONE = os.getenv("QO_PHONE", "9876543210")
BUYER_NAME = os.getenv("QO_BUYER_NAME", "Quick Test Customer")
EMAIL_ID = os.getenv("QO_EMAIL", "quick.test@example.com")
ADDRESS = os.getenv("QO_ADDRESS", "123 Main Street, Sector 14")
PINCODE = os.getenv("QO_PINCODE", "122001")
PRODUCT_NAME = os.getenv("QO_PRODUCT", "Test Product")
QTY = os.getenv("QO_QTY", "1")
UNIT_PRICE = os.getenv("QO_UNIT_PRICE", "500")
WEIGHT = os.getenv("QO_WEIGHT", "0.5")
LENGTH = os.getenv("QO_LENGTH", "20")
WIDTH = os.getenv("QO_WIDTH", "15")
HEIGHT = os.getenv("QO_HEIGHT", "10")
HSN = os.getenv("QO_HSN", "84713010")
PAYMENT_MODE = os.getenv("QO_PAYMENT_MODE", "Prepaid")  # Prepaid or COD
MAX_ATTEMPTS = int(os.getenv("QO_MAX_ATTEMPTS", "1"))

REF_ID = os.getenv("QO_REF_ID", f"QREF-{random.randint(10000, 99999)}")


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")


class ShipmozoQuickOrderBot:
    def __init__(self) -> None:
        self.p = None
        self.browser = None
        self.context = None
        self.page = None
        self.last_requests: list[str] = []
        self.last_responses: list[str] = []
        self.last_failures: list[str] = []
        self.last_console_errors: list[str] = []

    async def start(self) -> None:
        self.p, self.browser, self.context, self.page = await async_login_and_save_state()
        self.page.set_default_timeout(60000)
        self.page.set_default_navigation_timeout(60000)
        log("Browser launched and logged in")

    async def stop(self) -> None:
        if self.context:
            try:
                await self.context.close()
            except Exception:
                pass
        if self.browser:
            try:
                await self.browser.close()
            except Exception:
                pass
        if self.p:
            try:
                await self.p.stop()
            except Exception:
                pass
        self.p = self.browser = self.context = self.page = None
        log("Browser closed")

    async def first_visible(
        self, selectors: Iterable[str], timeout: int = 12000
    ) -> Locator | None:
        for selector in selectors:
            try:
                loc = self.page.locator(selector).first
                await loc.wait_for(state="visible", timeout=timeout)
                return loc
            except Exception:
                continue
        return None

    async def fill_first(
        self,
        selectors: Iterable[str],
        value: str,
        field_name: str,
        required: bool = True,
        timeout: int = 12000,
    ) -> bool:
        loc = await self.first_visible(selectors, timeout=timeout)
        if not loc:
            if required:
                raise RuntimeError(f"{field_name} field not found")
            return False
        await loc.click()
        await loc.fill("")
        await loc.fill(value)
        await self.page.keyboard.press("Tab")
        await asyncio.sleep(0.2)
        return True

    async def click_first(
        self, selectors: Iterable[str], field_name: str, required: bool = True, timeout: int = 8000
    ) -> bool:
        loc = await self.first_visible(selectors, timeout=timeout)
        if not loc:
            if required:
                raise RuntimeError(f"{field_name} button not found")
            return False
        await loc.click()
        return True

    async def go_quick_add(self) -> None:
        log("Opening Quick Add page...")
        await self.page.goto(QUICK_ADD_URL, wait_until="domcontentloaded")
        await self.page.wait_for_load_state("networkidle")

    async def fill_quick_order_form(self) -> None:
        log("Filling Quick Add form...")

        await self.fill_first(
            [
                'input[placeholder*="phone"]',
                'input[aria-label*="phone"]',
                'input[name*="phone"]',
                'input[id*="phone"]',
            ],
            PHONE,
            "phone",
            required=True,
            timeout=20000,
        )
        await self.fill_first(
            [
                'input[placeholder*="name"]',
                'input[aria-label*="name"]',
                'input[name*="name"]',
                'input[id*="name"]',
            ],
            BUYER_NAME,
            "buyer name",
            required=True,
            timeout=12000,
        )
        await self.fill_first(
            [
                'input[placeholder*="email"]',
                'input[aria-label*="email"]',
                'input[name*="email"]',
                'input[id*="email"]',
            ],
            EMAIL_ID,
            "email",
            required=False,
        )
        # Fill Address Line 1 explicitly first, then fallback selectors.
        if await self.page.locator("#addressLineOne").count() > 0:
            await self.fill_first(["#addressLineOne"], ADDRESS, "address line 1", required=True)
        else:
            await self.fill_first(
                [
                    'textarea[placeholder*="Address"]',
                    'input[placeholder*="Address"]',
                    'textarea[name*="address"]',
                    'input[name*="address"]',
                ],
                ADDRESS,
                "address",
                required=True,
            )
        await self.fill_first(
            [
                'input[placeholder*="pincode"]',
                'input[placeholder*="Pincode"]',
                'input[name*="pincode"]',
                "#pincode",
            ],
            PINCODE,
            "pincode",
            required=True,
        )

        await self.fill_first(
            [
                'input[placeholder*="reference"]',
                'input[name*="reference"]',
                '#referenceId',
            ],
            REF_ID,
            "reference id",
            required=False,
        )

        product_input = await self.first_visible(
            [
                '#panel2a-content input[placeholder*="name or search"]',
                "#product-name",
                'input[name*="product"]',
                'input[id*="product"]',
                'input[placeholder*="Product"]',
            ],
            timeout=15000,
        )
        if not product_input:
            raise RuntimeError("product field not found")
        await product_input.click()
        await product_input.fill("")
        await product_input.fill(PRODUCT_NAME)
        await asyncio.sleep(1.0)
        option = self.page.locator(f'[role="option"]:has-text("{PRODUCT_NAME}")').first
        any_option = self.page.locator('[role="option"]').first
        if await option.count() > 0 and await option.is_visible():
            await option.click()
        elif await any_option.count() > 0 and await any_option.is_visible():
            await any_option.click()
        else:
            await self.page.keyboard.press("Tab")
        await asyncio.sleep(0.5)

        await self.fill_first(["#hsn-0", 'input[name*="hsn"]', 'input[id*="hsn"]'], HSN, "hsn", required=False)
        await self.fill_first(["#qty-0", 'input[name*="qty"]', 'input[id*="qty"]'], QTY, "quantity", required=False)
        await self.fill_first(
            ["#unitPrice-0", 'input[name*="unitPrice"]', 'input[id*="unitPrice"]'],
            UNIT_PRICE,
            "unit price",
            required=False,
        )
        await self.fill_first(["#totalWeight", 'input[name*="weight"]', 'input[id*="weight"]'], WEIGHT, "weight", required=False)
        await self.fill_first(["#lengthCM-0", 'input[name*="length"]', 'input[id*="length"]'], LENGTH, "length", required=False)
        await self.fill_first(["#widthCM-0", 'input[name*="width"]', 'input[id*="width"]'], WIDTH, "width", required=False)
        await self.fill_first(["#heightCM-0", 'input[name*="height"]', 'input[id*="height"]'], HEIGHT, "height", required=False)

        if PAYMENT_MODE.lower() == "cod":
            await self.click_first(
                ['input[type="radio"][value="COD"]', "text=COD"],
                "payment COD",
                required=False,
            )
        else:
            await self.click_first(
                ['input[type="radio"][value="Prepaid"]', "text=Prepaid"],
                "payment Prepaid",
                required=False,
            )

        await self.ensure_pickup_address_selected()
        await self.pre_save_validate_quick_add()

        await self.page.screenshot(path=str(OUTPUT_DIR / "quick_order_before_save.png"), full_page=True)

    async def ensure_pickup_address_selected(self) -> None:
        log("Ensuring pickup address is selected...")
        pickup_input = await self.first_visible(
            [
                'input[placeholder*="Select address"]',
                'input[name*="pickup"]',
                'input[id*="pickup"]',
                'input[id*="warehouse"]',
            ],
            timeout=10000,
        )
        if not pickup_input:
            log("Pickup input not found; skipping explicit pickup selection")
            return

        current = (await pickup_input.input_value()).strip()
        if current:
            log(f"Pickup already selected: {current}")
            return

        await pickup_input.click()
        await asyncio.sleep(0.8)

        preferred = self.page.locator('[role="option"]:has-text("Default")').first
        any_option = self.page.locator('[role="option"]').first
        picked = False
        try:
            if await preferred.count() > 0 and await preferred.is_visible():
                await preferred.click()
                picked = True
            elif await any_option.count() > 0 and await any_option.is_visible():
                await any_option.click()
                picked = True
        except Exception:
            picked = False

        if not picked:
            # Some layouts use clickable warehouse cards instead of listbox options.
            card = self.page.locator('text=Default').first
            if await card.count() > 0:
                try:
                    await card.click()
                    picked = True
                except Exception:
                    pass

        await asyncio.sleep(0.7)
        current = (await pickup_input.input_value()).strip()
        if not current:
            raise RuntimeError("Pickup address still not selected")
        log(f"Pickup selected: {current}")

    async def pre_save_validate_quick_add(self) -> None:
        checks = [
            ("phone", ['input[placeholder*="phone"]']),
            ("buyer_name", ['input[placeholder*="name"]']),
            ("address_line_1", ["#addressLineOne", 'input[placeholder*="Address"]']),
            ("pincode", ["#pincode", 'input[placeholder*="pincode"]']),
            ("city", ["#city", 'input[placeholder*="City"]']),
            ("state", ["#state", 'input[placeholder*="State"]']),
            ("product_name", ['#panel2a-content input[placeholder*="name or search"]', "#product-name"]),
            ("pickup_address", ['input[placeholder*="Select address"]']),
        ]

        missing: list[str] = []
        for label, selectors in checks:
            value = ""
            for selector in selectors:
                try:
                    loc = self.page.locator(selector).first
                    if await loc.count() == 0:
                        continue
                    await loc.wait_for(state="attached", timeout=1200)
                    value = (await loc.input_value()).strip()
                    if value:
                        break
                except Exception:
                    continue
            if not value:
                missing.append(label)

        if missing:
            raise RuntimeError(f"Quick add pre-save validation failed. Missing: {missing}")

    async def _install_save_diagnostics(self) -> tuple:
        self.last_requests = []
        self.last_responses = []
        self.last_failures = []
        self.last_console_errors = []

        def on_request(req: Request) -> None:
            try:
                if req.method in {"POST", "PUT", "PATCH"}:
                    self.last_requests.append(f"{req.method} {req.url}")
            except Exception:
                return

        def on_response(resp: Response) -> None:
            try:
                url = resp.url.lower()
                if any(k in url for k in ["order", "shipment", "booking", "save"]):
                    self.last_responses.append(f"{resp.status} {resp.url}")
            except Exception:
                return

        def on_failed(req: Request) -> None:
            try:
                self.last_failures.append(f"{req.method} {req.url} -> {req.failure or 'failed'}")
            except Exception:
                return

        def on_console(msg) -> None:
            try:
                if msg.type == "error":
                    self.last_console_errors.append(msg.text)
            except Exception:
                return

        self.page.on("request", on_request)
        self.page.on("response", on_response)
        self.page.on("requestfailed", on_failed)
        self.page.on("console", on_console)
        return on_request, on_response, on_failed, on_console

    async def _remove_save_diagnostics(self, handlers: tuple) -> None:
        on_request, on_response, on_failed, on_console = handlers
        self.page.remove_listener("request", on_request)
        self.page.remove_listener("response", on_response)
        self.page.remove_listener("requestfailed", on_failed)
        self.page.remove_listener("console", on_console)

    async def save_quick_order(self) -> None:
        log("Saving Quick Order...")
        handlers = await self._install_save_diagnostics()

        try:
            save_buttons = self.page.get_by_role(
                "button",
                name=re.compile(r"^\s*Save\s*$", re.IGNORECASE),
            )
            save_count = await save_buttons.count()
            if save_count == 0:
                save_buttons = self.page.locator('button:has-text("Save")')
                save_count = await save_buttons.count()
            if save_count == 0:
                raise RuntimeError("Save button not found on quick add page")

            clicked = False
            for i in range(save_count):
                btn = save_buttons.nth(i)
                try:
                    if not await btn.is_visible():
                        continue
                    await btn.scroll_into_view_if_needed()
                    await btn.click(timeout=10000)
                    await asyncio.sleep(1.8)
                    clicked = True
                    if self.last_requests:
                        break
                except Exception:
                    continue

            if not clicked:
                raise RuntimeError("Could not click any visible Save button")

            if not self.last_requests:
                assign_btn = self.page.get_by_role(
                    "button",
                    name=re.compile(r"^\s*Save\s*&\s*Assign\s*Courier\s*$", re.IGNORECASE),
                )
                if await assign_btn.count() > 0:
                    try:
                        await assign_btn.first.click(timeout=10000)
                        await asyncio.sleep(2.0)
                    except Exception:
                        pass

            for txt in ["Confirm", "Yes", "OK", "Proceed"]:
                try:
                    btn = self.page.locator(f'button:has-text("{txt}")').first
                    if await btn.count() > 0 and await btn.is_visible():
                        await btn.click(force=True)
                        await asyncio.sleep(0.8)
                        break
                except Exception:
                    continue

            await asyncio.sleep(4)
            await self.page.screenshot(path=str(OUTPUT_DIR / "quick_order_after_save.png"), full_page=True)
            log(f"URL after save: {self.page.url}")
        finally:
            await self._remove_save_diagnostics(handlers)

        if self.last_requests:
            log("Write requests seen:")
            for item in self.last_requests[:10]:
                log(f"  - {item}")
        if self.last_responses:
            log("Save-related responses seen:")
            for item in self.last_responses[:10]:
                log(f"  - {item}")
        if self.last_failures:
            log("Failed requests:")
            for item in self.last_failures[:10]:
                log(f"  - {item}")
        if self.last_console_errors:
            log("Console errors:")
            for item in self.last_console_errors[:10]:
                log(f"  - {item}")

    async def verify_order(self) -> bool:
        log(f"Verifying quick order in list. ref={REF_ID}, phone={PHONE}")
        await self.page.goto(ORDERS_NEW_URL, wait_until="domcontentloaded")
        await self.page.wait_for_load_state("networkidle")

        search = await self.first_visible(
            [
                'input[placeholder*="reference"]',
                'input[placeholder*="Search"]',
                'input[type="search"]',
            ],
            timeout=15000,
        )
        if not search:
            log("Orders search input not found")
            await self.page.screenshot(path=str(OUTPUT_DIR / "quick_order_verify_failed.png"), full_page=True)
            return False

        for query in [REF_ID, PHONE]:
            await search.fill("")
            await search.fill(query)
            await self.page.keyboard.press("Enter")
            await asyncio.sleep(4)
            body = (await self.page.inner_text("body")).lower()
            if query.lower() in body:
                await self.page.screenshot(path=str(OUTPUT_DIR / "quick_order_verified.png"), full_page=True)
                log(f"Quick order found in list by query: {query}")
                return True

        await self.page.screenshot(path=str(OUTPUT_DIR / "quick_order_not_found.png"), full_page=True)
        log("Quick order not found in orders list")
        return False

    async def run_once(self) -> None:
        await self.start()
        await self.go_quick_add()
        await self.fill_quick_order_form()
        await self.save_quick_order()
        verified = await self.verify_order()
        if not verified:
            raise RuntimeError(
                f"Quick order not found. requests={self.last_requests or 'none'}, "
                f"responses={self.last_responses or 'none'}, failures={self.last_failures or 'none'}, "
                f"console={self.last_console_errors or 'none'}"
            )

    async def run(self) -> bool:
        for attempt in range(MAX_ATTEMPTS):
            try:
                log(f"=== QUICK ORDER ATTEMPT {attempt + 1}/{MAX_ATTEMPTS} ===")
                await self.run_once()
                print(f"\n*** QUICK ORDER CREATED: Ref={REF_ID} ***\n")
                return True
            except Exception:
                traceback.print_exc()
            finally:
                await self.stop()

            if attempt < MAX_ATTEMPTS - 1:
                log("Retrying in 5 seconds...\n")
                await asyncio.sleep(5)

        log("All quick-order attempts failed.")
        return False


async def main() -> None:
    success = await ShipmozoQuickOrderBot().run()
    if not success:
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
