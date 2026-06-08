#!/usr/bin/env python
"""Clean junk from data/panel-navigation.json without re-crawling the panel."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from panel_navigation import NAV_MAP_PATH, clean_navigation_map_file


def main() -> None:
    data = clean_navigation_map_file()
    print(f"Cleaned navigation map: {data['pageCount']} pages -> {NAV_MAP_PATH}")
    print(json.dumps({"ok": True, "pageCount": data["pageCount"], "source": data.get("source")}))


if __name__ == "__main__":
    main()
