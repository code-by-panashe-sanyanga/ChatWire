# ChatWire backend
# Flask-SocketIO server — Discord-style UI, login, and live chat.

import json
import re
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from flask_socketio import SocketIO, emit, join_room, leave_room
from passlib.context import CryptContext

app = Flask(__name__, static_folder="static")
app.config["SECRET_KEY"] = "chatwire-dev"

socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

BASE = Path(__file__).parent
DATA_DIR = BASE / "data"
USERS_PATH = DATA_DIR / "users.json"
OVERRIDES_PATH = DATA_DIR / "overrides.json"
LAYOUT_PATH = BASE / "communities.json"

DATA_DIR.mkdir(exist_ok=True)

USERNAME_RE = re.compile(r"^[a-zA-Z0-9_]{3,20}$")


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def load_json(path, default):
    if not path.exists():
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def load_users():
    users = load_json(USERS_PATH, {})
    if not users:
        users = {
            "demo": {
                "display_name": "Demo User",
                "password_hash": pwd.hash("demo123"),
            }
        }
        save_json(USERS_PATH, users)
    return users


def load_base_layout():
    with open(LAYOUT_PATH, encoding="utf-8") as f:
        return json.load(f)


def load_overrides():
    return load_json(
        OVERRIDES_PATH,
        {"community_names": {}, "community_abbrs": {}, "channel_names": {}},
    )


def build_layout():
    base = load_base_layout()
    overrides = load_overrides()
    communities = []

    for community in base["communities"]:
        cid = community["id"]
        name = overrides["community_names"].get(cid, community["name"])
        abbr = overrides["community_abbrs"].get(cid, community["abbr"])
        channels = []
        for ch in community["channels"]:
            key = f"{cid}:{ch['id']}"
            ch_name = overrides["channel_names"].get(key, ch["name"])
            channels.append({**ch, "name": ch_name})
        communities.append({**community, "name": name, "abbr": abbr, "channels": channels})

    return {"communities": communities, "friends": base.get("friends", [])}


LAYOUT = build_layout()
COMMUNITIES = {c["id"]: c for c in LAYOUT["communities"]}
FRIEND_NAMES = LAYOUT.get("friends", [])
USERS = load_users()

sessions = {}
channel_messages = {}
message_seq = 0


def refresh_layout():
    global LAYOUT, COMMUNITIES, FRIEND_NAMES
    LAYOUT = build_layout()
    COMMUNITIES = {c["id"]: c for c in LAYOUT["communities"]}
    FRIEND_NAMES = LAYOUT.get("friends", [])


def channel_room(community_id, channel_id):
    return f"{community_id}:{channel_id}"


def verify_user(username, password):
    record = USERS.get(username)
    if not record or not pwd.verify(password, record["password_hash"]):
        return None
    return record["display_name"]


def online_users():
    return [
        {
            "user": info["user"],
            "community": info["community"],
            "channel": info["channel"],
        }
        for info in sessions.values()
    ]


def friends_status():
    connected = {info["user"] for info in sessions.values()}
    return [{"name": name, "online": name in connected} for name in FRIEND_NAMES]


def users_in_channel(community_id, channel_id):
    room = channel_room(community_id, channel_id)
    return [info["user"] for info in sessions.values() if info["room"] == room]


def channel_history(room):
    return [msg for msg in channel_messages.get(room, []) if not msg.get("system")]


def store_message(room, user, text):
    global message_seq
    message_seq += 1
    msg = {
        "id": message_seq,
        "user": user,
        "text": text,
        "system": False,
        "at": utc_now(),
        "edited_at": None,
    }
    channel_messages.setdefault(room, []).append(msg)
    if len(channel_messages[room]) > 100:
        channel_messages[room] = channel_messages[room][-100:]
    return msg


def rename_user_messages(old_name, new_name):
    for room_msgs in channel_messages.values():
        for msg in room_msgs:
            if msg.get("user") == old_name:
                msg["user"] = new_name


def broadcast_presence():
    socketio.emit("presence", {"online": online_users(), "friends": friends_status()})


def broadcast_layout():
    socketio.emit("layout_updated", build_layout())


def join_session(display_name, username, community, channel):
    if community not in COMMUNITIES:
        community = LAYOUT["communities"][0]["id"]

    community_data = COMMUNITIES[community]
    if not channel:
        channel = community_data["channels"][0]["id"]

    valid_channels = {c["id"] for c in community_data["channels"]}
    if channel not in valid_channels:
        channel = community_data["channels"][0]["id"]

    room = channel_room(community, channel)
    join_room(room)

    sessions[request.sid] = {
        "username": username,
        "user": display_name,
        "community": community,
        "channel": channel,
        "room": room,
    }

    emit(
        "session_ready",
        {
            "user": display_name,
            "username": username,
            "community": community,
            "channel": channel,
            "layout": LAYOUT,
        },
    )

    emit("channel_history", {"messages": channel_history(room)})

    emit(
        "message",
        {"user": display_name, "text": "joined the channel", "system": True, "at": utc_now()},
        room=room,
    )

    emit("channel_members", {"members": users_in_channel(community, channel)})
    broadcast_presence()


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/api/layout")
def api_layout():
    return jsonify(build_layout())


@app.post("/api/auth/register")
def api_register():
    data = request.get_json() or {}
    username = (data.get("username") or "").strip().lower()
    password = data.get("password") or ""
    display_name = (data.get("display_name") or username).strip()[:32]

    if not USERNAME_RE.match(username):
        return jsonify({"error": "username must be 3-20 letters, numbers, or underscores"}), 400
    if len(password) < 6:
        return jsonify({"error": "password must be at least 6 characters"}), 400
    if username in USERS:
        return jsonify({"error": "username already taken"}), 409

    USERS[username] = {
        "display_name": display_name or username,
        "password_hash": pwd.hash(password),
    }
    save_json(USERS_PATH, USERS)

    return jsonify({"ok": True, "username": username, "display_name": USERS[username]["display_name"]})


@app.post("/api/auth/login")
def api_login():
    data = request.get_json() or {}
    username = (data.get("username") or "").strip().lower()
    password = data.get("password") or ""

    display_name = verify_user(username, password)
    if not display_name:
        return jsonify({"error": "invalid username or password"}), 401

    return jsonify({"ok": True, "username": username, "display_name": display_name})


@app.post("/api/auth/change-password")
def api_change_password():
    data = request.get_json() or {}
    username = (data.get("username") or "").strip().lower()
    current = data.get("current_password") or ""
    new_password = data.get("new_password") or ""

    record = USERS.get(username)
    if not record or not pwd.verify(current, record["password_hash"]):
        return jsonify({"error": "current password is wrong"}), 401
    if len(new_password) < 6:
        return jsonify({"error": "new password must be at least 6 characters"}), 400

    record["password_hash"] = pwd.hash(new_password)
    save_json(USERS_PATH, USERS)
    return jsonify({"ok": True})


@app.route("/<path:path>")
def static_files(path):
    return send_from_directory("static", path)


@socketio.on("session_start")
def on_session_start(data):
    username = (data.get("username") or "").strip().lower()
    password = data.get("password") or ""
    community = data.get("community") or LAYOUT["communities"][0]["id"]
    channel = data.get("channel")

    display_name = verify_user(username, password)
    if not display_name:
        emit("auth_error", {"error": "invalid username or password"})
        return

    join_session(display_name, username, community, channel)


@socketio.on("join_channel")
def on_join_channel(data):
    info = sessions.get(request.sid)
    if not info:
        return

    community = data.get("community") or info["community"]
    channel = data.get("channel")

    if community not in COMMUNITIES:
        return

    community_data = COMMUNITIES[community]
    valid_channels = {c["id"] for c in community_data["channels"]}
    if channel not in valid_channels:
        channel = community_data["channels"][0]["id"]

    old_room = info["room"]
    if old_room:
        leave_room(old_room)
        emit(
            "message",
            {"user": info["user"], "text": "left the channel", "system": True, "at": utc_now()},
            room=old_room,
        )

    new_room = channel_room(community, channel)
    join_room(new_room)

    info["community"] = community
    info["channel"] = channel
    info["room"] = new_room

    emit("channel_switched", {"community": community, "channel": channel, "clear": True})
    emit("channel_history", {"messages": channel_history(new_room)})
    emit(
        "message",
        {"user": info["user"], "text": "joined the channel", "system": True, "at": utc_now()},
        room=new_room,
    )

    emit("channel_members", {"members": users_in_channel(community, channel)})
    socketio.emit("channel_members", {"members": users_in_channel(community, channel)}, room=new_room)
    broadcast_presence()


@socketio.on("rename_community")
def on_rename_community(data):
    info = sessions.get(request.sid)
    if not info:
        return

    community_id = data.get("community_id")
    name = (data.get("name") or "").strip()[:40]
    abbr = (data.get("abbr") or "").strip()[:4].upper()

    if community_id not in COMMUNITIES or not name:
        emit("edit_error", {"error": "invalid community name"})
        return

    overrides = load_overrides()
    overrides["community_names"][community_id] = name
    if abbr:
        overrides["community_abbrs"][community_id] = abbr
    save_json(OVERRIDES_PATH, overrides)
    refresh_layout()
    broadcast_layout()


@socketio.on("rename_channel")
def on_rename_channel(data):
    info = sessions.get(request.sid)
    if not info:
        return

    community_id = data.get("community_id")
    channel_id = data.get("channel_id")
    name = (data.get("name") or "").strip()[:40]

    if community_id not in COMMUNITIES or not name:
        emit("edit_error", {"error": "invalid channel name"})
        return

    valid = {c["id"] for c in COMMUNITIES[community_id]["channels"]}
    if channel_id not in valid:
        emit("edit_error", {"error": "channel not found"})
        return

    overrides = load_overrides()
    overrides["channel_names"][f"{community_id}:{channel_id}"] = name
    save_json(OVERRIDES_PATH, overrides)
    refresh_layout()
    broadcast_layout()


@socketio.on("message")
def on_message(data):
    info = sessions.get(request.sid)
    if not info:
        return

    text = (data.get("text") or "").strip()
    if not text:
        return

    msg = store_message(info["room"], info["user"], text)
    emit("message", msg, room=info["room"])


@socketio.on("edit_message")
def on_edit_message(data):
    info = sessions.get(request.sid)
    if not info:
        return

    msg_id = data.get("id")
    text = (data.get("text") or "").strip()
    if not msg_id or not text:
        emit("edit_error", {"error": "message id and text required"})
        return

    try:
        msg_id = int(msg_id)
    except (TypeError, ValueError):
        emit("edit_error", {"error": "invalid message id"})
        return

    for msg in channel_messages.get(info["room"], []):
        if msg["id"] == msg_id and msg["user"] == info["user"]:
            msg["text"] = text
            msg["edited_at"] = utc_now()
            emit("message_edited", msg, room=info["room"])
            return

    emit("edit_error", {"error": "you can only edit your own messages"})


@socketio.on("update_display_name")
def on_update_display_name(data):
    info = sessions.get(request.sid)
    if not info:
        return

    new_name = (data.get("user") or "").strip()[:32]
    if not new_name:
        emit("edit_error", {"error": "display name cannot be empty"})
        return

    old_name = info["user"]
    if old_name == new_name:
        return

    info["user"] = new_name
    if info["username"] in USERS:
        USERS[info["username"]]["display_name"] = new_name
        save_json(USERS_PATH, USERS)

    rename_user_messages(old_name, new_name)
    emit("display_name_updated", {"user": new_name})
    socketio.emit("user_renamed", {"old_name": old_name, "new_name": new_name})
    broadcast_presence()


@socketio.on("typing")
def on_typing(data):
    info = sessions.get(request.sid)
    if not info:
        return

    emit(
        "typing",
        {"user": info["user"], "typing": bool(data.get("typing"))},
        room=info["room"],
        include_self=False,
    )


@socketio.on("disconnect")
def on_disconnect():
    info = sessions.pop(request.sid, None)
    if not info:
        return

    leave_room(info["room"])
    emit(
        "message",
        {"user": info["user"], "text": "left the channel", "system": True, "at": utc_now()},
        room=info["room"],
    )
    socketio.emit(
        "channel_members",
        {"members": users_in_channel(info["community"], info["channel"])},
        room=info["room"],
    )
    broadcast_presence()


if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=5001, debug=True, allow_unsafe_werkzeug=True)
