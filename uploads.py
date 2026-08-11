"""
Save device photo uploads under data/uploads/ and return a public /uploads/ path.
"""

from __future__ import annotations

import uuid
from pathlib import Path

from werkzeug.datastructures import FileStorage
from werkzeug.utils import secure_filename

import db

UPLOAD_DIR = db.DATA_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
ALLOWED_MIME = {
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
}
MAX_BYTES = 5 * 1024 * 1024


def is_allowed_media_url(url: str) -> bool:
    value = (url or "").strip()
    if not value:
        return False
    if value.startswith("http://") or value.startswith("https://"):
        return True
    if value.startswith("/uploads/") and ".." not in value and "/" not in value[9:]:
        name = value[9:]
        return bool(name) and Path(name).suffix.lower() in ALLOWED_EXT
    return False


def save_image(file_storage: FileStorage):
    if file_storage is None or not getattr(file_storage, "filename", None):
        return None, "choose a photo from your device"
    raw_name = secure_filename(file_storage.filename or "")
    if not raw_name:
        return None, "invalid file name"
    ext = Path(raw_name).suffix.lower()
    if ext not in ALLOWED_EXT:
        return None, "use a jpg, png, gif, or webp image"
    mime = (file_storage.mimetype or "").lower()
    if mime and mime not in ALLOWED_MIME:
        return None, "that file type is not allowed"

    data = file_storage.read()
    if not data:
        return None, "file is empty"
    if len(data) > MAX_BYTES:
        return None, "image must be 5 MB or smaller"

    name = f"{uuid.uuid4().hex}{ext}"
    path = UPLOAD_DIR / name
    path.write_bytes(data)
    return f"/uploads/{name}", None
