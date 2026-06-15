import asyncio
import json

from panel_e2e.channel_pages import (
    channel_page_usable,
    navigate_channel_to_target,
    on_channel_page,
)
from panel_navigate import page_looks_like_not_found
from panel_ui_helpers import dismiss_blocking_overlays
from shipmozo_login import async_login_and_save_state


async def main():
    module_name, description = "order channels", "amazon order channel"
    p, browser, _ctx, page = await async_login_and_save_state()
    await dismiss_blocking_overlays(page)
    nav = await navigate_channel_to_target(page, module_name, description)
    print("nav", json.dumps({k: nav[k] for k in ("ok", "strategy", "pageUrl")}, indent=2))
    print("logs", "\n".join(nav.get("logs") or []))
    print("not_found", await page_looks_like_not_found(page))
    print("on_channel", await on_channel_page(page, module_name, description))
    print("usable", await channel_page_usable(page, module_name, description))
    print("url", page.url)
    text = await page.evaluate(
        "() => (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 600)"
    )
    print("text", repr(text[:400]))
    await browser.close()
    await p.stop()


if __name__ == "__main__":
    asyncio.run(main())
