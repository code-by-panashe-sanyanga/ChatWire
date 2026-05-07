"""
Simple per-connection rate limits for noisy socket events.

No extra libraries - just timestamps on the session dict.
"""

import time


def allow(info, key, min_interval_seconds):
    """
    Return True if this action is allowed for this session.
    key examples: "message", "typing"
    """
    now = time.monotonic()
    stamps = info.setdefault("_rate", {})
    last = stamps.get(key, 0.0)
    if now - last < min_interval_seconds:
        return False
    stamps[key] = now
    return True
