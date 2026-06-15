"""Resolve doc-generation module names from user input (typos, aliases)."""

from __future__ import annotations

import os
import re

RATE_CALCULATOR_CANONICAL = "Rate Calculator"

_RATE_CALC_PATTERNS = (
    r"rate\s*calcul",
    r"raet\s*calcul",
    r"rat\s*calcul",
    r"\bcalculat",
)

MODULE_ALIASES: dict[str, str] = {
    "/orders/add": "Add Order",
    "/orders/new": "New Orders",
    "/orders/all": "All Orders",
    "/integrations": "Integrations",
    "/channels": "Integrations",
    "/channels/shopify": "Shopify",
    "/channels/amazon": "Amazon",
    "/billing": "Billing",
    "rate calculator": RATE_CALCULATOR_CANONICAL,
    "rate-calculator": RATE_CALCULATOR_CANONICAL,
    "rate_calculator": RATE_CALCULATOR_CANONICAL,
    "raet calculator": RATE_CALCULATOR_CANONICAL,
    "orders/add": "Add Order",
    "orders/new": "New Orders",
    "add order": "Add Order",
    "create order": "Add Order",
    "new orders": "New Orders",
    "new order": "New Orders",
    "order channels": "Integrations",
    "order channel": "Integrations",
    "channels": "Integrations",
    "channel": "Integrations",
    "quick add": "Quick Add",
    "quick-add": "Quick Add",
}


def _haystack(module_name: str, description: str = "") -> str:
    return f"{module_name} {description}".lower().strip()


def is_channel_target(module_name: str, description: str = "") -> bool:
    hay = _haystack(module_name, description)
    return any(
        token in hay
        for token in (
            "shopify",
            "integration",
            "integrations",
            "channel",
            "channels",
            "woocommerce",
            "amazon",
        )
    )


def is_shopify_target(module_name: str, description: str = "") -> bool:
    return "shopify" in _haystack(module_name, description)


def is_amazon_target(module_name: str, description: str = "") -> bool:
    return "amazon" in _haystack(module_name, description)


def is_specific_channel_target(module_name: str, description: str = "") -> bool:
    """Amazon/Shopify/etc. — navigate via Order Channels hub, not direct QS."""
    return is_amazon_target(module_name, description) or is_shopify_target(module_name, description)


def channel_hub_quick_search_module(module_name: str, description: str = "") -> str:
    """Module label for Ctrl+B — always the channels hub, never a channel name."""
    raw = (module_name or "").strip().lower()
    if raw in ("order channels", "order channel", "channels", "channel", "integrations", "integration"):
        return module_name.strip() or "order channels"
    if is_specific_channel_target(module_name, description):
        return "order channels"
    return module_name.strip() or "order channels"


def docs_capture_allow_direct_urls() -> bool:
    """When false (default in fast capture), navigate via Ctrl+B Quick Search only."""
    raw = os.getenv("DOCS_CAPTURE_ALLOW_DIRECT_URL", "").strip().lower()
    if raw in ("1", "true", "yes"):
        return True
    if raw in ("0", "false", "no"):
        return False
    fast = os.getenv("DOCS_CAPTURE_FAST", "1").lower() in {"1", "true", "yes"}
    return not fast


def docs_capture_allow_order_form_url() -> bool:
    """Allow /orders/add direct navigation when QS lands on the wrong orders page."""
    raw = os.getenv("DOCS_CAPTURE_ALLOW_ORDER_ADD_URL", "true").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def docs_capture_use_nav_map() -> bool:
    """Fall back to data/panel-navigation.json when Quick Search fails."""
    raw = os.getenv("DOCS_CAPTURE_USE_NAV_MAP", "true").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def docs_capture_allow_nav_map_url() -> bool:
    """Allow direct goto of href from panel-navigation.json (trusted routes)."""
    raw = os.getenv("DOCS_CAPTURE_ALLOW_NAV_MAP_URL", "true").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def is_new_orders_target(module_name: str, description: str = "") -> bool:
    hay = _haystack(module_name, description)
    if "add order" in hay or "create order" in hay or "orders/add" in hay:
        return False
    if "quick add" in hay or "quick-add" in hay:
        return False
    return any(
        token in hay
        for token in (
            "new orders",
            "new order",
            "/orders/new",
            "orders/new",
            "verify order",
            "order list",
        )
    )


def is_quick_add_target(module_name: str, description: str = "") -> bool:
    hay = _haystack(module_name, description)
    return any(token in hay for token in ("quick add", "quick-add", "orders/quick-add", "/orders/quick-add"))


def is_add_order_target(module_name: str, description: str = "") -> bool:
    hay = _haystack(module_name, description)
    if is_new_orders_target(module_name, description):
        return False
    if is_quick_add_target(module_name, description):
        return True
    return any(
        token in hay
        for token in (
            "add order",
            "create order",
            "place order",
            "orders/add",
            "/orders/add",
            "order form",
            "fill order",
        )
    ) or ("add" in hay and "order" in hay and "channel" not in hay)


def is_rate_calculator_target(module_name: str, description: str = "") -> bool:
    hay = _haystack(module_name, description)
    if any(re.search(pat, hay) for pat in _RATE_CALC_PATTERNS):
        return True
    if "calcul" in hay and any(
        token in hay for token in ("rate", "raet", "courier", "shipping", "freight", "tools")
    ):
        return True
    mod = (module_name or "").lower().strip()
    if mod in ("rate calculator", "rate-calculator", "rate_calculator"):
        return True
    if mod in ("tools", "tool"):
        return True
    if mod in ("courier", "couriers") and "calcul" in hay:
        return True
    return False


def resolve_doc_module(module_name: str, description: str = "") -> str:
    """Map free-text module + notes to a canonical panel module name."""
    if is_rate_calculator_target(module_name, description):
        return RATE_CALCULATOR_CANONICAL

    if is_quick_add_target(module_name, description):
        return "Quick Add"
    if is_add_order_target(module_name, description):
        return "Add Order"
    if is_new_orders_target(module_name, description):
        return "New Orders"

    hay = _haystack(module_name, description)
    if "shopify" in hay:
        return "Shopify"
    if "amazon" in hay:
        return "Amazon"

    raw = (module_name or "").strip()
    key = raw.lower()
    if key in MODULE_ALIASES:
        alias = MODULE_ALIASES[key]
        if alias == "Integrations" and "amazon" in hay:
            return "Amazon"
        if alias == "Integrations" and "shopify" in hay:
            return "Shopify"
        return alias

    if not raw and description:
        low = description.lower()
        if "shopify" in low:
            return "Shopify"
        if "amazon" in low:
            return "Amazon"
        if "integration" in low or "channel" in low:
            return "Integrations"
        if "billing" in low:
            return "Billing"
        if "add" in low and "order" in low:
            return "Add Order"
        if "order" in low:
            return "New Orders"

    if not raw:
        return "New Orders"

    if raw in MODULE_ALIASES:
        return MODULE_ALIASES[raw]
    if raw.startswith("/"):
        slug = raw.strip("/").split("/")[-1]
        return slug.replace("-", " ").title() or "New Orders"
    return raw
