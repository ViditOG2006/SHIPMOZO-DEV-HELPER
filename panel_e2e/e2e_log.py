"""Structured stderr logging for E2E / heal scripts (stdout stays JSON)."""

from __future__ import annotations

import sys


def e2e_log(tag: str, message: str) -> None:
    print(f"[{tag}] {message}", file=sys.stderr, flush=True)
