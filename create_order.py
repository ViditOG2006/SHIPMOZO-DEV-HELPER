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
from playwright.async_api import TimeoutError as PlaywrightTimeoutError
from playwright.async_api import Response
from playwright.async_api import Request

from shipmozo_login import async_login_and_save_state

BASE = os.getenv("PANEL_BASE", "https://panel.appiify.com")
ADD_ORDER_URL = f"{BASE}/orders/add?type=DOM"
OUTPUT_DIR = Path("output")
OUTPUT_DIR.mkdir(exist_ok=True)

PHONE = os.getenv("ORDER_PHONE", "9876543210")
BUYER_NAME = os.getenv("ORDER_BUYER_NAME", "Test Customer")
EMAIL_ID = os.getenv("ORDER_EMAIL", "test@example.com")
ADDRESS = os.getenv("ORDER_ADDRESS", "123 Main Street, Sector 14")
ADDRESS2 = os.getenv("ORDER_ADDRESS2", "Near Metro Station")
PINCODE = os.getenv("ORDER_PINCODE", "122001")
PRODUCT_NAME = os.getenv("ORDER_PRODUCT", "Test Product")
HSN = os.getenv("ORDER_HSN", "84713010")
QTY = os.getenv("ORDER_QTY", "1")
UNIT_PRICE = os.getenv("ORDER_UNIT_PRICE", "500")
SHIPPING = os.getenv("ORDER_SHIPPING", "80")
WEIGHT = os.getenv("ORDER_WEIGHT", "0.5")
LENGTH = os.getenv("ORDER_LENGTH", "20")
WIDTH = os.getenv("ORDER_WIDTH", "15")
HEIGHT = os.getenv("ORDER_HEIGHT", "10")
WAREHOUSE = os.getenv("ORDER_WAREHOUSE", "Testing warehouse")
MAX_ATTEMPTS = int(os.getenv("ORDER_MAX_ATTEMPTS", "1"))

REF_ID = os.getenv("ORDER_REF_ID", f"REF-{random.randint(10000, 99999)}")
INV_NUM = os.getenv("ORDER_INV_NUM", f"INV-{random.randint(10000, 99999)}")


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")


class ShipmozoOrderBot:
    def __init__(self) -> None:
        self.p = None
        self.browser = None
        self.context = None
        self.page = None
        self.last_save_errors: list[str] = []
        self.last_save_api_calls: list[str] = []
        self.last_save_requests: list[str] = []
        self.last_save_failures: list[str] = []
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
        self, selectors: Iterable[str], timeout: int = 10000
    ) -> Locator | None:
        for selector in selectors:
            try:
                loc = self.page.locator(selector).first
                await loc.wait_for(state="visible", timeout=timeout)
                return loc
            except Exception:
                continue
        return None

    async def first_attached(
        self, selectors: Iterable[str], timeout: int = 10000
    ) -> Locator | None:
        for selector in selectors:
            try:
                loc = self.page.locator(selector).first
                await loc.wait_for(state="attached", timeout=timeout)
                return loc
            except Exception:
                continue
        return None

    async def fill_field(
        self, selectors: Iterable[str], value: str, timeout: int = 12000
    ) -> bool:
        target = await self.first_visible(selectors, timeout=timeout)
        if not target:
            return False
        await target.fill(value)
        return True

    async def fill_autocomplete(
        self,
        selectors: Iterable[str],
        value: str,
        option_hint: str | None = None,
        require_non_empty: bool = True,
        timeout: int = 15000,
    ) -> bool:
        target = await self.first_visible(selectors, timeout=timeout)
        if not target:
            return False

        await target.click()
        await target.fill("")
        await target.fill(value)
        await asyncio.sleep(0.8)

        preferred = None
        if option_hint:
            preferred = self.page.locator(
                f'[role="option"]:has-text("{option_hint}")'
            ).first
        exact = self.page.locator(f'[role="option"]:has-text("{value}")').first
        any_option = self.page.locator('[role="option"]').first

        try:
            if preferred and await preferred.count() > 0 and await preferred.is_visible():
                await preferred.click()
            elif await exact.count() > 0 and await exact.is_visible():
                await exact.click()
            elif await any_option.count() > 0 and await any_option.is_visible():
                await any_option.click()
            else:
                await self.page.keyboard.press("ArrowDown")
                await self.page.keyboard.press("Enter")
        except Exception:
            try:
                await self.page.keyboard.press("ArrowDown")
                await self.page.keyboard.press("Enter")
            except Exception:
                pass

        await asyncio.sleep(0.6)
        final_value = (await target.input_value()).strip()
        if require_non_empty:
            return bool(final_value)
        return True

    async def fill_and_commit_input(
        self, selectors: Iterable[str], value: str, timeout: int = 15000
    ) -> bool:
        target = await self.first_visible(selectors, timeout=timeout)
        if not target:
            return False

        try:
            await target.click()
            await target.fill("")
            await target.fill(value)
            await self.page.keyboard.press("Tab")
            await asyncio.sleep(0.4)
            current = (await target.input_value()).strip()
            if current:
                return True
        except Exception:
            pass

        # Hard fallback for controlled inputs that ignore regular fill.
        try:
            handle = await target.element_handle()
            if not handle:
                return False
            await self.page.evaluate(
                """
                (el, val) => {
                  const setter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype,
                    "value"
                  )?.set;
                  if (setter) {
                    setter.call(el, val);
                  } else {
                    el.value = val;
                  }
                  el.dispatchEvent(new Event("input", { bubbles: true }));
                  el.dispatchEvent(new Event("change", { bubbles: true }));
                  el.dispatchEvent(new Event("blur", { bubbles: true }));
                }
                """,
                handle,
                value,
            )
            await asyncio.sleep(0.3)
            current = (await target.input_value()).strip()
            return bool(current)
        except Exception:
            return False

    async def expand_section(self, header_ids: Iterable[str]) -> None:
        for header_id in header_ids:
            hdr = await self.first_attached([f'[id="{header_id}"]'], timeout=1500)
            if not hdr:
                continue
            expanded = await hdr.get_attribute("aria-expanded")
            if expanded == "false":
                await hdr.click()
                await asyncio.sleep(0.3)
            return

    async def go_add_order(self) -> None:
        log("Opening Add Order page...")
        await self.page.goto(ADD_ORDER_URL, wait_until="domcontentloaded")
        await self.page.wait_for_load_state("networkidle")

    async def fill_buyer_receiver(self) -> None:
        log("Filling Buyer/Receiver Details...")
        await self.expand_section(["panel1aHeader", "panel0aHeader"])

        phone_done = await self.fill_and_commit_input(
            [
                'input[aria-label="Enter phone or search"]',
                'input[placeholder="Enter phone or search"]',
                'input[placeholder*="phone"]',
                'input[name="phone"]',
            ],
            PHONE,
            timeout=20000,
        )
        if not phone_done:
            raise RuntimeError("Buyer phone input not found")

        name_done = await self.fill_and_commit_input(
            [
                'input[aria-label="Enter name or search"]',
                'input[placeholder="Enter name or search"]',
                'input[placeholder*="name"]',
                'input[name="name"]',
            ],
            BUYER_NAME,
            timeout=15000,
        )
        if not name_done:
            raise RuntimeError("Buyer name input not found")
        await self.fill_field(
            [
                'input[id="emailId"]',
                'input[name="email"]',
                'input[placeholder*="Email"]',
            ],
            EMAIL_ID,
            timeout=4000,
        )

        await self.page.fill("#addressLineOne", ADDRESS)
        if await self.page.locator("#addressLineTwo").count() > 0:
            await self.page.fill("#addressLineTwo", ADDRESS2)
        await self.page.fill("#pincode", PINCODE)
        await self.page.keyboard.press("Tab")

        await self.page.wait_for_function(
            """
            () => {
                const city = document.querySelector("#city");
                const state = document.querySelector("#state");
                return city && state && city.value.trim() && state.value.trim();
            }
            """,
            timeout=20000,
        )
        city = await self.page.input_value("#city")
        state = await self.page.input_value("#state")
        log(f"City={city}, State={state}")

        # Runtime DOM diagnostics for buyer fields (self-healing aid).
        try:
            buyer_dump = await self.page.evaluate(
                """
                () => {
                  const rows = [];
                  const all = Array.from(document.querySelectorAll("input,textarea,select"));
                  for (const el of all) {
                    const rect = el.getBoundingClientRect();
                    if (rect.width < 4 || rect.height < 4) continue;
                    const style = window.getComputedStyle(el);
                    if (style.display === "none" || style.visibility === "hidden") continue;
                    const tag = el.tagName.toLowerCase();
                    const type = (el.getAttribute("type") || "").toLowerCase();
                    if (tag === "input" && ["hidden", "file", "checkbox", "radio"].includes(type)) continue;

                    const id = el.id || "";
                    const name = el.getAttribute("name") || "";
                    const aria = el.getAttribute("aria-label") || "";
                    const ph = el.getAttribute("placeholder") || "";
                    const val = (el.value || "").trim();
                    const invalid = el.getAttribute("aria-invalid") || "";

                    const key = `${id} ${name} ${aria} ${ph}`.toLowerCase();
                    if (
                      key.includes("phone") ||
                      key.includes("name") ||
                      key.includes("buyer") ||
                      key.includes("receiver")
                    ) {
                      rows.push({ id, name, aria, ph, val, invalid });
                    }
                  }
                  return rows;
                }
                """
            )
            log(f"Buyer field diagnostics: {buyer_dump}")
        except Exception:
            pass

    async def fill_order_details(self) -> None:
        log("Filling Order Details...")
        await self.expand_section(["panel2aHeader"])

        await self.page.fill("#referenceId", REF_ID)
        if await self.page.locator("#invoiceNumber").count() > 0:
            await self.page.fill("#invoiceNumber", INV_NUM)

        product = await self.first_visible(
            [
                '#panel2a-content input[placeholder*="name or search"]',
                "#product-name",
                'input[id^="product"]',
                'input[placeholder*="Product"]',
            ],
            timeout=30000,
        )
        if not product:
            raise RuntimeError("Product input not found")

        await product.click()
        await product.fill("")
        await product.fill(PRODUCT_NAME)
        await asyncio.sleep(1.0)

        preferred_option = self.page.locator(
            f'[role="option"]:has-text("{PRODUCT_NAME}")'
        ).first
        any_option = self.page.locator('[role="option"]').first
        picked = False
        try:
            if await preferred_option.count() > 0 and await preferred_option.is_visible():
                chosen = (await preferred_option.inner_text()).strip()
                await preferred_option.click()
                picked = True
                log(f"Product option selected: {chosen}")
            elif await any_option.count() > 0 and await any_option.is_visible():
                chosen = (await any_option.inner_text()).strip()
                await any_option.click()
                picked = True
                log(f"Product fallback option selected: {chosen}")
        except Exception:
            picked = False

        if not picked:
            await product.click()
            await self.page.keyboard.press("Tab")
            await asyncio.sleep(0.6)
            product_value = (await product.input_value()).strip()
            product_invalid = (await product.get_attribute("aria-invalid")) == "true"
            if product_value and not product_invalid:
                log(f"Product typed without dropdown option: {product_value}")
            else:
                raise RuntimeError(
                    "Product selection failed: no option and typed value did not persist"
                )
        else:
            await asyncio.sleep(0.7)
            product_value = (await product.input_value()).strip()
            if not product_value:
                raise RuntimeError("Product selection failed: value is empty after option click")

        if await self.page.locator("#hsn-0").count() > 0:
            raw_hsn = "".join(ch for ch in str(HSN) if ch.isdigit())
            # Shipmozo typically expects a valid 6 or 8-digit numeric HSN.
            hsn_to_use = raw_hsn if len(raw_hsn) in {6, 8} else "84713010"
            await self.page.fill("#hsn-0", hsn_to_use)
            await self.page.keyboard.press("Tab")
            await asyncio.sleep(0.2)
        if await self.page.locator("#qty-0").count() > 0:
            await self.page.fill("#qty-0", QTY)
        if await self.page.locator("#unitPrice-0").count() > 0:
            await self.page.fill("#unitPrice-0", UNIT_PRICE)

    async def fill_payment_shipping(self) -> None:
        log("Filling Payment & Shipping...")
        await self.expand_section(["panel3aHeader", "panel2aHeader"])

        prepaid = self.page.locator('input[type="radio"][value="Prepaid"]').first
        try:
            if await prepaid.count() > 0:
                await prepaid.check(force=True)
            else:
                await self.page.get_by_text("Prepaid", exact=False).first.click()
        except Exception:
            await self.page.get_by_text("Prepaid", exact=False).first.click()

        if await self.page.locator("#shippingCharges").count() > 0:
            await self.page.fill("#shippingCharges", str(SHIPPING))

    async def select_warehouse(self) -> None:
        log("Selecting Warehouse...")
        await self.expand_section(["panel3aHeader", "panel2aHeader"])

        input_selectors = [
            "#select-warehouse-address-id",
            'input[name="pickupaddress"]',
            'input[placeholder*="Select address"]',
        ]
        warehouse_input = await self.first_attached(input_selectors, timeout=30000)
        if not warehouse_input:
            raise RuntimeError("Warehouse input not found")

        current_value = (await warehouse_input.input_value()).strip()
        if current_value:
            log(f"Warehouse already selected: {current_value}")
            return

        open_targets = [
            'button[aria-label*="warehouse"]',
            '[id="select-warehouse-address-id"]',
            '[role="combobox"][name*="address"]',
        ]
        opener = await self.first_visible(open_targets, timeout=7000)
        if opener:
            await opener.click()
        else:
            await warehouse_input.click(force=True)
        await asyncio.sleep(0.7)

        preferred_option = self.page.locator(
            f'[role="option"]:has-text("{WAREHOUSE}")'
        ).first
        any_option = self.page.locator('[role="option"]').first

        if await preferred_option.count() > 0:
            await preferred_option.click()
        elif await any_option.count() > 0:
            await any_option.click()
        else:
            raise RuntimeError("No warehouse options found in dropdown")

        await asyncio.sleep(0.7)
        new_value = (await warehouse_input.input_value()).strip()
        if not new_value:
            raise RuntimeError("Warehouse not selected after dropdown interaction")
        log(f"Warehouse selected: {new_value}")

    async def fill_weight_dimensions(self) -> None:
        log("Filling Weight & Dimensions...")
        await self.expand_section(["panel4aHeader", "panel3aHeader"])

        await self.page.fill("#totalWeight", str(WEIGHT))
        await self.page.fill("#lengthCM-0", str(LENGTH))
        await self.page.fill("#widthCM-0", str(WIDTH))
        await self.page.fill("#heightCM-0", str(HEIGHT))
        await self.page.keyboard.press("Tab")
        await asyncio.sleep(0.4)
        log("Weight & Dimensions filled")

    async def _validate_filled_required_fields(self) -> None:
        log("Validating required details before Save...")
        checks = [
            (
                "phone",
                [
                    'input[aria-label="Enter phone or search"]',
                    'input[placeholder="Enter phone or search"]',
                    'input[placeholder*="phone"]',
                    'input[name="phone"]',
                ],
            ),
            (
                "buyer_name",
                [
                    'input[aria-label="Enter name or search"]',
                    'input[placeholder="Enter name or search"]',
                    'input[placeholder*="name"]',
                    'input[name="name"]',
                ],
            ),
            ("address_line_1", ["#addressLineOne"]),
            ("pincode", ["#pincode"]),
            ("city", ["#city"]),
            ("state", ["#state"]),
            ("reference_id", ["#referenceId"]),
            ("product_name", ["#product-name", 'input[id^="product"]']),
            ("total_weight", ["#totalWeight"]),
            ("length_cm", ["#lengthCM-0"]),
            ("width_cm", ["#widthCM-0"]),
            ("height_cm", ["#heightCM-0"]),
            ("warehouse", ["#select-warehouse-address-id", 'input[name="pickupaddress"]']),
        ]

        missing: list[str] = []
        filled_snapshot: list[str] = []
        for label, selectors in checks:
            if label in {"product_name"}:
                prod_ok = False
                for selector in selectors:
                    try:
                        loc = self.page.locator(selector).first
                        if await loc.count() == 0:
                            continue
                        await loc.wait_for(state="attached", timeout=1500)
                        val = (await loc.input_value()).strip()
                        invalid = (await loc.get_attribute("aria-invalid")) == "true"
                        if val and not invalid:
                            prod_ok = True
                            break
                    except Exception:
                        continue
                if prod_ok:
                    filled_snapshot.append("product_name=selected")
                else:
                    missing.append(label)
                continue

            if label in {"phone", "buyer_name"}:
                selected = False
                for selector in selectors:
                    try:
                        loc = self.page.locator(selector).first
                        if await loc.count() == 0:
                            continue
                        await loc.wait_for(state="attached", timeout=1500)
                        val = (await loc.input_value()).strip()
                        invalid = (await loc.get_attribute("aria-invalid")) == "true"
                        if val and not invalid:
                            selected = True
                            break
                    except Exception:
                        continue
                if selected:
                    filled_snapshot.append(f"{label}=selected")
                else:
                    missing.append(label)
                continue

            value = ""
            for selector in selectors:
                try:
                    loc = self.page.locator(selector).first
                    if await loc.count() == 0:
                        continue
                    await loc.wait_for(state="attached", timeout=1500)
                    value = (await loc.input_value()).strip()
                    if value:
                        break
                except Exception:
                    continue

            if value:
                filled_snapshot.append(f"{label}={value}")
            else:
                missing.append(label)

        invalid_count = await self.page.locator('[aria-invalid="true"]').count()
        invalid_details: list[str] = []
        for i in range(min(invalid_count, 20)):
            try:
                node = self.page.locator('[aria-invalid="true"]').nth(i)
                ident = (
                    await node.get_attribute("id")
                    or await node.get_attribute("name")
                    or await node.get_attribute("aria-label")
                    or f"invalid_field_{i+1}"
                )
                val = (await node.input_value()).strip()
                invalid_details.append(f"{ident}={val}")
            except Exception:
                continue

        if filled_snapshot:
            log("Filled field snapshot:")
            for item in filled_snapshot:
                log(f"  - {item}")

        if missing or invalid_details:
            raise RuntimeError(
                "Pre-save validation failed. "
                f"Missing: {missing or 'none'}; "
                f"Invalid: {invalid_details or 'none'}"
            )

        log("Pre-save validation passed")

    async def _collect_visible_errors(self) -> list[str]:
        error_selectors = [
            '[role="alert"]',
            ".MuiAlert-message",
            ".MuiFormHelperText-root",
            ".Mui-error",
            '[class*="error"]',
            '[aria-invalid="true"]',
        ]
        errors: list[str] = []
        for selector in error_selectors:
            try:
                loc = self.page.locator(selector)
                count = await loc.count()
                for i in range(min(count, 30)):
                    txt = (await loc.nth(i).inner_text()).strip()
                    if not txt:
                        continue
                    low = txt.lower()
                    if any(
                        k in low
                        for k in [
                            "required",
                            "invalid",
                            "error",
                            "failed",
                            "unable",
                            "must",
                            "wallet",
                            "insufficient",
                            "please",
                        ]
                    ):
                        if txt not in errors:
                            errors.append(txt)
            except Exception:
                continue
        return errors

    async def _verify_in_order_list(self, reference_id: str) -> bool:
        log(f"Verifying order in list using reference: {reference_id}")
        from panel_orders import goto_new_orders_domestic, search_new_orders

        await goto_new_orders_domestic(self.page, BASE)
        found = await search_new_orders(self.page, reference_id)
        page_text = (await self.page.inner_text("body")).lower() if found else ""
        if found:
            await self.page.screenshot(
                path=str(OUTPUT_DIR / "order_verified_in_list.png"), full_page=True
            )
            log("Order is present in orders list")
            return True

        await self.page.screenshot(path=str(OUTPUT_DIR / "order_not_found_in_list.png"), full_page=True)
        log("Order not found in orders list")
        return False

    async def save_order(self) -> bool:
        log("Saving order...")
        self.last_save_errors = []
        self.last_save_api_calls = []
        self.last_save_requests = []
        self.last_save_failures = []
        self.last_console_errors = []

        def _track_request(req: Request) -> None:
            try:
                if req.method in {"POST", "PUT", "PATCH"}:
                    self.last_save_requests.append(f"{req.method} {req.url}")
            except Exception:
                return

        def _track_response(resp: Response) -> None:
            try:
                url = resp.url.lower()
                if any(k in url for k in ["order", "shipment", "booking", "save"]):
                    self.last_save_api_calls.append(f"{resp.status} {resp.url}")
            except Exception:
                return

        def _track_failed(req: Request) -> None:
            try:
                self.last_save_failures.append(
                    f"{req.method} {req.url} -> {req.failure or 'failed'}"
                )
            except Exception:
                return

        def _track_console(msg) -> None:
            try:
                if msg.type == "error":
                    self.last_console_errors.append(msg.text)
            except Exception:
                return

        self.page.on("request", _track_request)
        self.page.on("response", _track_response)
        self.page.on("requestfailed", _track_failed)
        self.page.on("console", _track_console)

        save_buttons = self.page.get_by_role(
            "button",
            name=re.compile(r"^\s*Save\s*$", re.IGNORECASE),
        )
        save_count = await save_buttons.count()
        if save_count == 0:
            raise RuntimeError("No Save button found")

        candidate_buttons: list[Locator] = []
        for i in range(save_count):
            btn = save_buttons.nth(i)
            try:
                if not await btn.is_visible():
                    continue
                candidate_buttons.append(btn)
            except Exception:
                continue

        if not candidate_buttons:
            candidate_buttons = [save_buttons.last]

        # Prefer bottom-most Save first, then others.
        button_with_top: list[tuple[float, Locator]] = []
        for btn in candidate_buttons:
            try:
                box = await btn.bounding_box()
                top = box["y"] if box else 0.0
                button_with_top.append((top, btn))
            except Exception:
                button_with_top.append((0.0, btn))
        button_with_top.sort(key=lambda x: x[0], reverse=True)

        save_click_ok = False
        for idx, (_, save_btn) in enumerate(button_with_top):
            await save_btn.scroll_into_view_if_needed()
            btn_disabled = await save_btn.get_attribute("disabled")
            btn_aria_disabled = await save_btn.get_attribute("aria-disabled")
            log(
                f"Trying Save button #{idx + 1}:"
                f" disabled={btn_disabled}, aria-disabled={btn_aria_disabled}"
            )
            try:
                await save_btn.click(timeout=10000)
                await asyncio.sleep(1.8)
                save_click_ok = True
                # If submit fired, at least one write request should appear quickly.
                if self.last_save_requests:
                    break
            except PlaywrightTimeoutError:
                continue
            except Exception:
                continue

        if not save_click_ok:
            # JS fallback to click the bottom-most visible, enabled Save-like button.
            js_result = await self.page.evaluate(
                """
                () => {
                  const isVisible = (el) => {
                    const s = window.getComputedStyle(el);
                    const r = el.getBoundingClientRect();
                    return s.display !== "none" && s.visibility !== "hidden" &&
                           r.width > 0 && r.height > 0;
                  };
                  const textOf = (el) =>
                    (el.innerText || el.textContent || el.value || "").trim();
                  const nodes = Array.from(document.querySelectorAll("button,input[type='submit'],input[type='button']"));
                  const candidates = nodes
                    .map((el) => {
                      const txt = textOf(el);
                      const low = txt.toLowerCase();
                      const rect = el.getBoundingClientRect();
                      const disabled = el.disabled || el.getAttribute("aria-disabled") === "true";
                      return {
                        el, txt, low, top: rect.top, visible: isVisible(el), disabled
                      };
                    })
                    .filter((x) => x.visible && x.low === "save")
                    .sort((a, b) => b.top - a.top);
                  const preferred = candidates.find((x) => !x.disabled) || candidates[0];
                  if (!preferred) return { clicked: false, reason: "no-visible-save" };
                  preferred.el.scrollIntoView({ block: "center" });
                  preferred.el.click();
                  return {
                    clicked: true,
                    text: preferred.txt,
                    top: preferred.top,
                    disabled: preferred.disabled,
                    count: candidates.length
                  };
                }
                """
            )
            log(f"JS Save fallback result: {js_result}")
            save_click_ok = bool(js_result and js_result.get("clicked"))

        # If plain Save does nothing (no write request), try Save & Assign Courier.
        if save_click_ok and not self.last_save_requests:
            assign_buttons = self.page.get_by_role(
                "button",
                name=re.compile(r"^\s*Save\s*&\s*Assign\s*Courier\s*$", re.IGNORECASE),
            )
            assign_count = await assign_buttons.count()
            if assign_count > 0:
                log("No write request after Save. Trying Save & Assign Courier fallback...")
                for i in range(assign_count):
                    btn = assign_buttons.nth(i)
                    try:
                        if not await btn.is_visible():
                            continue
                        await btn.scroll_into_view_if_needed()
                        await btn.click(timeout=10000)
                        await asyncio.sleep(2.0)
                        if self.last_save_requests:
                            break
                    except Exception:
                        continue

        await asyncio.sleep(3)

        for txt in ["Confirm", "Yes", "OK", "Proceed"]:
            try:
                btn = self.page.locator(f'button:has-text("{txt}")').first
                if await btn.count() > 0 and await btn.is_visible():
                    await btn.click(force=True)
                    log(f"Clicked {txt}")
                    break
            except Exception:
                continue

        await asyncio.sleep(2)
        self.last_save_errors = await self._collect_visible_errors()
        self.page.remove_listener("request", _track_request)
        self.page.remove_listener("response", _track_response)
        self.page.remove_listener("requestfailed", _track_failed)
        self.page.remove_listener("console", _track_console)

        await self.page.screenshot(path=str(OUTPUT_DIR / "after_save.png"), full_page=True)
        log(f"URL after save: {self.page.url}")
        if self.last_save_requests:
            log("Write requests seen around Save:")
            for item in self.last_save_requests[:15]:
                log(f"  - {item}")
        if self.last_save_api_calls:
            log("Save-related API calls seen:")
            for item in self.last_save_api_calls[:10]:
                log(f"  - {item}")
        if self.last_save_failures:
            log("Failed requests around Save:")
            for item in self.last_save_failures[:10]:
                log(f"  - {item}")
        if self.last_console_errors:
            log("Console errors around Save:")
            for item in self.last_console_errors[:10]:
                log(f"  - {item}")
        if self.last_save_errors:
            log("UI errors after Save click:")
            for item in self.last_save_errors[:10]:
                log(f"  - {item}")

        return save_click_ok and not self.last_save_errors

    async def run_once(self) -> None:
        await self.start()
        await self.go_add_order()
        await self.fill_buyer_receiver()
        await self.fill_order_details()
        await self.fill_payment_shipping()
        await self.select_warehouse()
        await self.fill_weight_dimensions()
        await self._validate_filled_required_fields()
        save_ok = await self.save_order()
        if not save_ok:
            raise RuntimeError(
                f"Save action failed. Detected errors: {self.last_save_errors or 'none'}"
            )

        verified = await self._verify_in_order_list(REF_ID)
        if not verified:
            raise RuntimeError(
                "Save clicked but order not visible in orders list for reference "
                f"{REF_ID}. Requests: {self.last_save_requests or 'none'}; "
                f"API calls: {self.last_save_api_calls or 'none'}; "
                f"Failed: {self.last_save_failures or 'none'}; "
                f"Console: {self.last_console_errors or 'none'}; "
                f"UI errors: {self.last_save_errors or 'none'}"
            )

    async def run(self) -> bool:
        for attempt in range(MAX_ATTEMPTS):
            try:
                log(f"=== ATTEMPT {attempt + 1}/{MAX_ATTEMPTS} ===")
                await self.run_once()
                print(f"\n*** ORDER CREATED: Ref={REF_ID} ***\n")
                return True
            except Exception:
                traceback.print_exc()
            finally:
                await self.stop()

            if attempt < MAX_ATTEMPTS - 1:
                log("Retrying in 5 seconds...\n")
                await asyncio.sleep(5)

        log("All attempts failed.")
        return False


async def main() -> None:
    success = await ShipmozoOrderBot().run()
    if not success:
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
