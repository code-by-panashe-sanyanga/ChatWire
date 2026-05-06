"""
Small helpers to check socket/HTTP payloads.

Plain Python only - no Pydantic. Returns (ok, value_or_error).
"""


def require_str(data, key, min_len=1, max_len=2000):
    if not isinstance(data, dict):
        return False, "invalid payload"
    value = data.get(key)
    if value is None:
        return False, f"{key} is required"
    text = str(value).strip()
    if len(text) < min_len:
        return False, f"{key} is too short"
    if len(text) > max_len:
        return False, f"{key} is too long"
    return True, text


def optional_str(data, key, max_len=100):
    if not isinstance(data, dict):
        return True, None
    value = data.get(key)
    if value is None or value == "":
        return True, None
    text = str(value).strip()
    if len(text) > max_len:
        return False, f"{key} is too long"
    return True, text or None
