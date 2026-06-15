"""Resolve Shipmozo panel host from env or live browser session."""

from __future__ import annotations

import os
from urllib.parse import urlparse, urlunparse

from playwright.async_api import Page

DEFAULT_PANEL_HOSTS = (
    "https://panel.appiify.com",
    "https://panel.appify.com",
    "https://panel.shipmozo.com",
)

RATE_CALCULATOR_PATHS = (
    "/courier/rate-calculator",
    "/couriers/rate-calculator",
    "/tools/rate-calculator",
)


def default_panel_base() -> str:
    env = os.getenv("SHIPMOZO_PANEL_URL", "").strip().rstrip("/")
    if env:
        return env
    return DEFAULT_PANEL_HOSTS[0]


def login_urls() -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for candidate in (os.getenv("SHIPMOZO_PANEL_URL", "").strip().rstrip("/"), *DEFAULT_PANEL_HOSTS):
        if candidate and candidate not in seen:
            seen.add(candidate)
            out.append(candidate)
    return out


def panel_origin_from_url(url: str) -> str:
    parsed = urlparse(url or "")
    if parsed.scheme and parsed.netloc and "panel." in parsed.netloc:
        return f"{parsed.scheme}://{parsed.netloc}".rstrip("/")
    return default_panel_base()


async def panel_origin(page: Page) -> str:
    try:
        return panel_origin_from_url(page.url)
    except Exception:
        return default_panel_base()


def rewrite_href(href: str, origin: str) -> str:
    if not href:
        return href
    parsed = urlparse(href)
    base = urlparse(origin)
    if not parsed.path:
        return origin.rstrip("/")
    return urlunparse((base.scheme, base.netloc, parsed.path, parsed.params, parsed.query, parsed.fragment))


def rate_calculator_urls(origin: str) -> list[str]:
    base = origin.rstrip("/")
    return [f"{base}{path}" for path in RATE_CALCULATOR_PATHS]
