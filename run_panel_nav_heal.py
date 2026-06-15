"""Discover & save the fastest navigation script to Rate Calculator."""

from __future__ import annotations

import asyncio
import json
import sys

from panel_e2e.nav_heal import heal_rate_calculator_nav
from shipmozo_login import async_login_and_save_state


async def main() -> None:
    force = "--force" in sys.argv
    run_id = ""
    for arg in sys.argv[1:]:
        if arg.startswith("--run-id="):
            run_id = arg.split("=", 1)[1].strip()
    if run_id:
        import os

        os.environ["HEAL_PROGRESS_RUN_ID"] = run_id

    p = browser = context = page = None
    try:
        p, browser, context, page = await async_login_and_save_state()
        result = await heal_rate_calculator_nav(page, force=force)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc), "attempts": []}))
    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if p:
            await p.stop()


if __name__ == "__main__":
    asyncio.run(main())
