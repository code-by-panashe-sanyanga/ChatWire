"""
Live chat messages: send, edit, react, typing, load older.
"""

from flask import request
from flask_socketio import emit

import db
import state
import throttle
from validate import require_str, optional_str


def register(socketio):
    @socketio.on("message")
    def on_message(data):
        info = state.sessions.get(request.sid)
        if not info:
            return

        # about 4 messages per second max per connection
        if not throttle.allow(info, "message", 0.25):
            emit("message_error", {"error": "Slow down a bit, too many messages"})
            return

        data = data or {}
        text = (data.get("text") or "").strip()
        ok_img, image_url = optional_str(data, "image_url", max_len=500)
        if not ok_img:
            emit("message_error", {"error": image_url})
            return
        image_url = (image_url or "").strip()
        if image_url:
            import uploads as upload_mod

            if not upload_mod.is_allowed_media_url(image_url):
                emit("message_error", {"error": "invalid image"})
                return
        if not text and not image_url:
            emit("message_error", {"error": "write a message or attach a photo"})
            return
        if text and len(text) > 2000:
            emit("message_error", {"error": "message is too long"})
            return

        msg = state.store_message(
            info["room"], info["username"], info["user"], text, image_url=image_url
        )
        emit("message", msg, room=info["room"])

        # sender is caught up; everyone else gets refreshed unread counts
        db.mark_channel_read(
            info["username"], info["community"], info["channel"], msg["id"]
        )
        emit("unreads", db.unread_summary(info["username"]))
        for sid, sess in list(state.sessions.items()):
            if sid == request.sid:
                continue
            if sess["room"] == info["room"]:
                db.mark_channel_read(
                    sess["username"], sess["community"], sess["channel"], msg["id"]
                )
            socketio.emit(
                "unreads", db.unread_summary(sess["username"]), to=sid
            )

    @socketio.on("edit_message")
    def on_edit_message(data):
        info = state.sessions.get(request.sid)
        if not info:
            return

        data = data or {}
        try:
            msg_id = int(data.get("id"))
        except (TypeError, ValueError):
            emit("edit_error", {"error": "invalid message id"})
            return

        ok, text = require_str(data, "text", min_len=1, max_len=2000)
        if not ok:
            emit("edit_error", {"error": text})
            return

        msg = db.edit_message(msg_id, info["username"], text, state.utc_now())
        if msg is None:
            emit("edit_error", {"error": "you can only edit your own messages"})
            return
        emit("message_edited", msg, room=info["room"])

    @socketio.on("react_message")
    def on_react_message(data):
        info = state.sessions.get(request.sid)
        if not info:
            return

        if not throttle.allow(info, "react", 0.15):
            return

        data = data or {}
        try:
            msg_id = int(data.get("id"))
        except (TypeError, ValueError):
            emit("react_error", {"error": "invalid message id"})
            return

        ok, emoji = require_str(data, "emoji", min_len=1, max_len=16)
        if not ok:
            emit("react_error", {"error": emoji})
            return

        msg = db.toggle_reaction(msg_id, emoji, info["username"])
        if msg is None:
            emit("react_error", {"error": "message not found"})
            return
        emit("message_reacted", msg, room=info["room"])

    @socketio.on("typing")
    def on_typing(data):
        info = state.sessions.get(request.sid)
        if not info:
            return

        # typing events are noisy; throttle hard
        if not throttle.allow(info, "typing", 0.5):
            return

        typing = bool((data or {}).get("typing"))
        emit(
            "typing",
            {"user": info["user"], "typing": typing},
            room=info["room"],
            include_self=False,
        )
