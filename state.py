"""
Shared ChatWire helpers for HTTP + sockets.

Who is logged in / online lives in memory (changes every second).
Accounts, messages, friends, events and posts live in SQLite.
Session tokens are signed with SECRET_KEY (itsdangerous) so the browser
does not keep a plaintext password around for reconnects.
"""

from __future__ import annotations

import os
import re
import time
from datetime import datetime, timezone

import bcrypt
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

import db

USERNAME_RE = re.compile(r"^[a-zA-Z0-9_]{3,20}$")

# portfolio demo account - long enough for the password rules
DEMO_USERNAME = "demo"
DEMO_PASSWORD = "demo123456"

# lock an account briefly after too many wrong passwords
MAX_LOGIN_ATTEMPTS = 5
LOCKOUT_SECONDS = 60

# signed tokens last a day (same idea as NovaBank JWT lifetime)
TOKEN_MAX_AGE = 60 * 60 * 24

sessions: dict = {}
# room id -> people currently in the channel call
active_calls: dict = {}
# username -> {"count": int, "locked_until": float}
_login_failures: dict = {}

LAYOUT = {"communities": []}
COMMUNITIES: dict = {}

# set from app.py once SocketIO is created
socketio = None


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def hash_password(password: str) -> str:
    # bcrypt so we never store plain passwords
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def check_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        # bad/corrupt hash in the db - treat as failed login
        return False


def password_errors(password: str):
    """Return a human error string, or None if the password is strong enough."""
    if len(password) < 10:
        return "password must be at least 10 characters"
    if not re.search(r"[A-Za-z]", password):
        return "password must include a letter"
    if not re.search(r"\d", password):
        return "password must include a number"
    return None


def _token_serializer():
    secret = os.getenv("SECRET_KEY", "chatwire-dev")
    return URLSafeTimedSerializer(secret, salt="chatwire-session")


def issue_session_token(username: str) -> str:
    return _token_serializer().dumps({"username": username.lower()})


def resolve_session_token(token: str):
    """Return username if the token is valid, else None."""
    if not token:
        return None
    try:
        data = _token_serializer().loads(token, max_age=TOKEN_MAX_AGE)
    except (BadSignature, SignatureExpired):
        return None
    username = (data.get("username") or "").lower()
    if not username or not db.get_user(username):
        return None
    return username


def _is_locked(username: str):
    row = _login_failures.get(username)
    if not row:
        return False, 0
    locked_until = float(row.get("locked_until") or 0)
    # 0 means "not locked", only counting failures so far
    if locked_until <= 0:
        return False, 0
    remaining = int(locked_until - time.time())
    if remaining <= 0:
        _login_failures.pop(username, None)
        return False, 0
    return True, remaining


def _record_failure(username: str):
    row = _login_failures.get(username) or {"count": 0, "locked_until": 0}
    row["count"] = int(row["count"]) + 1
    if row["count"] >= MAX_LOGIN_ATTEMPTS:
        row["locked_until"] = time.time() + LOCKOUT_SECONDS
        row["count"] = 0
    _login_failures[username] = row


def _clear_failures(username: str):
    _login_failures.pop(username, None)


def refresh_layout():
    global LAYOUT, COMMUNITIES
    LAYOUT = db.get_layout()
    COMMUNITIES = {c["id"]: c for c in LAYOUT["communities"]}


def bootstrap():
    db.init_db()
    # default demo account so recruiters can click around without registering
    record = db.get_user(DEMO_USERNAME)
    if not record:
        db.create_user(
            DEMO_USERNAME,
            "Alex Rivera",
            hash_password(DEMO_PASSWORD),
            is_admin=True,
        )
    else:
        # keep demo as admin so rename checks are demoable
        db.set_admin(DEMO_USERNAME, True)
        # rotate the demo password if an older short one is still stored
        if not check_password(DEMO_PASSWORD, record["password_hash"]):
            db.update_password(DEMO_USERNAME, hash_password(DEMO_PASSWORD))
    refresh_layout()
    # fill friends / chat / timeline / stories when the DB is empty (e.g. fresh Railway deploy)
    try:
        import seed

        seed.ensure_users()
        seed.seed_friends()
        seed.seed_events()
        seed.seed_messages()
        seed.seed_feed()
        seed.seed_stories()
    except Exception as err:
        print(f"WARNING: demo seed skipped: {err}", file=__import__("sys").stderr)


def channel_room(community_id, channel_id):
    return f"{community_id}:{channel_id}"


def verify_user(username, password):
    """
    Check username/password.

    Returns (display_name, None) on success, or (None, error_message) on failure.
    """
    username = (username or "").lower().strip()
    locked, remaining = _is_locked(username)
    if locked:
        return None, f"too many attempts - try again in {remaining}s"

    record = db.get_user(username)
    if not record or not check_password(password or "", record["password_hash"]):
        if username:
            _record_failure(username)
            locked, remaining = _is_locked(username)
            if locked:
                return None, f"too many attempts - try again in {remaining}s"
        return None, "invalid username or password"

    _clear_failures(username)
    return record["display_name"], None


def online_users():
    out = []
    for info in sessions.values():
        record = db.get_user(info["username"]) or {}
        out.append(
            {
                "user": info["user"],
                "username": info["username"],
                "community": info["community"],
                "channel": info["channel"],
                "status": record.get("status") or "available",
                "status_text": record.get("status_text") or "",
            }
        )
    return out


def friends_status_for(username):
    # mark which friends are currently connected + their set status
    online_names = {info["username"] for info in sessions.values()}
    out = []
    for friend in db.list_friends(username):
        record = db.get_user(friend["username"]) or {}
        out.append(
            {
                "username": friend["username"],
                "name": friend["name"],
                "online": friend["username"] in online_names,
                "status": record.get("status") or "available",
                "status_text": record.get("status_text") or "",
            }
        )
    return out


def users_in_channel(community_id, channel_id):
    room = channel_room(community_id, channel_id)
    return [info["user"] for info in sessions.values() if info["room"] == room]


def call_participants(room):
    return [
        {"username": u, "name": n}
        for u, n in active_calls.get(room, {}).items()
    ]


def leave_call(username, room):
    people = active_calls.get(room, {})
    if username not in people:
        return False
    people.pop(username, None)
    if not people:
        active_calls.pop(room, None)
    return True


def channel_history(room, before_id=None, limit=50):
    community_id, channel_id = room.split(":", 1)
    # keep has_more so the UI can show "load older"
    return db.channel_history(
        community_id, channel_id, limit=limit, before_id=before_id
    )


def store_message(room, username, display_name, text):
    community_id, channel_id = room.split(":", 1)
    return db.store_message(community_id, channel_id, username, display_name, text)


def broadcast_presence():
    if socketio is None:
        return
    online = online_users()
    # send a personalised payload so each user gets their own friends list
    for sid, info in list(sessions.items()):
        socketio.emit(
            "presence",
            {
                "online": online,
                "friends": friends_status_for(info["username"]),
                "call": {
                    "room": info["room"],
                    "participants": call_participants(info["room"]),
                },
            },
            to=sid,
        )


def broadcast_call(room):
    if socketio is None:
        return
    payload = {"room": room, "participants": call_participants(room)}
    socketio.emit("call_updated", payload, room=room)


def broadcast_layout():
    if socketio is None:
        return
    refresh_layout()
    socketio.emit("layout_updated", LAYOUT)
