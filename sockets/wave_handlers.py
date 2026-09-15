"""
Wave socket handlers — Clips, Wire, Rooms, Pulse, Boards, Hubs.

All-in-one social layer on top of ChatWire.
"""

from flask import request
from flask_socketio import emit

import db
import db_ext
import state
import throttle
from validate import require_str, optional_str


def register(socketio):
    @socketio.on("foryou_load")
    def on_foryou_load(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        before_id = _before_id(data)
        payload = db_ext.list_foryou_posts(
            info["username"], limit=30, before_id=before_id
        )
        emit("foryou_feed", payload)

    @socketio.on("clips_load")
    def on_clips_load(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        before_id = _before_id(data)
        payload = db_ext.list_clips(
            info["username"], limit=20, before_id=before_id
        )
        emit("clips_feed", payload)

    @socketio.on("clip_create")
    def on_clip_create(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        if not throttle.allow(info, "clip_create", 1.0):
            emit("wave_error", {"error": "Slow down a bit"})
            return
        data = data or {}
        ok, text = optional_str(data, "text", max_len=280)
        if not ok:
            emit("wave_error", {"error": text})
            return
        media_url = (data.get("media_url") or data.get("image_url") or "").strip()
        ok, media_url_opt = optional_str(
            {"media_url": media_url}, "media_url", max_len=500
        )
        if not ok:
            emit("wave_error", {"error": media_url_opt})
            return
        media_kind = (data.get("media_kind") or "video").strip().lower()
        if media_kind != "video":
            media_kind = "video"
        post, err = db_ext.create_wave_post(
            info["username"],
            info["user"],
            text or "",
            image_url=media_url_opt or "",
            media_kind=media_kind,
        )
        if err:
            emit("wave_error", {"error": err})
            return
        emit("clip_created", post)
        payload = db_ext.list_clips(info["username"], limit=20)
        emit("clips_feed", payload)

    @socketio.on("quote_post")
    def on_quote_post(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        if not throttle.allow(info, "quote_post", 1.0):
            emit("wave_error", {"error": "Slow down a bit"})
            return
        data = data or {}
        try:
            post_id = int(data.get("post_id"))
        except (TypeError, ValueError):
            emit("wave_error", {"error": "invalid post id"})
            return
        is_repost = bool(data.get("repost"))
        if is_repost:
            text = ""
        else:
            ok, text = require_str(data, "text", min_len=1, max_len=280)
            if not ok:
                emit("wave_error", {"error": text})
                return
        post, err = db_ext.create_wave_post(
            info["username"],
            info["user"],
            text or "",
            media_kind="text",
            quote_of=post_id,
        )
        if err:
            emit("wave_error", {"error": err})
            return
        if is_repost:
            emit("repost_created", post)
        targets = {info["username"]}
        for friend in db.list_friends(info["username"]):
            targets.add(friend["username"])
        for f in db_ext.list_following(info["username"]):
            targets.add(f["username"])
        for sid, sess in list(state.sessions.items()):
            if sess["username"] in targets and not db_ext.is_blocked(
                sess["username"], info["username"]
            ):
                socketio.emit("post_created", post, to=sid)
        emit("profile", db_ext.profile_stats(info["username"]))

    @socketio.on("repost_post")
    def on_repost_post(data):
        data = data or {}
        data["repost"] = True
        on_quote_post(data)

    @socketio.on("trends_load")
    def on_trends_load(_data=None):
        info = state.sessions.get(request.sid)
        if not info:
            return
        emit("trends", {"tags": db_ext.list_trending_tags(limit=12)})

    @socketio.on("rooms_load")
    def on_rooms_load(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        data = data or {}
        ok, community_id = require_str(data, "community_id", min_len=1, max_len=40)
        if not ok:
            emit("wave_error", {"error": community_id})
            return
        sort = (data.get("sort") or "hot").strip().lower()
        if sort not in ("hot", "new"):
            sort = "hot"
        payload = db_ext.list_room_posts(
            info["username"], community_id, sort=sort, limit=30
        )
        emit("rooms_feed", payload)

    @socketio.on("room_post_create")
    def on_room_post_create(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        if not throttle.allow(info, "room_post_create", 1.0):
            emit("wave_error", {"error": "Slow down a bit"})
            return
        data = data or {}
        ok, community_id = require_str(data, "community_id", min_len=1, max_len=40)
        if not ok:
            emit("wave_error", {"error": community_id})
            return
        ok, text = optional_str(data, "text", max_len=280)
        if not ok:
            emit("wave_error", {"error": text})
            return
        ok, image_url = optional_str(data, "image_url", max_len=500)
        if not ok:
            emit("wave_error", {"error": image_url})
            return
        media_kind = "image" if image_url else "text"
        post, err = db_ext.create_wave_post(
            info["username"],
            info["user"],
            text or "",
            image_url=image_url or "",
            media_kind=media_kind,
            community_id=community_id,
        )
        if err:
            emit("wave_error", {"error": err})
            return
        emit("post_created", post)
        payload = db_ext.list_room_posts(
            info["username"], community_id, sort="new", limit=30
        )
        emit("rooms_feed", payload)

    @socketio.on("comment_reply")
    def on_comment_reply(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        if not throttle.allow(info, "comment_reply", 0.5):
            emit("wave_error", {"error": "Slow down a bit"})
            return
        data = data or {}
        try:
            post_id = int(data.get("post_id") or data.get("id"))
        except (TypeError, ValueError):
            emit("wave_error", {"error": "invalid post id"})
            return
        ok, text = require_str(data, "text", min_len=1, max_len=500)
        if not ok:
            emit("wave_error", {"error": text})
            return
        parent_id = data.get("parent_id")
        if parent_id is not None and parent_id != "":
            try:
                parent_id = int(parent_id)
            except (TypeError, ValueError):
                emit("wave_error", {"error": "invalid parent_id"})
                return
        else:
            parent_id = None
        post, err = db_ext.add_comment(
            post_id, info["username"], info["user"], text, parent_id=parent_id
        )
        if err:
            emit("wave_error", {"error": err})
            return
        for sid, sess in list(state.sessions.items()):
            if db_ext.is_blocked(sess["username"], info["username"]):
                continue
            viewed = db_ext.get_wave_post(post_id, sess["username"])
            if viewed:
                socketio.emit("post_updated", viewed, to=sid)

    @socketio.on("snap_send")
    def on_snap_send(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        if not throttle.allow(info, "snap_send", 1.0):
            emit("wave_error", {"error": "Slow down a bit"})
            return
        data = data or {}
        ok, to_user = require_str(data, "to_user", min_len=3, max_len=20)
        if not ok:
            emit("wave_error", {"error": to_user})
            return
        to_user = to_user.lower()
        ok, text = optional_str(data, "text", max_len=500)
        if not ok:
            emit("wave_error", {"error": text})
            return
        ok, media_url = optional_str(data, "media_url", max_len=500)
        if not ok:
            emit("wave_error", {"error": media_url})
            return
        if db_ext.is_blocked(info["username"], to_user):
            emit("wave_error", {"error": "cannot send snap"})
            return
        snap, err = db_ext.send_snap(
            info["username"], to_user, text or "", media_url or ""
        )
        if err:
            emit("wave_error", {"error": err})
            return
        emit("snap_sent", snap)
        target_sid = state.sid_for_username(to_user)
        if target_sid:
            socketio.emit("snap_received", snap, to=target_sid)

    @socketio.on("snaps_inbox")
    def on_snaps_inbox(_data=None):
        info = state.sessions.get(request.sid)
        if not info:
            return
        emit("snaps", {"snaps": db_ext.list_snaps_inbox(info["username"])})

    @socketio.on("snap_open")
    def on_snap_open(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        try:
            snap_id = int((data or {}).get("snap_id"))
        except (TypeError, ValueError):
            emit("wave_error", {"error": "invalid snap id"})
            return
        snap, err = db_ext.open_snap(snap_id, info["username"])
        if err:
            emit("wave_error", {"error": err})
            return
        emit("snap_opened", snap)

    @socketio.on("board_pins_enriched")
    def on_board_pins_enriched(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        try:
            board_id = int((data or {}).get("board_id"))
        except (TypeError, ValueError):
            emit("wave_error", {"error": "invalid board id"})
            return
        owned = any(b["id"] == board_id for b in db_ext.list_boards(info["username"]))
        if not owned:
            emit("wave_error", {"error": "Saved boards are private"})
            return
        emit(
            "board_pins",
            {
                "board_id": board_id,
                "pins": db_ext.list_board_pins_enriched(board_id, info["username"]),
            },
        )

    @socketio.on("channel_pin")
    def on_channel_pin(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        if not throttle.allow(info, "channel_pin", 0.5):
            emit("wave_error", {"error": "Slow down a bit"})
            return
        community = info.get("community") or ""
        channel = info.get("channel") or ""
        if not community or community == "_dm" or not channel:
            emit("wave_error", {"error": "Pick a community channel first"})
            return
        try:
            message_id = int((data or {}).get("message_id"))
        except (TypeError, ValueError):
            emit("wave_error", {"error": "invalid message id"})
            return
        pins = db_ext.hub_pin_message(
            community, channel, message_id, info["username"]
        )
        if pins is None:
            emit("wave_error", {"error": "message not found"})
            return
        emit(
            "channel_pins",
            {"community_id": community, "channel_id": channel, "pins": pins},
        )

    @socketio.on("channel_pins_list")
    def on_channel_pins_list(_data=None):
        info = state.sessions.get(request.sid)
        if not info:
            return
        community = info.get("community") or ""
        channel = info.get("channel") or ""
        if not community or not channel:
            emit("channel_pins", {"community_id": community, "channel_id": channel, "pins": []})
            return
        pins = db_ext.hub_list_pins(community, channel)
        emit(
            "channel_pins",
            {"community_id": community, "channel_id": channel, "pins": pins},
        )

    @socketio.on("channel_unpin")
    def on_channel_unpin(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        community = info.get("community") or ""
        channel = info.get("channel") or ""
        if not community or not channel:
            emit("wave_error", {"error": "Pick a community channel first"})
            return
        try:
            message_id = int((data or {}).get("message_id"))
        except (TypeError, ValueError):
            emit("wave_error", {"error": "invalid message id"})
            return
        pins = db_ext.hub_unpin_message(community, channel, message_id)
        emit(
            "channel_pins",
            {"community_id": community, "channel_id": channel, "pins": pins},
        )


def _before_id(data):
    if isinstance(data, dict) and data.get("before_id") is not None:
        try:
            return int(data["before_id"])
        except (TypeError, ValueError):
            return None
    return None
