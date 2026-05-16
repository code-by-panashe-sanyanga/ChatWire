"""
Timeline / feed socket handlers.

Separate from chat so the message handlers stay readable.
Feed is friends-only (you + people you've added).
"""

from flask import request
from flask_socketio import emit

import db
import state
import throttle
from validate import require_str, optional_str


def register(socketio):
    @socketio.on("feed_load")
    def on_feed_load(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        before_id = None
        # optional cursor for loading older posts
        if isinstance(data, dict) and data.get("before_id") is not None:
            try:
                before_id = int(data["before_id"])
            except (TypeError, ValueError):
                before_id = None
        payload = db.list_feed(info["username"], limit=20, before_id=before_id)
        emit("feed", payload)

    @socketio.on("post_create")
    def on_post_create(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        if not throttle.allow(info, "post_create", 1.0):
            emit("feed_error", {"error": "Slow down a bit"})
            return
        data = data or {}
        ok, text = optional_str(data, "text", max_len=280)
        if not ok:
            emit("feed_error", {"error": text})
            return
        ok, image_url = optional_str(data, "image_url", max_len=500)
        if not ok:
            emit("feed_error", {"error": image_url})
            return

        post, err = db.create_post(
            info["username"],
            info["user"],
            text or "",
            image_url or "",
        )
        if err:
            emit("feed_error", {"error": err})
            return

        # only push to the author + online friends (not the whole server)
        targets = {info["username"]}
        for friend in db.list_friends(info["username"]):
            targets.add(friend["username"])
        for sid, sess in list(state.sessions.items()):
            if sess["username"] in targets:
                socketio.emit("post_created", post, to=sid)

    @socketio.on("post_like")
    def on_post_like(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        if not throttle.allow(info, "post_like", 0.3):
            return
        try:
            post_id = int((data or {}).get("id"))
        except (TypeError, ValueError):
            emit("feed_error", {"error": "invalid post id"})
            return
        post = db.toggle_post_like(post_id, info["username"])
        if post is None:
            emit("feed_error", {"error": "post not found"})
            return
        # rebuild per viewer so "liked by me" is correct for each tab
        for sid, sess in list(state.sessions.items()):
            viewed = db.get_post(post_id, sess["username"])
            if viewed:
                socketio.emit("post_updated", viewed, to=sid)

    @socketio.on("post_comment")
    def on_post_comment(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        if not throttle.allow(info, "post_comment", 0.5):
            emit("feed_error", {"error": "Slow down a bit"})
            return
        data = data or {}
        try:
            post_id = int(data.get("id"))
        except (TypeError, ValueError):
            emit("feed_error", {"error": "invalid post id"})
            return
        ok, text = require_str(data, "text", min_len=1, max_len=500)
        if not ok:
            emit("feed_error", {"error": text})
            return
        post, err = db.add_post_comment(
            post_id, info["username"], info["user"], text
        )
        if err:
            emit("feed_error", {"error": err})
            return
        for sid, sess in list(state.sessions.items()):
            viewed = db.get_post(post_id, sess["username"])
            if viewed:
                socketio.emit("post_updated", viewed, to=sid)

    @socketio.on("post_delete")
    def on_post_delete(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        try:
            post_id = int((data or {}).get("id"))
        except (TypeError, ValueError):
            emit("feed_error", {"error": "invalid post id"})
            return
        if not db.delete_post(post_id, info["username"]):
            emit("feed_error", {"error": "you can only delete your own posts"})
            return
        socketio.emit("post_deleted", {"id": post_id})
