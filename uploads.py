"""
Save device photo/video uploads under data/uploads/ and return a public /uploads/ path.
"""

from __future__ import annotations

import uuid
from pathlib import Path

from werkzeug.datastructures import FileStorage
from werkzeug.utils import secure_filename

import db

UPLOAD_DIR = db.DATA_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
ALLOWED_VIDEO_EXT = {".mp4", ".webm", ".mov"}
ALLOWED_EXT = ALLOWED_IMAGE_EXT | ALLOWED_VIDEO_EXT

ALLOWED_IMAGE_MIME = {
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
}
ALLOWED_VIDEO_MIME = {
    "video/mp4",
    "video/webm",
    "video/quicktime",
}
ALLOWED_MIME = ALLOWED_IMAGE_MIME | ALLOWED_VIDEO_MIME

MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_VIDEO_BYTES = 25 * 1024 * 1024
# backwards-compatible alias (images)
MAX_BYTES = MAX_IMAGE_BYTES


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


def _save_bytes(ext: str, data: bytes):
    name = f"{uuid.uuid4().hex}{ext}"
    path = UPLOAD_DIR / name
    path.write_bytes(data)
    return f"/uploads/{name}"


def save_image(file_storage: FileStorage):
    if file_storage is None or not getattr(file_storage, "filename", None):
        return None, "choose a photo from your device"
    raw_name = secure_filename(file_storage.filename or "")
    if not raw_name:
        return None, "invalid file name"
    ext = Path(raw_name).suffix.lower()
    if ext not in ALLOWED_IMAGE_EXT:
        return None, "use a jpg, png, gif, or webp image"
    mime = (file_storage.mimetype or "").lower()
    if mime and mime not in ALLOWED_IMAGE_MIME:
        return None, "that file type is not allowed"

    data = file_storage.read()
    if not data:
        return None, "file is empty"
    if len(data) > MAX_IMAGE_BYTES:
        return None, "image must be 5 MB or smaller"

    return _save_bytes(ext, data), None


def save_video(file_storage: FileStorage):
    if file_storage is None or not getattr(file_storage, "filename", None):
        return None, "choose a short video from your device"
    raw_name = secure_filename(file_storage.filename or "")
    if not raw_name:
        return None, "invalid file name"
    ext = Path(raw_name).suffix.lower()
    if ext not in ALLOWED_VIDEO_EXT:
        return None, "use an mp4, webm, or mov video"
    mime = (file_storage.mimetype or "").lower()
    if mime and mime not in ALLOWED_VIDEO_MIME:
        return None, "that file type is not allowed"

    data = file_storage.read()
    if not data:
        return None, "file is empty"
    if len(data) > MAX_VIDEO_BYTES:
        return None, "video must be 25 MB or smaller"

    return _save_bytes(ext, data), None


def save_upload(file_storage: FileStorage):
    """Route image vs short video (Clips) by extension/mime."""
    if file_storage is None or not getattr(file_storage, "filename", None):
        return None, "choose a photo or short video"
    raw_name = secure_filename(file_storage.filename or "")
    if not raw_name:
        return None, "invalid file name"
    ext = Path(raw_name).suffix.lower()
    if ext in ALLOWED_VIDEO_EXT:
        return save_video(file_storage)
    if ext in ALLOWED_IMAGE_EXT:
        return save_image(file_storage)
    return None, "use a jpg/png/gif/webp image or mp4/webm/mov video"
