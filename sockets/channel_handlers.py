"""
Channel join, rename (admin only), and older history pagination.
"""

from flask import request
from flask_socketio import emit, join_room, leave_room

import db
import state
import throttle
from validate import require_str, optional_str


def register(socketio):
    @socketio.on("join_channel")
    def on_join_channel(data):
        info = state.sessions.get(request.sid)
        if not info:
            return

        data = data or {}
        community = data.get("community")
        channel = data.get("channel")
        if not community or not channel:
            return

        # DMs are private: only allow join if this user is part of the pair
        if community == "_dm":
            if not _can_access_dm(info["username"], channel):
                emit("channel_error", {"error": "You cannot open that DM"})
                return
        elif community not in state.COMMUNITIES or channel not in {
            c["id"] for c in state.COMMUNITIES[community]["channels"]
        }:
            emit("channel_error", {"error": "Unknown channel"})
            return

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

    @socketio.on("load_older_messages")
    def on_load_older_messages(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        data = data or {}
        try:
            before_id = int(data.get("before_id") or 0)
        except (TypeError, ValueError):
            emit("channel_error", {"error": "Invalid before_id"})
            return
        if before_id <= 0:
            emit("channel_error", {"error": "before_id is required"})
            return

        page = state.channel_history(info["room"], before_id=before_id)
        emit(
            "older_messages",
            {"messages": page["messages"], "has_more": page["has_more"]},
        )

    @socketio.on("rename_community")
    def on_rename_community(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        if not db.user_is_admin(info["username"]):
            emit("channel_error", {"error": "Only admins can rename communities"})
            return
        if not throttle.allow(info, "rename", 1.0):
            emit("channel_error", {"error": "Slow down a bit"})
            return
        data = data or {}
        # accept either id or community_id (UI sends community_id)
        raw_id = data.get("community_id") or data.get("id")
        ok, community_id = require_str({"id": raw_id}, "id", min_len=1, max_len=40)
        if not ok:
            emit("channel_error", {"error": community_id})
            return
        ok, name = require_str(data, "name", min_len=1, max_len=40)
        if not ok:
            emit("channel_error", {"error": name})
            return
        ok, abbr = optional_str(data, "abbr", max_len=4)
        if not ok:
            emit("channel_error", {"error": abbr})
            return
        if community_id == "_dm":
            emit("channel_error", {"error": "Cannot rename DMs"})
            return
        if community_id not in state.COMMUNITIES:
            emit("channel_error", {"error": "Unknown community"})
            return
        db.rename_community(community_id, name, abbr=abbr or None)
        state.broadcast_layout()

    @socketio.on("rename_channel")
    def on_rename_channel(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        if not db.user_is_admin(info["username"]):
            emit("channel_error", {"error": "Only admins can rename channels"})
            return
        if not throttle.allow(info, "rename", 1.0):
            emit("channel_error", {"error": "Slow down a bit"})
            return
        data = data or {}
        raw_community = data.get("community_id") or data.get("community")
        raw_channel = data.get("channel_id") or data.get("id")
        ok, community_id = require_str({"id": raw_community}, "id", min_len=1, max_len=40)
        if not ok:
            emit("channel_error", {"error": community_id})
            return
        ok, channel_id = require_str({"id": raw_channel}, "id", min_len=1, max_len=40)
        if not ok:
            emit("channel_error", {"error": channel_id})
            return
        ok, name = require_str(data, "name", min_len=1, max_len=40)
        if not ok:
            emit("channel_error", {"error": name})
            return
        if community_id == "_dm" or community_id not in state.COMMUNITIES:
            emit("channel_error", {"error": "Unknown community"})
            return
        if channel_id not in {c["id"] for c in state.COMMUNITIES[community_id]["channels"]}:
            emit("channel_error", {"error": "Unknown channel"})
            return
        db.rename_channel(community_id, channel_id, name)
        state.broadcast_layout()


def _can_access_dm(username, channel_id):
    parts = str(channel_id).split("__")
    if len(parts) != 2:
        return False
    return username in parts and db.are_friends(parts[0], parts[1])
