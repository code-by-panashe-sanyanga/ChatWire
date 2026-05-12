from flask import request
from flask_socketio import emit, join_room

import db
import state
from validate import require_str, optional_str


def join_session(display_name, username, community, channel):
    if community not in state.COMMUNITIES:
        community = state.LAYOUT["communities"][0]["id"]

    community_data = state.COMMUNITIES[community]
    if not channel:
        channel = community_data["channels"][0]["id"]

    valid_channels = {c["id"] for c in community_data["channels"]}
    if channel not in valid_channels:
        channel = community_data["channels"][0]["id"]

    room = state.channel_room(community, channel)
    join_room(room)

    state.sessions[request.sid] = {
        "username": username,
        "user": display_name,
        "community": community,
        "channel": channel,
        "room": room,
    }

    record = db.get_user(username) or {}
    emit(
        "session_ready",
        {
            "user": display_name,
            "username": username,
            "is_admin": bool(record.get("is_admin")),
            "community": community,
            "channel": channel,
            "layout": state.LAYOUT,
            "friends": state.friends_status_for(username),
            "call": {
                "room": room,
                "participants": state.call_participants(room),
            },
            "events": db.list_events(community),
            "unreads": db.unread_summary(username),
            "dms": {"threads": db.list_dm_threads(username)},
        },
    )

    history = state.channel_history(room)
    emit(
        "channel_history",
        {"messages": history["messages"], "has_more": history["has_more"]},
    )
    if history["messages"]:
        db.mark_channel_read(
            username, community, channel, history["messages"][-1]["id"]
        )
        emit("unreads", db.unread_summary(username))
    emit(
        "message",
        {
            "user": display_name,
            "text": "joined the channel",
            "system": True,
            "at": state.utc_now(),
        },
        room=room,
    )
    emit("channel_members", {"members": state.users_in_channel(community, channel)})
    state.broadcast_presence()


def register(socketio):
    @socketio.on("session_start")
    def on_session_start(data):
        data = data or {}
        ok, username = require_str(data, "username", min_len=1, max_len=20)
        if not ok:
            emit("auth_error", {"error": username})
            return
        username = username.lower()

        # prefer a session token so the browser never re-sends the password
        token = (data.get("token") or "").strip()
        display_name = None
        if token:
            token_user = state.resolve_session_token(token)
            if not token_user or token_user != username:
                emit("auth_error", {"error": "session expired - please log in again"})
                return
            record = db.get_user(username)
            if not record:
                emit("auth_error", {"error": "invalid username or password"})
                return
            display_name = record["display_name"]
        else:
            # password fallback keeps pytest / direct clients simple
            ok, password = require_str(data, "password", min_len=1, max_len=200)
            if not ok:
                emit("auth_error", {"error": "token or password required"})
                return
            display_name, err = state.verify_user(username, password)
            if not display_name:
                emit("auth_error", {"error": err or "invalid username or password"})
                return

        ok, community = optional_str(data, "community", max_len=40)
        if not ok:
            emit("auth_error", {"error": community})
            return
        ok, channel = optional_str(data, "channel", max_len=40)
        if not ok:
            emit("auth_error", {"error": channel})
            return

        if not community:
            community = state.LAYOUT["communities"][0]["id"]
        join_session(display_name, username, community, channel)

    @socketio.on("update_display_name")
    def on_update_display_name(data):
        info = state.sessions.get(request.sid)
        if not info:
            return

        ok, new_name = require_str(data or {}, "user", min_len=1, max_len=32)
        if not ok:
            emit("profile_error", {"error": new_name})
            return

        old_name = info["user"]
        if old_name == new_name:
            return

        info["user"] = new_name
        db.update_display_name(info["username"], new_name)

        emit("display_name_updated", {"user": new_name})
        socketio.emit("user_renamed", {"old_name": old_name, "new_name": new_name})
        state.broadcast_presence()

    @socketio.on("disconnect")
    def on_disconnect(_reason=None):
        from flask_socketio import leave_room

        info = state.sessions.pop(request.sid, None)
        if not info:
            return

        leave_room(info["room"])
        if state.leave_call(info["username"], info["room"]):
            state.broadcast_call(info["room"])
        emit(
            "message",
            {
                "user": info["user"],
                "text": "left the channel",
                "system": True,
                "at": state.utc_now(),
            },
            room=info["room"],
        )
        socketio.emit(
            "channel_members",
            {"members": state.users_in_channel(info["community"], info["channel"])},
            room=info["room"],
        )
        state.broadcast_presence()
