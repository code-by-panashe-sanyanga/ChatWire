"""
Presence status + stories.

Status = available / busy / away (+ optional short text).
Stories = 24h posts your friends can tap through (instagram-ish).
"""

from flask import request
from flask_socketio import emit

import db
import state
import throttle
from validate import require_str, optional_str


def _emit_stories_to_network(socketio, username):
    # refresh story rings for this user and their online friends
    targets = {username}
    for friend in db.list_friends(username):
        targets.add(friend["username"])
    for sid, sess in list(state.sessions.items()):
        if sess["username"] in targets:
            socketio.emit(
                "stories",
                {"groups": db.list_story_groups(sess["username"])},
                to=sid,
            )


def register(socketio):
    @socketio.on("set_status")
    def on_set_status(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        if not throttle.allow(info, "set_status", 1.0):
            emit("status_error", {"error": "Slow down a bit"})
            return
        data = data or {}
        ok, status = require_str(data, "status", min_len=1, max_len=20)
        if not ok:
            emit("status_error", {"error": status})
            return
        ok, status_text = optional_str(data, "status_text", max_len=60)
        if not ok:
            emit("status_error", {"error": status_text})
            return

        success, detail = db.set_user_status(
            info["username"], status.lower(), status_text or ""
        )
        if not success:
            emit("status_error", {"error": detail})
            return

        emit("status_updated", detail)
        state.broadcast_presence()

    @socketio.on("stories_load")
    def on_stories_load(_data=None):
        info = state.sessions.get(request.sid)
        if not info:
            return
        emit("stories", {"groups": db.list_story_groups(info["username"])})

    @socketio.on("story_create")
    def on_story_create(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        if not throttle.allow(info, "story_create", 2.0):
            emit("story_error", {"error": "Slow down a bit"})
            return
        data = data or {}
        ok, text = optional_str(data, "text", max_len=280)
        if not ok:
            emit("story_error", {"error": text})
            return
        ok, image_url = optional_str(data, "image_url", max_len=500)
        if not ok:
            emit("story_error", {"error": image_url})
            return
        ok, bg_color = optional_str(data, "bg_color", max_len=20)
        if not ok:
            emit("story_error", {"error": bg_color})
            return

        story, err = db.create_story(
            info["username"],
            info["user"],
            text or "",
            image_url or "",
            bg_color or "#1c212b",
        )
        if err:
            emit("story_error", {"error": err})
            return

        emit("story_created", {"id": story["id"]})
        _emit_stories_to_network(socketio, info["username"])

    @socketio.on("story_view")
    def on_story_view(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        try:
            story_id = int((data or {}).get("id"))
        except (TypeError, ValueError):
            return
        db.mark_story_viewed(story_id, info["username"])
        # quietly refresh rings so the ring goes grey after watching
        emit("stories", {"groups": db.list_story_groups(info["username"])})

    @socketio.on("story_delete")
    def on_story_delete(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        try:
            story_id = int((data or {}).get("id"))
        except (TypeError, ValueError):
            emit("story_error", {"error": "invalid story id"})
            return
        if not db.delete_story(story_id, info["username"]):
            emit("story_error", {"error": "you can only delete your own stories"})
            return
        _emit_stories_to_network(socketio, info["username"])
