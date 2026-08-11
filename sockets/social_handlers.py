"""
Friends, calendar events, channel calls, DMs, and unreads.
"""

from flask import request
from flask_socketio import emit, join_room, leave_room

import db
import state
import throttle
from validate import require_str, optional_str


def register(socketio):
    @socketio.on("add_friend")
    def on_add_friend(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        if not throttle.allow(info, "add_friend", 1.0):
            emit("friend_error", {"error": "Slow down a bit"})
            return
        ok, friend_username = require_str(data or {}, "username", min_len=3, max_len=20)
        if not ok:
            emit("friend_error", {"error": friend_username})
            return
        friend_username = friend_username.lower()
        success, detail = db.add_friend(info["username"], friend_username)
        if not success:
            emit("friend_error", {"error": detail})
            return
        emit("friend_added", {"username": friend_username, "name": detail})
        state.broadcast_presence()

    @socketio.on("remove_friend")
    def on_remove_friend(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        ok, friend_username = require_str(data or {}, "username", min_len=3, max_len=20)
        if not ok:
            emit("friend_error", {"error": friend_username})
            return
        friend_username = friend_username.lower()
        db.remove_friend(info["username"], friend_username)
        emit("friend_removed", {"username": friend_username})
        state.broadcast_presence()

    @socketio.on("list_dms")
    def on_list_dms(_data=None):
        info = state.sessions.get(request.sid)
        if not info:
            return
        emit("dms", {"threads": db.list_dm_threads(info["username"])})

    @socketio.on("open_dm")
    def on_open_dm(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        ok, peer = require_str(data or {}, "username", min_len=3, max_len=20)
        if not ok:
            emit("friend_error", {"error": peer})
            return
        peer = peer.lower()
        if peer == info["username"]:
            emit("friend_error", {"error": "cannot DM yourself"})
            return
        if not db.are_friends(info["username"], peer):
            emit("friend_error", {"error": "add them as a friend first"})
            return

        channel_id = db.ensure_dm_channel(info["username"], peer)
        _switch_to_room(socketio, info, "_dm", channel_id)

    @socketio.on("list_unreads")
    def on_list_unreads(_data=None):
        info = state.sessions.get(request.sid)
        if not info:
            return
        emit("unreads", db.unread_summary(info["username"]))

    @socketio.on("mark_read")
    def on_mark_read(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        data = data or {}
        try:
            last_read_id = int(data.get("last_read_id") or 0)
        except (TypeError, ValueError):
            return
        community = data.get("community") or info["community"]
        channel = data.get("channel") or info["channel"]
        if last_read_id > 0:
            db.mark_channel_read(info["username"], community, channel, last_read_id)
        emit("unreads", db.unread_summary(info["username"]))

    @socketio.on("list_events")
    def on_list_events(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        community = info["community"]
        if isinstance(data, dict) and data.get("community"):
            community = data["community"]
        events = db.list_events(community)
        emit("events", {"community": community, "events": events})

    @socketio.on("create_event")
    def on_create_event(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        if not throttle.allow(info, "create_event", 1.0):
            emit("event_error", {"error": "Slow down a bit"})
            return
        data = data or {}
        ok, title = require_str(data, "title", min_len=1, max_len=80)
        if not ok:
            emit("event_error", {"error": title})
            return
        ok, starts_at = require_str(data, "starts_at", min_len=1, max_len=40)
        if not ok:
            emit("event_error", {"error": starts_at})
            return
        ok, location = optional_str(data, "location", max_len=80)
        if not ok:
            emit("event_error", {"error": location})
            return
        ok, ends_at = optional_str(data, "ends_at", max_len=40)
        if not ok:
            emit("event_error", {"error": ends_at})
            return

        event = db.create_event(
            info["community"],
            title,
            starts_at,
            info["username"],
            ends_at=ends_at or "",
            location=location or "",
        )
        emit("event_created", event)
        socketio.emit(
            "events",
            {"community": info["community"], "events": db.list_events(info["community"])},
            room=info["room"],
        )

    @socketio.on("call_join")
    def on_call_join(_data=None):
        info = state.sessions.get(request.sid)
        if not info:
            return
        if not throttle.allow(info, "call_join", 0.5):
            return
        room = info["room"]
        state.active_calls.setdefault(room, {})[info["username"]] = info["user"]
        state.broadcast_call(room)
        state.broadcast_presence()

    @socketio.on("call_leave")
    def on_call_leave(_data=None):
        info = state.sessions.get(request.sid)
        if not info:
            return
        room = info["room"]
        if state.leave_call(info["username"], room):
            state.broadcast_call(room)
        state.broadcast_presence()

    @socketio.on("webrtc_signal")
    def on_webrtc_signal(data):
        """Relay SDP/ICE between two users in the same Meet now room."""
        info = state.sessions.get(request.sid)
        if not info:
            return
        if not throttle.allow(info, "webrtc_signal", 0.05):
            return
        payload = data or {}
        ok, target = require_str(payload, "to", min_len=3, max_len=20)
        if not ok:
            return
        target = target.lower()
        signal_type = (payload.get("type") or "").strip().lower()
        if signal_type not in ("offer", "answer", "ice"):
            return
        room = info["room"]
        people = state.active_calls.get(room, {})
        if info["username"] not in people or target not in people:
            return
        sid = state.sid_for_username(target)
        if not sid:
            return
        socketio.emit(
            "webrtc_signal",
            {
                "from": info["username"],
                "from_name": info["user"],
                "type": signal_type,
                "sdp": payload.get("sdp"),
                "candidate": payload.get("candidate"),
            },
            to=sid,
        )


def _switch_to_room(socketio, info, community, channel):
    """Shared leave/join path used by open_dm (and similar)."""
    old_room = info["room"]
    if old_room:
        if state.leave_call(info["username"], old_room):
            state.broadcast_call(old_room)
        leave_room(old_room)
        emit(
            "message",
            {
                "user": info["user"],
                "text": "left the channel",
                "system": True,
                "at": state.utc_now(),
            },
            room=old_room,
        )

    new_room = state.channel_room(community, channel)
    join_room(new_room)
    info["community"] = community
    info["channel"] = channel
    info["room"] = new_room

    history = state.channel_history(new_room)
    emit("channel_switched", {"community": community, "channel": channel, "clear": True})
    emit(
        "channel_history",
        {"messages": history["messages"], "has_more": history["has_more"]},
    )
    if history["messages"]:
        db.mark_channel_read(
            info["username"], community, channel, history["messages"][-1]["id"]
        )
    emit("unreads", db.unread_summary(info["username"]))
    emit("dms", {"threads": db.list_dm_threads(info["username"])})
    if community != "_dm":
        emit("events", {"community": community, "events": db.list_events(community)})
    emit(
        "call_updated",
        {"room": new_room, "participants": state.call_participants(new_room)},
    )
    emit(
        "message",
        {
            "user": info["user"],
            "text": "joined the channel",
            "system": True,
            "at": state.utc_now(),
        },
        room=new_room,
    )
    socketio.emit(
        "channel_members",
        {"members": state.users_in_channel(community, channel)},
        room=new_room,
    )
    state.broadcast_presence()
