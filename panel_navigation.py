"""Shared Shipmozo panel navigation map loader (Python)."""

from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
NAV_MAP_PATH = ROOT / "data" / "panel-navigation.json"

from panel_url import default_panel_base

PANEL_BASE = default_panel_base()


def slugify(value: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return s or "page"


def default_navigation_map() -> dict:
    pages = [
        {"text": "Dashboard", "href": f"{PANEL_BASE}/dashboard", "keywords": ["dashboard", "home", "analytics"]},
        {"text": "Order Status", "href": f"{PANEL_BASE}/dashboard/order-status", "keywords": ["order", "status", "dashboard"]},
        {"text": "New Orders", "href": f"{PANEL_BASE}/orders/new", "keywords": ["new", "orders", "order"]},
        {"text": "All Orders", "href": f"{PANEL_BASE}/orders/all", "keywords": ["all", "orders"]},
        {"text": "Scheduled Orders", "href": f"{PANEL_BASE}/orders/scheduled", "keywords": ["scheduled"]},
        {"text": "Courier Assigned", "href": f"{PANEL_BASE}/orders/courier-assigned", "keywords": ["courier", "assigned"]},
        {"text": "Quick Add", "href": f"{PANEL_BASE}/orders/quick-add", "keywords": ["quick", "add", "create", "order"]},
        {"text": "Add Order", "href": f"{PANEL_BASE}/orders/add", "keywords": ["add", "order", "create"]},
        {"text": "Reverse", "href": f"{PANEL_BASE}/orders/reverse", "keywords": ["reverse", "return"]},
        {"text": "Archive Orders", "href": f"{PANEL_BASE}/orders/archive", "keywords": ["archive", "orders"]},
        {"text": "Delivered", "href": f"{PANEL_BASE}/orders/delivered", "keywords": ["delivered", "orders"]},
        {"text": "In Transit", "href": f"{PANEL_BASE}/orders/in-transit", "keywords": ["transit", "orders"]},
        {"text": "Manifests", "href": f"{PANEL_BASE}/orders/manifest", "keywords": ["manifest", "orders"]},
        {"text": "Out For Delivery", "href": f"{PANEL_BASE}/orders/out-for-delivery", "keywords": ["delivery", "orders"]},
        {"text": "Pickups & Manifests", "href": f"{PANEL_BASE}/orders/pickup", "keywords": ["pickup", "manifest", "orders"]},
        {"text": "RTO In Transit", "href": f"{PANEL_BASE}/orders/rto", "keywords": ["rto", "orders"]},
        {"text": "RTO Delivered", "href": f"{PANEL_BASE}/orders/rto-delivered", "keywords": ["rto", "delivered", "orders"]},
        {"text": "NDR", "href": f"{PANEL_BASE}/ndr", "keywords": ["ndr", "delivery", "non"]},
        {"text": "NDR Shipments", "href": f"{PANEL_BASE}/shipments/ndr", "keywords": ["ndr", "shipments"]},
        {"text": "Billing", "href": f"{PANEL_BASE}/billing", "keywords": ["billing", "invoice", "payment"]},
        {"text": "Billing Passbook", "href": f"{PANEL_BASE}/billing/passbook", "keywords": ["billing", "passbook", "wallet"]},
        {"text": "COD Remittance", "href": f"{PANEL_BASE}/billing/cod-remittance", "keywords": ["cod", "remittance", "billing"]},
        {"text": "Shipping Charges", "href": f"{PANEL_BASE}/billing/shipping-charges", "keywords": ["shipping", "charges", "billing"]},
        {"text": "All Recharges", "href": f"{PANEL_BASE}/billing/all-recharges", "keywords": ["recharge", "billing", "wallet"]},
        {"text": "Invoices", "href": f"{PANEL_BASE}/billing/invoices", "keywords": ["invoices", "billing"]},
        {"text": "Credit Notes", "href": f"{PANEL_BASE}/billing/credit-notes", "keywords": ["credit", "notes", "billing"]},
        {"text": "Ledgers", "href": f"{PANEL_BASE}/billing/ledgers", "keywords": ["ledgers", "billing"]},
        {"text": "Wallet", "href": f"{PANEL_BASE}/wallet", "keywords": ["wallet", "recharge", "balance"]},
        {"text": "Finance", "href": f"{PANEL_BASE}/finance", "keywords": ["finance", "billing"]},
        {"text": "Channels", "href": f"{PANEL_BASE}/channels", "keywords": ["channels", "channel"]},
        {"text": "Integrations", "href": f"{PANEL_BASE}/integrations", "keywords": ["integrations", "integration"]},
        {"text": "Shopify", "href": f"{PANEL_BASE}/channels/shopify", "keywords": ["shopify", "store"]},
        {"text": "WooCommerce", "href": f"{PANEL_BASE}/channels/woocommerce", "keywords": ["woocommerce"]},
        {"text": "Settings", "href": f"{PANEL_BASE}/settings", "keywords": ["settings", "account", "profile"]},
        {"text": "Shipping Notifications", "href": f"{PANEL_BASE}/settings/shipping-notification", "keywords": ["notification", "settings", "shipping"]},
        {"text": "Profile", "href": f"{PANEL_BASE}/profile", "keywords": ["profile"]},
        {"text": "Warehouse", "href": f"{PANEL_BASE}/warehouse", "keywords": ["warehouse", "inventory"]},
        {"text": "Catalog", "href": f"{PANEL_BASE}/catalog", "keywords": ["catalog", "product"]},
        {"text": "Reports", "href": f"{PANEL_BASE}/reports", "keywords": ["reports", "analytics"]},
        {"text": "Tickets", "href": f"{PANEL_BASE}/tickets", "keywords": ["tickets", "support"]},
        {
            "text": "Rate Calculator",
            "href": f"{PANEL_BASE}/courier/rate-calculator",
            "keywords": ["rate", "calculator", "courier", "shipping", "freight", "charges"],
        },
        {
            "text": "Manage Courier",
            "href": f"{PANEL_BASE}/courier/manage-courier",
            "keywords": ["courier", "manage", "rate", "calculator"],
        },
    ]
    return {
        "version": 1,
        "baseUrl": PANEL_BASE,
        "source": "default",
        "pageCount": len(pages),
        "pages": pages,
    }


def load_navigation_map() -> dict:
    if NAV_MAP_PATH.exists():
        try:
            data = json.loads(NAV_MAP_PATH.read_text(encoding="utf-8"))
            if data.get("pages"):
                return data
        except Exception:
            pass
    return default_navigation_map()


def save_navigation_map(data: dict) -> None:
    NAV_MAP_PATH.parent.mkdir(parents=True, exist_ok=True)
    data["pageCount"] = len(data.get("pages", []))
    NAV_MAP_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")


def merge_page_lists(*lists: list[dict]) -> list[dict]:
    seen: set[str] = set()
    out: list[dict] = []
    for pages in lists:
        for p in pages:
            href = p.get("href", "")
            if not href or href in seen:
                continue
            seen.add(href)
            out.append(p)
    return out


def keywords_for_page(text: str, href: str) -> list[str]:
    parts = re.findall(r"[a-z0-9]+", f"{text} {href}".lower())
    stop = {"https", "http", "panel", "appiify", "shipmozo", "com", "www"}
    return sorted({p for p in parts if len(p) > 2 and p not in stop})


# Dynamic table rows / AWB links mistaken for nav during crawl.
ORDER_ID_LABEL_RE = re.compile(
    r"^(?:269[A-Z]{2}\d+|269SM\w+|DL\d+[A-Z0-9]+|[A-Z]{2,}\d{5,}[A-Z0-9]*)$",
    re.I,
)
COUNT_BADGE_RE = re.compile(r"\s+\d+$")

# Prefer stable module names for known routes (over sidebar tab labels with counts).
PATH_LABEL_OVERRIDES: dict[str, str] = {
    "/": "Analytics",
    "/orders/all": "All Orders",
    "/orders/archive": "Archive Orders",
    "/orders/courier-assigned": "Courier Assigned",
    "/orders/delivered": "Delivered",
    "/orders/in-transit": "In Transit",
    "/orders/manifest": "Manifests",
    "/orders/ndr": "NDR Orders",
    "/orders/new": "New Orders",
    "/orders/out-for-delivery": "Out For Delivery",
    "/orders/pickup": "Pickups & Manifests",
    "/orders/returns/all": "All Returns",
    "/orders/returns/in-transit": "Returns In Transit",
    "/orders/returns/new": "New Returns",
    "/orders/returns/pick-up-scheduled": "Pick-up Scheduled",
    "/orders/returns/refunds": "Refunds",
    "/orders/returns/return-accepted": "Return Accepted",
    "/orders/rto": "RTO In Transit",
    "/orders/rto-delivered": "RTO Delivered",
    "/billing/passbook": "Billing Passbook",
    "/settings/shipping-notification": "Shipping Notifications",
    "/warehouse/add": "Add Warehouse",
    "/returns/add": "Add Return",
    "/shipments/ndr": "NDR Shipments",
    "/shipments/ndr-delivered": "NDR Delivered",
    "/shipments/ndr-wrong-info": "NDR Wrong Address/Phone",
    "/shipments/rto": "RTO Shipments",
    "/shipments/rto-delivered": "RTO Delivered",
}


def nav_path_key(href: str) -> str:
    parsed = urlparse(href)
    return parsed.path or "/"


def is_junk_nav_href(href: str) -> bool:
    if not href:
        return True
    path = nav_path_key(href).lower()
    query = (urlparse(href).query or "").lower()
    if re.search(r"/orders/details/\d+", path):
        return True
    if path.startswith("/tools/track-order") or "awb=" in query:
        return True
    if re.search(r"/tickets/[^/]+", path) and path != "/tickets":
        return True
    return False


def looks_like_dynamic_id(text: str) -> bool:
    t = re.sub(r"\s+", " ", text.strip())
    if not t:
        return False
    if ORDER_ID_LABEL_RE.match(t):
        return True
    if len(t) >= 12 and re.fullmatch(r"[A-Z0-9]+", t, re.I) and re.search(r"\d", t):
        return True
    return False


def is_junk_nav_label(text: str) -> bool:
    t = re.sub(r"\s+", " ", text.strip())
    if not t or len(t) > 100:
        return True
    if re.fullmatch(r"[\d₹$.,\s:+-]+", t):
        return True
    if re.search(r"notification credits:\s*\d+", t, re.I):
        return True
    if looks_like_dynamic_id(t):
        return True
    if t.lower() in {"view all", "add new", "forward"}:
        return True
    return False


def clean_nav_label(text: str, href: str) -> str:
    path = nav_path_key(href)
    if path in PATH_LABEL_OVERRIDES:
        return PATH_LABEL_OVERRIDES[path]

    t = re.sub(r"\s+", " ", text.strip())
    t = COUNT_BADGE_RE.sub("", t).strip()
    if is_junk_nav_label(t) or looks_like_dynamic_id(t):
        slug = path.strip("/").split("/")[-1] if path != "/" else "home"
        t = slug.replace("-", " ").title() or "Page"
    return t or "Page"


def filter_navigation_pages(pages: list[dict]) -> list[dict]:
    """Drop dynamic detail links and normalize sidebar tab labels."""
    seed_by_path = {nav_path_key(p["href"]): p for p in default_navigation_map()["pages"]}
    by_href: dict[str, dict] = {}

    for raw in pages:
        href = raw.get("href", "")
        if not href or is_junk_nav_href(href):
            continue

        path = nav_path_key(href)
        seed = seed_by_path.get(path)
        text = clean_nav_label(raw.get("text", ""), href)
        if seed and (is_junk_nav_label(text) or COUNT_BADGE_RE.search(raw.get("text", ""))):
            text = seed["text"]

        entry = {
            "text": text,
            "href": href,
            "path": path if path != "/" else "/",
            "keywords": sorted(
                set((seed or {}).get("keywords", []) + keywords_for_page(text, href))
            ),
        }

        prev = by_href.get(href)
        if not prev or len(entry["text"]) > len(prev["text"]):
            by_href[href] = entry

    merged = merge_page_lists(list(by_href.values()), default_navigation_map()["pages"])
    cleaned = []
    for page in merged:
        href = page.get("href", "")
        if is_junk_nav_href(href):
            continue
        cleaned.append(
            {
                "text": clean_nav_label(page.get("text", ""), href),
                "href": href,
                "path": nav_path_key(href) if nav_path_key(href) != "/" else "/",
                "keywords": page.get("keywords") or keywords_for_page(page.get("text", ""), href),
            }
        )

    return sorted(cleaned, key=lambda p: p.get("path") or p.get("href", ""))


def normalize_page_entry(text: str, href: str) -> dict | None:
    if is_junk_nav_href(href):
        return None
    text = clean_nav_label(text, href)
    if looks_like_dynamic_id(text):
        return None
    path = nav_path_key(href)
    return {
        "text": text or "Page",
        "href": href,
        "path": path if path != "/" else "/",
        "keywords": keywords_for_page(text, href),
    }


def merge_navigation_maps(crawled: dict, *, keep_source: str = "merged") -> dict:
    """Merge live crawl with default seed; never drop seed routes."""
    seed_pages = default_navigation_map()["pages"]
    existing = load_navigation_map().get("pages", []) if NAV_MAP_PATH.exists() else []
    merged = merge_page_lists(crawled.get("pages", []), seed_pages, existing)

    by_href: dict[str, dict] = {}
    for page in merged:
        href = page.get("href", "")
        if not href:
            continue
        prev = by_href.get(href)
        if not prev or len(page.get("text", "")) > len(prev.get("text", "")):
            by_href[href] = page

    pages = filter_navigation_pages(list(by_href.values()))
    return {
        "version": 1,
        "baseUrl": crawled.get("baseUrl", PANEL_BASE),
        "source": keep_source,
        "discoveredAt": crawled.get("discoveredAt"),
        "crawledUrls": crawled.get("crawledUrls"),
        "pageCount": len(pages),
        "pages": pages,
    }


def clean_navigation_map_file() -> dict:
    """One-off clean of data/panel-navigation.json without re-crawl."""
    current = load_navigation_map()
    cleaned_pages = filter_navigation_pages(current.get("pages", []))
    data = {
        **current,
        "source": "cleaned",
        "pageCount": len(cleaned_pages),
        "pages": cleaned_pages,
    }
    save_navigation_map(data)
    return data


def score_page_for_module(module_name: str, description: str, nav_page: dict) -> int:
    """Score a nav-map entry against a target module (higher = better match)."""
    from panel_doc_module import (
        is_add_order_target,
        is_new_orders_target,
        is_rate_calculator_target,
        resolve_doc_module,
    )

    canonical = resolve_doc_module(module_name, description)
    key = f"{canonical} {module_name} {description}".lower()
    parts = [p for p in re.split(r"[^a-z0-9]+", key) if len(p) >= 3]
    nav_text = nav_page.get("text", "").lower()
    nav_path = (nav_page.get("path") or nav_path_key(nav_page.get("href", ""))).lower()
    hay = " ".join(
        [
            nav_page.get("text", ""),
            nav_page.get("href", ""),
            nav_page.get("path", ""),
            " ".join(nav_page.get("keywords", [])),
        ]
    ).lower()
    score = 0
    for part in parts:
        if part in hay:
            score += 2
        if nav_path and part in nav_path.replace("/", " "):
            score += 3
    name_key = canonical.lower().strip()
    if name_key and name_key in hay:
        score += 4
    if name_key and name_key == nav_text:
        score += 8

    if is_rate_calculator_target(module_name, description):
        if "rate" in nav_text and "calcul" in nav_text:
            score += 12
        elif "calcul" in hay and "calcul" in nav_text:
            score += 8
        if "manage-courier" in nav_path:
            score -= 20

    if is_add_order_target(module_name, description):
        if "/orders/add" in nav_path:
            score += 15
        if "add order" in nav_text:
            score += 10
        if "/orders/new" in nav_path and "/orders/add" not in nav_path:
            score -= 12

    if is_new_orders_target(module_name, description):
        if "/orders/new" in nav_path:
            score += 12
        if "/orders/add" in nav_path:
            score -= 10

    return score


def rank_pages_for_module(
    module_name: str,
    description: str = "",
    discovered: list[dict] | None = None,
) -> list[dict]:
    """Rank panel-navigation.json (+ optional live sidebar links) for a module."""
    seed = load_navigation_map().get("pages", [])
    scored: list[tuple[int, dict]] = []
    for nav_page in merge_page_lists(discovered or [], seed):
        if is_junk_nav_label(nav_page.get("text", "")):
            continue
        if is_junk_nav_href(nav_page.get("href", "")):
            continue
        score = score_page_for_module(module_name, description, nav_page)
        if score > 0:
            scored.append((score, nav_page))
    scored.sort(key=lambda x: (-x[0], x[1].get("text", "")))
    seen: set[str] = set()
    ranked: list[dict] = []
    for _, nav_page in scored:
        href = nav_page.get("href", "")
        if not href or href in seen:
            continue
        seen.add(href)
        ranked.append(nav_page)
    return ranked


def top_nav_map_urls(module_name: str, description: str = "", limit: int = 4) -> list[str]:
    return [p.get("href", "") for p in rank_pages_for_module(module_name, description)[:limit] if p.get("href")]
