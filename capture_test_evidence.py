"""Capture one panel screenshot as evidence for a test scenario."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from capture_module_screenshots import (
    infer_chat_query_for_test,
    normalize_module_for_test,
    rank_nav_pages,
    save_shot,
    try_direct_urls,
)
from panel_navigate import navigate_for_chat, page_looks_like_not_found
from panel_navigation import load_navigation_map
from shipmozo_login import async_login_and_save_state


async def capture_evidence(
    session_id: str,
    scenario_id: str,
    module_name: str,
    chat_query: str,
    description: str,
) -> dict | None:
    out_dir = Path("output") / "cloud-images" / session_id / "raw"
    out_dir.mkdir(parents=True, exist_ok=True)

    p = browser = context = page = None
    try:
        p, browser, context, page = await async_login_and_save_state()

        module = normalize_module_for_test(module_name, description)
        query = (chat_query or "").strip()

        opened = await try_direct_urls(page, module, description)
        if not opened and query:
            nav = load_navigation_map().get("pages", [])
            ranked = rank_nav_pages(query, description, [])
            if not ranked:
                ranked = rank_nav_pages(module, description, [])
            for nav_page in ranked[:1]:
                reached, _ = await navigate_for_chat(page, nav_page)
                if reached and not await page_looks_like_not_found(page):
                    opened = True
                    break

        if not opened:
            for nav_page in rank_nav_pages(module, description, [])[:1]:
                reached, ready = await navigate_for_chat(page, nav_page)
                if reached and not await page_looks_like_not_found(page):
                    opened = True
                    break

        label = f"Test evidence: {scenario_id}"
        if module:
            label += f" — {module}"
        shot = await save_shot(
            page,
            out_dir,
            f"test_{scenario_id.replace('-', '_').lower()}",
            label,
            1,
            content_ready=opened,
        )
        return shot
    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if p:
            await p.stop()


async def main() -> None:
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "Usage: capture_test_evidence.py <session_id> <scenario_id> [module] [query] [description]"}))
        sys.exit(2)

    session_id = sys.argv[1]
    scenario_id = sys.argv[2]
    module_name = sys.argv[3] if len(sys.argv) > 3 else ""
    chat_query = sys.argv[4] if len(sys.argv) > 4 else ""
    description = sys.argv[5] if len(sys.argv) > 5 else ""

    try:
        shot = await capture_evidence(session_id, scenario_id, module_name, chat_query, description)
        print(json.dumps({"ok": True, "screenshot": shot}))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e), "screenshot": None}))


if __name__ == "__main__":
    asyncio.run(main())
