"""
Discover / social-extension socket handlers.

Friend requests, blocks, reports, follows, votes, boards, and go-live.
"""

from flask import request
from flask_socketio import emit

import db_ext
import state
import throttle
from validate import require_str, optional_str


def register(socketio):
    @socketio.on("friend_request_send")
    def on_friend_request_send(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        if not throttle.allow(info, "friend_request_send", 1.0):
            emit("discover_error", {"error": "Slow down a bit"})
            return
        ok, username = require_str(data or {}, "username", min_len=3, max_len=20)
        if not ok:
            emit("discover_error", {"error": username})
            return
        username = username.lower()
        if _blocked(info["username"], username):
            return
        success, detail = db_ext.send_friend_request(info["username"], username)
        if not success:
            emit("discover_error", {"error": detail})
            return
        _emit_friend_requests(socketio, info["username"])
        target_sid = state.sid_for_username(username)
        if target_sid:
            socketio.emit(
                "friend_request",
                {
                    "from_user": info["username"],
                    "from_name": info["user"],
                    "to_user": username,
                },
                to=target_sid,
            )
            _emit_friend_requests(socketio, username, to_sid=target_sid)
        state.broadcast_presence()

    @socketio.on("friend_request_accept")
    def on_friend_request_accept(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        if not throttle.allow(info, "friend_request_accept", 0.5):
            emit("discover_error", {"error": "Slow down a bit"})
            return
        ok, username = require_str(data or {}, "username", min_len=3, max_len=20)
        if not ok:
            emit("discover_error", {"error": username})
            return
        username = username.lower()
        if _blocked(info["username"], username):
            return
        success, detail = db_ext.accept_friend_request(info["username"], username)
        if not success:
            emit("discover_error", {"error": detail})
            return
        _emit_friend_requests(socketio, info["username"])
        peer_sid = state.sid_for_username(username)
        if peer_sid:
            socketio.emit(
                "friend_request",
                {
                    "accepted": True,
                    "from_user": username,
                    "to_user": info["username"],
                    "by": info["username"],
                },
                to=peer_sid,
            )
            _emit_friend_requests(socketio, username, to_sid=peer_sid)
        state.broadcast_presence()

    @socketio.on("friend_request_decline")
    def on_friend_request_decline(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        ok, username = require_str(data or {}, "username", min_len=3, max_len=20)
        if not ok:
            emit("discover_error", {"error": username})
            return
        username = username.lower()
        db_ext.decline_friend_request(info["username"], username)
        _emit_friend_requests(socketio, info["username"])

    @socketio.on("friend_requests_list")
    def on_friend_requests_list(_data=None):
        info = state.sessions.get(request.sid)
        if not info:
            return
        _emit_friend_requests(socketio, info["username"])

    @socketio.on("block_user")
    def on_block_user(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        if not throttle.allow(info, "block_user", 1.0):
            emit("discover_error", {"error": "Slow down a bit"})
            return
        ok, username = require_str(data or {}, "username", min_len=3, max_len=20)
        if not ok:
            emit("discover_error", {"error": username})
            return
        username = username.lower()
        success, detail = db_ext.block_user(info["username"], username)
        if not success:
            emit("discover_error", {"error": detail})
            return
        emit("blocked", {"username": username})
        state.broadcast_presence()

    @socketio.on("unblock_user")
    def on_unblock_user(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        ok, username = require_str(data or {}, "username", min_len=3, max_len=20)
        if not ok:
            emit("discover_error", {"error": username})
            return
        username = username.lower()
        db_ext.unblock_user(info["username"], username)
        emit("unblocked", {"username": username})

    @socketio.on("report_user")
    def on_report_user(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        if not throttle.allow(info, "report_user", 2.0):
            emit("discover_error", {"error": "Slow down a bit"})
            return
        data = data or {}
        ok, username = require_str(data, "username", min_len=3, max_len=20)
        if not ok:
            emit("discover_error", {"error": username})
            return
        username = username.lower()
        ok, reason = optional_str(data, "reason", max_len=500)
        if not ok:
            emit("discover_error", {"error": reason})
            return
        report, err = db_ext.create_report(
            info["username"],
            username,
            "user",
            username,
            reason or "unspecified",
        )
        if err:
            emit("discover_error", {"error": err})
            return
        emit("report_ok", {"id": report["id"], "username": username})

    @socketio.on("follow")
    def on_follow(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        if not throttle.allow(info, "follow", 0.5):
            emit("discover_error", {"error": "Slow down a bit"})
            return
        ok, username = require_str(data or {}, "username", min_len=3, max_len=20)
        if not ok:
            emit("discover_error", {"error": username})
            return
        username = username.lower()
        if _blocked(info["username"], username):
            return
        success, detail = db_ext.follow_user(info["username"], username)
        if not success:
            emit("discover_error", {"error": detail})
            return
        emit("following", {"users": db_ext.list_following(info["username"])})
        emit("profile", db_ext.profile_stats(info["username"]))

    @socketio.on("unfollow")
    def on_unfollow(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        ok, username = require_str(data or {}, "username", min_len=3, max_len=20)
        if not ok:
            emit("discover_error", {"error": username})
            return
        username = username.lower()
        db_ext.unfollow_user(info["username"], username)
        emit("following", {"users": db_ext.list_following(info["username"])})
        emit("profile", db_ext.profile_stats(info["username"]))

    @socketio.on("following_list")
    def on_following_list(_data=None):
        info = state.sessions.get(request.sid)
        if not info:
            return
        emit("following", {"users": db_ext.list_following(info["username"])})

    @socketio.on("followers_list")
    def on_followers_list(_data=None):
        info = state.sessions.get(request.sid)
        if not info:
            return
        emit("followers", {"users": db_ext.list_followers(info["username"])})

    @socketio.on("discover_feed_load")
    def on_discover_feed_load(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        before_id = None
        if isinstance(data, dict) and data.get("before_id") is not None:
            try:
                before_id = int(data["before_id"])
            except (TypeError, ValueError):
                before_id = None
        payload = db_ext.list_discover_posts(
            info["username"], limit=30, before_id=before_id
        )
        emit("discover_feed", payload)

    @socketio.on("vote_post")
    def on_vote_post(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        if not throttle.allow(info, "vote_post", 0.3):
            return
        data = data or {}
        try:
            post_id = int(data.get("id"))
        except (TypeError, ValueError):
            emit("discover_error", {"error": "invalid post id"})
            return
        try:
            value = int(data.get("value"))
        except (TypeError, ValueError):
            emit("discover_error", {"error": "invalid vote"})
            return
        success, detail = db_ext.vote_post(post_id, info["username"], value)
        if not success:
            emit("discover_error", {"error": detail})
            return
        emit(
            "post_voted",
            {
                "id": post_id,
                "score": db_ext.get_vote_score(post_id),
                "my_vote": db_ext.get_user_vote(post_id, info["username"]),
            },
        )

    @socketio.on("board_create")
    def on_board_create(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        if not throttle.allow(info, "board_create", 1.0):
            emit("discover_error", {"error": "Slow down a bit"})
            return
        ok, name = require_str(data or {}, "name", min_len=1, max_len=80)
        if not ok:
            emit("discover_error", {"error": name})
            return
        board, err = db_ext.create_board(info["username"], name)
        if err:
            emit("discover_error", {"error": err})
            return
        emit("boards", {"boards": db_ext.list_boards(info["username"]), "created": board})

    @socketio.on("boards_list")
    def on_boards_list(_data=None):
        info = state.sessions.get(request.sid)
        if not info:
            return
        emit("boards", {"boards": db_ext.list_boards(info["username"])})

    @socketio.on("board_pin")
    def on_board_pin(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        if not throttle.allow(info, "board_pin", 0.5):
            emit("discover_error", {"error": "Slow down a bit"})
            return
        data = data or {}
        try:
            board_id = int(data.get("board_id"))
            post_id = int(data.get("post_id"))
        except (TypeError, ValueError):
            emit("discover_error", {"error": "invalid board or post id"})
            return
        owned = any(b["id"] == board_id for b in db_ext.list_boards(info["username"]))
        if not owned:
            emit("discover_error", {"error": "board not found"})
            return
        success, detail = db_ext.pin_post_to_board(board_id, post_id, info["username"])
        if not success:
            emit("discover_error", {"error": detail})
            return
        emit(
            "board_pins",
            {
                "board_id": board_id,
                "pins": db_ext.list_board_pins_enriched(board_id, info["username"]),
            },
        )
        emit("boards", {"boards": db_ext.list_boards(info["username"])})
        emit("profile", db_ext.profile_stats(info["username"]))

    @socketio.on("board_unpin")
    def on_board_unpin(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        if not throttle.allow(info, "board_unpin", 0.5):
            emit("discover_error", {"error": "Slow down a bit"})
            return
        data = data or {}
        try:
            board_id = int(data.get("board_id"))
            post_id = int(data.get("post_id"))
        except (TypeError, ValueError):
            emit("discover_error", {"error": "invalid board or post id"})
            return
        success, detail = db_ext.unpin_post_from_board(
            board_id, post_id, info["username"]
        )
        if not success:
            emit("discover_error", {"error": detail})
            return
        emit(
            "board_pins",
            {
                "board_id": board_id,
                "pins": db_ext.list_board_pins_enriched(board_id, info["username"]),
            },
        )
        emit("boards", {"boards": db_ext.list_boards(info["username"])})
        emit("profile", db_ext.profile_stats(info["username"]))

    @socketio.on("profile_load")
    def on_profile_load(data=None):
        info = state.sessions.get(request.sid)
        if not info:
            return
        target = info["username"]
        if isinstance(data, dict) and data.get("username"):
            ok, target = optional_str(data, "username", max_len=20)
            if not ok:
                emit("discover_error", {"error": target})
                return
            target = target or info["username"]
        emit("profile", db_ext.profile_stats(info["username"], target))
        if target == info["username"] or target:
            payload = db_ext.list_user_posts(info["username"], target, limit=30)
            emit("user_posts", payload)

    @socketio.on("user_posts_load")
    def on_user_posts_load(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        data = data or {}
        target = (data.get("username") or info["username"]).strip()
        before_id = None
        if data.get("before_id") is not None:
            try:
                before_id = int(data["before_id"])
            except (TypeError, ValueError):
                before_id = None
        emit(
            "user_posts",
            db_ext.list_user_posts(
                info["username"], target, limit=30, before_id=before_id,
                quotes_only=bool(data.get("reposts") or data.get("quotes_only")),
            ),
        )

    @socketio.on("board_pins_load")
    def on_board_pins_load(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        try:
            board_id = int((data or {}).get("board_id"))
        except (TypeError, ValueError):
            emit("discover_error", {"error": "invalid board id"})
            return
        owned = any(b["id"] == board_id for b in db_ext.list_boards(info["username"]))
        if not owned:
            emit("discover_error", {"error": "Saved boards are private"})
            return
        emit(
            "board_pins",
            {
                "board_id": board_id,
                "pins": db_ext.list_board_pins(board_id, info["username"]),
            },
        )

    @socketio.on("live_start")
    def on_live_start(data):
        info = state.sessions.get(request.sid)
        if not info:
            return
        if not throttle.allow(info, "live_start", 1.0):
            emit("discover_error", {"error": "Slow down a bit"})
            return
        community = info.get("community") or ""
        channel = info.get("channel") or ""
        if not community or community == "_dm" or not channel:
            emit("discover_error", {"error": "Pick a community channel before going live"})
            return
        ok, title = optional_str(data or {}, "title", max_len=120)
        if not ok:
            emit("discover_error", {"error": title})
            return
        session = db_ext.start_live(community, channel, info["username"], title or "Live")
        room = info.get("room") or state.channel_room(community, channel)
        socketio.emit("live_updated", session, room=room)
        emit("live_list", {"lives": db_ext.list_active_lives()})

    @socketio.on("live_end")
    def on_live_end(_data=None):
        info = state.sessions.get(request.sid)
        if not info:
            return
        community = info.get("community") or ""
        channel = info.get("channel") or ""
        db_ext.end_live(info["username"])
        room = info.get("room")
        if room:
            socketio.emit(
                "live_updated",
                {
                    "active": 0,
                    "host_username": info["username"],
                    "community_id": community,
                    "channel_id": channel,
                },
                room=room,
            )
        emit("live_list", {"lives": db_ext.list_active_lives()})

    @socketio.on("live_list")
    def on_live_list(_data=None):
        info = state.sessions.get(request.sid)
        if not info:
            return
        emit("live_list", {"lives": db_ext.list_active_lives()})


def _blocked(me, other):
    if db_ext.is_blocked(me, other):
        emit("discover_error", {"error": "cannot interact with this user"})
        return True
    return False


def _emit_friend_requests(socketio, username, to_sid=None):
    payload = {
        "incoming": db_ext.list_incoming_requests(username),
        "outgoing": db_ext.list_outgoing_requests(username),
    }
    if to_sid:
        socketio.emit("friend_requests", payload, to=to_sid)
    else:
        emit("friend_requests", payload)
