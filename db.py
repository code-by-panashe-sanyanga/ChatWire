"""
SQLite helpers for ChatWire.

Plain SQL with the built-in sqlite3 module (no ORM - easier to explain
in a viva and I actually know what the queries are doing).

Main tables: users, communities, channels, messages, reactions,
friendships, events, posts (+ likes/comments for the feed).
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

BASE = Path(__file__).parent
DATA_DIR = BASE / "data"
DB_PATH = DATA_DIR / "chatwire.db"
LAYOUT_SEED = BASE / "communities.json"

DATA_DIR.mkdir(exist_ok=True)


def connect():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = connect()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            password_hash TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS communities (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            abbr TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS channels (
            community_id TEXT NOT NULL,
            id TEXT NOT NULL,
            name TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'text',
            topic TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (community_id, id),
            FOREIGN KEY (community_id) REFERENCES communities(id)
        );

        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            community_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            username TEXT,
            display_name TEXT NOT NULL,
            text TEXT NOT NULL,
            is_system INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            edited_at TEXT
        );

        CREATE TABLE IF NOT EXISTS reactions (
            message_id INTEGER NOT NULL,
            emoji TEXT NOT NULL,
            username TEXT NOT NULL,
            PRIMARY KEY (message_id, emoji, username),
            FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS friendships (
            user_username TEXT NOT NULL,
            friend_username TEXT NOT NULL,
            PRIMARY KEY (user_username, friend_username),
            FOREIGN KEY (user_username) REFERENCES users(username),
            FOREIGN KEY (friend_username) REFERENCES users(username)
        );

        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            community_id TEXT NOT NULL,
            title TEXT NOT NULL,
            starts_at TEXT NOT NULL,
            ends_at TEXT,
            location TEXT NOT NULL DEFAULT '',
            created_by TEXT NOT NULL,
            FOREIGN KEY (community_id) REFERENCES communities(id)
        );

        CREATE TABLE IF NOT EXISTS pins (
            community_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            message_id INTEGER NOT NULL,
            pinned_by TEXT NOT NULL,
            pinned_at TEXT NOT NULL,
            PRIMARY KEY (community_id, channel_id, message_id),
            FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS channel_reads (
            username TEXT NOT NULL,
            community_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            last_read_id INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (username, community_id, channel_id)
        );

        CREATE TABLE IF NOT EXISTS posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            display_name TEXT NOT NULL,
            text TEXT NOT NULL DEFAULT '',
            image_url TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            FOREIGN KEY (username) REFERENCES users(username)
        );

        CREATE TABLE IF NOT EXISTS post_likes (
            post_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            PRIMARY KEY (post_id, username),
            FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
            FOREIGN KEY (username) REFERENCES users(username)
        );

        CREATE TABLE IF NOT EXISTS post_comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            post_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            display_name TEXT NOT NULL,
            text TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
            FOREIGN KEY (username) REFERENCES users(username)
        );

        -- instagram-style stories (auto expire after 24h)
        CREATE TABLE IF NOT EXISTS stories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            display_name TEXT NOT NULL,
            text TEXT NOT NULL DEFAULT '',
            image_url TEXT NOT NULL DEFAULT '',
            bg_color TEXT NOT NULL DEFAULT '#1c212b',
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            FOREIGN KEY (username) REFERENCES users(username)
        );

        CREATE TABLE IF NOT EXISTS story_views (
            story_id INTEGER NOT NULL,
            viewer_username TEXT NOT NULL,
            viewed_at TEXT NOT NULL,
            PRIMARY KEY (story_id, viewer_username),
            FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE,
            FOREIGN KEY (viewer_username) REFERENCES users(username)
        );

        CREATE INDEX IF NOT EXISTS idx_messages_channel
            ON messages (community_id, channel_id, id);
        CREATE INDEX IF NOT EXISTS idx_posts_created
            ON posts (id DESC);
        CREATE INDEX IF NOT EXISTS idx_stories_expires
            ON stories (expires_at);
        """
    )
    conn.commit()
    _migrate(conn)

    # seed layout once from communities.json
    row = conn.execute("SELECT COUNT(*) AS n FROM communities").fetchone()
    if row["n"] == 0:
        with open(LAYOUT_SEED, encoding="utf-8") as f:
            seed = json.load(f)
        for community in seed.get("communities", []):
            conn.execute(
                "INSERT INTO communities (id, name, abbr) VALUES (?, ?, ?)",
                (community["id"], community["name"], community["abbr"]),
            )
            for ch in community.get("channels", []):
                conn.execute(
                    """
                    INSERT INTO channels (community_id, id, name, type, topic)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        community["id"],
                        ch["id"],
                        ch["name"],
                        ch.get("type", "text"),
                        ch.get("topic", ""),
                    ),
                )
        conn.commit()

    # private DM space (not shown as a normal community in the rail)
    conn.execute(
        "INSERT OR IGNORE INTO communities (id, name, abbr) VALUES (?, ?, ?)",
        ("_dm", "Direct Messages", "DM"),
    )
    conn.commit()
    conn.close()


def _migrate(conn):
    # older DBs won't have these columns yet - add them if missing
    # (sqlite can't do fancy migrations, so this is the simple version)
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(users)").fetchall()}
    if "status" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'available'")
    if "status_text" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN status_text TEXT NOT NULL DEFAULT ''")
    if "is_admin" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")

    msg_cols = {r["name"] for r in conn.execute("PRAGMA table_info(messages)").fetchall()}
    if "reply_to_id" not in msg_cols:
        conn.execute("ALTER TABLE messages ADD COLUMN reply_to_id INTEGER")
    if "deleted_at" not in msg_cols:
        conn.execute("ALTER TABLE messages ADD COLUMN deleted_at TEXT")
    conn.commit()


def dm_channel_id(user_a, user_b):
    # sort names so A->B and B->A land in the same channel
    a, b = sorted([user_a.lower(), user_b.lower()])
    return f"{a}__{b}"


def ensure_dm_channel(user_a, user_b):
    channel_id = dm_channel_id(user_a, user_b)
    other = user_b if user_a.lower() != user_b.lower() else user_a
    peer = get_user(other)
    name = peer["display_name"] if peer else other
    conn = connect()
    conn.execute(
        """
        INSERT OR IGNORE INTO channels (community_id, id, name, type, topic)
        VALUES ('_dm', ?, ?, 'dm', ?)
        """,
        (channel_id, name, f"Direct message with {name}"),
    )
    # keep both display names usable: store pair topic
    conn.execute(
        "UPDATE channels SET topic = ? WHERE community_id = '_dm' AND id = ?",
        (f"{user_a} / {user_b}", channel_id),
    )
    conn.commit()
    conn.close()
    return channel_id


def are_friends(username, friend_username):
    conn = connect()
    row = conn.execute(
        """
        SELECT 1 FROM friendships
        WHERE user_username = ? AND friend_username = ?
        """,
        (username, friend_username),
    ).fetchone()
    conn.close()
    return row is not None


def get_layout(conn=None):
    # hide the internal _dm community from the normal server rail
    own = False
    if conn is None:
        conn = connect()
        own = True

    communities = []
    for c in conn.execute(
        "SELECT id, name, abbr FROM communities WHERE id != '_dm' ORDER BY name"
    ).fetchall():
        channels = []
        for ch in conn.execute(
            """
            SELECT id, name, type, topic
            FROM channels
            WHERE community_id = ?
            ORDER BY name
            """,
            (c["id"],),
        ).fetchall():
            channels.append(
                {
                    "id": ch["id"],
                    "name": ch["name"],
                    "type": ch["type"],
                    "topic": ch["topic"],
                }
            )
        communities.append(
            {
                "id": c["id"],
                "name": c["name"],
                "abbr": c["abbr"],
                "channels": channels,
            }
        )

    if own:
        conn.close()
    return {"communities": communities}


def list_friends(username):
    conn = connect()
    rows = conn.execute(
        """
        SELECT u.username, u.display_name
        FROM friendships f
        JOIN users u ON u.username = f.friend_username
        WHERE f.user_username = ?
        ORDER BY u.display_name
        """,
        (username,),
    ).fetchall()
    conn.close()
    return [{"username": r["username"], "name": r["display_name"]} for r in rows]


def add_friend(username, friend_username):
    if username == friend_username:
        return False, "you cannot add yourself"
    friend = get_user(friend_username)
    if not friend:
        return False, "no account with that username"
    conn = connect()
    try:
        conn.execute(
            """
            INSERT OR IGNORE INTO friendships (user_username, friend_username)
            VALUES (?, ?)
            """,
            (username, friend_username),
        )
        # add both ways so each person sees the other in their list
        conn.execute(
            """
            INSERT OR IGNORE INTO friendships (user_username, friend_username)
            VALUES (?, ?)
            """,
            (friend_username, username),
        )
        conn.commit()
    finally:
        conn.close()
    return True, friend["display_name"]


def remove_friend(username, friend_username):
    conn = connect()
    conn.execute(
        """
        DELETE FROM friendships
        WHERE (user_username = ? AND friend_username = ?)
           OR (user_username = ? AND friend_username = ?)
        """,
        (username, friend_username, friend_username, username),
    )
    conn.commit()
    conn.close()
    return True


def list_events(community_id, limit=20):
    conn = connect()
    rows = conn.execute(
        """
        SELECT id, community_id, title, starts_at, ends_at, location, created_by
        FROM events
        WHERE community_id = ?
        ORDER BY starts_at ASC
        LIMIT ?
        """,
        (community_id, limit),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def create_event(community_id, title, starts_at, created_by, ends_at="", location=""):
    conn = connect()
    cur = conn.execute(
        """
        INSERT INTO events (community_id, title, starts_at, ends_at, location, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (community_id, title, starts_at, ends_at or None, location or "", created_by),
    )
    event_id = cur.lastrowid
    conn.commit()
    row = conn.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()
    conn.close()
    return dict(row)


def create_user(username, display_name, password_hash, is_admin=False):
    conn = connect()
    try:
        conn.execute(
            """
            INSERT INTO users (username, display_name, password_hash, is_admin)
            VALUES (?, ?, ?, ?)
            """,
            (username, display_name, password_hash, 1 if is_admin else 0),
        )
        conn.commit()
    finally:
        conn.close()


def get_user(username):
    conn = connect()
    row = conn.execute(
        """
        SELECT username, display_name, password_hash, status, status_text, is_admin
        FROM users WHERE username = ?
        """,
        (username,),
    ).fetchone()
    conn.close()
    if not row:
        return None
    data = dict(row)
    data.setdefault("status", "available")
    data.setdefault("status_text", "")
    data["is_admin"] = bool(data.get("is_admin"))
    return data


def set_admin(username, is_admin=True):
    conn = connect()
    conn.execute(
        "UPDATE users SET is_admin = ? WHERE username = ?",
        (1 if is_admin else 0, username),
    )
    conn.commit()
    conn.close()


def user_is_admin(username):
    record = get_user(username)
    return bool(record and record.get("is_admin"))


def set_user_status(username, status, status_text=""):
    allowed = {"available", "busy", "away"}
    if status not in allowed:
        return False, "status must be available, busy, or away"
    conn = connect()
    conn.execute(
        "UPDATE users SET status = ?, status_text = ? WHERE username = ?",
        (status, (status_text or "")[:60], username),
    )
    conn.commit()
    conn.close()
    return True, {"status": status, "status_text": (status_text or "")[:60]}


def update_display_name(username, display_name):
    conn = connect()
    conn.execute(
        "UPDATE users SET display_name = ? WHERE username = ?",
        (display_name, username),
    )
    conn.execute(
        "UPDATE messages SET display_name = ? WHERE username = ? AND is_system = 0",
        (display_name, username),
    )
    conn.commit()
    conn.close()


def update_password(username, password_hash):
    conn = connect()
    conn.execute(
        "UPDATE users SET password_hash = ? WHERE username = ?",
        (password_hash, username),
    )
    conn.commit()
    conn.close()


def rename_community(community_id, name, abbr=None):
    conn = connect()
    if abbr:
        conn.execute(
            "UPDATE communities SET name = ?, abbr = ? WHERE id = ?",
            (name, abbr, community_id),
        )
    else:
        conn.execute(
            "UPDATE communities SET name = ? WHERE id = ?",
            (name, community_id),
        )
    conn.commit()
    conn.close()


def rename_channel(community_id, channel_id, name):
    conn = connect()
    conn.execute(
        "UPDATE channels SET name = ? WHERE community_id = ? AND id = ?",
        (name, community_id, channel_id),
    )
    conn.commit()
    conn.close()


def _reactions_for(conn, message_id):
    rows = conn.execute(
        "SELECT emoji, username FROM reactions WHERE message_id = ?",
        (message_id,),
    ).fetchall()
    out = {}
    for row in rows:
        out.setdefault(row["emoji"], []).append(row["username"])
    return out


def message_to_dict(conn, row):
    reply = None
    reply_to_id = row["reply_to_id"] if "reply_to_id" in row.keys() else None
    if reply_to_id:
        parent = conn.execute(
            """
            SELECT id, username, display_name, text, deleted_at
            FROM messages WHERE id = ?
            """,
            (reply_to_id,),
        ).fetchone()
        if parent:
            reply = {
                "id": parent["id"],
                "user": parent["display_name"],
                "username": parent["username"],
                "text": "(deleted)" if parent["deleted_at"] else parent["text"][:120],
            }

    deleted = bool(row["deleted_at"]) if "deleted_at" in row.keys() else False
    return {
        "id": row["id"],
        "user": row["display_name"],
        "username": row["username"],
        "text": "(message deleted)" if deleted else row["text"],
        "system": bool(row["is_system"]),
        "at": row["created_at"],
        "edited_at": row["edited_at"],
        "deleted": deleted,
        "reply_to": reply,
        "reactions": {} if deleted else _reactions_for(conn, row["id"]),
    }


def channel_history(community_id, channel_id, limit=50, before_id=None):
    # grab the newest messages first, then reverse so the UI gets them
    # in chronological order. before_id is for "load older" scrolling.
    conn = connect()
    if before_id:
        rows = conn.execute(
            """
            SELECT id, username, display_name, text, is_system, created_at, edited_at,
                   reply_to_id, deleted_at
            FROM messages
            WHERE community_id = ? AND channel_id = ? AND is_system = 0 AND id < ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (community_id, channel_id, before_id, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT id, username, display_name, text, is_system, created_at, edited_at,
                   reply_to_id, deleted_at
            FROM messages
            WHERE community_id = ? AND channel_id = ? AND is_system = 0
            ORDER BY id DESC
            LIMIT ?
            """,
            (community_id, channel_id, limit),
        ).fetchall()
    messages = [message_to_dict(conn, r) for r in reversed(rows)]
    oldest = messages[0]["id"] if messages else None
    has_more = False
    if oldest:
        older = conn.execute(
            """
            SELECT 1 FROM messages
            WHERE community_id = ? AND channel_id = ? AND is_system = 0 AND id < ?
            LIMIT 1
            """,
            (community_id, channel_id, oldest),
        ).fetchone()
        has_more = older is not None
    conn.close()
    return {"messages": messages, "has_more": has_more}


def store_message(
    community_id,
    channel_id,
    username,
    display_name,
    text,
    is_system=False,
    at=None,
    reply_to_id=None,
):
    from datetime import datetime, timezone

    created = at or datetime.now(timezone.utc).isoformat()
    conn = connect()
    if reply_to_id is not None:
        parent = conn.execute(
            """
            SELECT id FROM messages
            WHERE id = ? AND community_id = ? AND channel_id = ? AND is_system = 0
            """,
            (reply_to_id, community_id, channel_id),
        ).fetchone()
        if not parent:
            reply_to_id = None

    cur = conn.execute(
        """
        INSERT INTO messages
            (community_id, channel_id, username, display_name, text, is_system, created_at, reply_to_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            community_id,
            channel_id,
            username,
            display_name,
            text,
            1 if is_system else 0,
            created,
            reply_to_id,
        ),
    )
    msg_id = cur.lastrowid
    conn.commit()
    row = conn.execute(
        """
        SELECT id, username, display_name, text, is_system, created_at, edited_at,
               reply_to_id, deleted_at
        FROM messages WHERE id = ?
        """,
        (msg_id,),
    ).fetchone()
    msg = message_to_dict(conn, row)
    conn.close()
    return msg


def delete_message(message_id, username, deleted_at):
    # soft delete - keep the row so replies still make sense
    conn = connect()
    row = conn.execute(
        "SELECT id, username FROM messages WHERE id = ? AND is_system = 0",
        (message_id,),
    ).fetchone()
    if not row or row["username"] != username:
        conn.close()
        return None
    conn.execute(
        "UPDATE messages SET deleted_at = ?, text = ? WHERE id = ?",
        (deleted_at, "", message_id),
    )
    conn.commit()
    row = conn.execute(
        """
        SELECT id, username, display_name, text, is_system, created_at, edited_at,
               reply_to_id, deleted_at
        FROM messages WHERE id = ?
        """,
        (message_id,),
    ).fetchone()
    msg = message_to_dict(conn, row)
    conn.close()
    return msg


def edit_message(message_id, username, text, edited_at):
    conn = connect()
    row = conn.execute(
        "SELECT id, username, deleted_at FROM messages WHERE id = ? AND is_system = 0",
        (message_id,),
    ).fetchone()
    if not row or row["username"] != username or row["deleted_at"]:
        conn.close()
        return None
    conn.execute(
        "UPDATE messages SET text = ?, edited_at = ? WHERE id = ?",
        (text, edited_at, message_id),
    )
    conn.commit()
    row = conn.execute(
        """
        SELECT id, username, display_name, text, is_system, created_at, edited_at,
               reply_to_id, deleted_at
        FROM messages WHERE id = ?
        """,
        (message_id,),
    ).fetchone()
    msg = message_to_dict(conn, row)
    conn.close()
    return msg


def toggle_reaction(message_id, emoji, username):
    conn = connect()
    row = conn.execute(
        "SELECT id, deleted_at FROM messages WHERE id = ? AND is_system = 0",
        (message_id,),
    ).fetchone()
    if not row or row["deleted_at"]:
        conn.close()
        return None

    existing = conn.execute(
        """
        SELECT 1 FROM reactions
        WHERE message_id = ? AND emoji = ? AND username = ?
        """,
        (message_id, emoji, username),
    ).fetchone()
    if existing:
        conn.execute(
            """
            DELETE FROM reactions
            WHERE message_id = ? AND emoji = ? AND username = ?
            """,
            (message_id, emoji, username),
        )
    else:
        conn.execute(
            """
            INSERT INTO reactions (message_id, emoji, username)
            VALUES (?, ?, ?)
            """,
            (message_id, emoji, username),
        )
    conn.commit()
    row = conn.execute(
        """
        SELECT id, username, display_name, text, is_system, created_at, edited_at,
               reply_to_id, deleted_at
        FROM messages WHERE id = ?
        """,
        (message_id,),
    ).fetchone()
    msg = message_to_dict(conn, row)
    conn.close()
    return msg


def pin_message(community_id, channel_id, message_id, username, pinned_at):
    conn = connect()
    row = conn.execute(
        """
        SELECT id FROM messages
        WHERE id = ? AND community_id = ? AND channel_id = ?
              AND is_system = 0 AND deleted_at IS NULL
        """,
        (message_id, community_id, channel_id),
    ).fetchone()
    if not row:
        conn.close()
        return None
    conn.execute(
        """
        INSERT OR REPLACE INTO pins
            (community_id, channel_id, message_id, pinned_by, pinned_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (community_id, channel_id, message_id, username, pinned_at),
    )
    conn.commit()
    conn.close()
    return list_pins(community_id, channel_id)


def unpin_message(community_id, channel_id, message_id):
    conn = connect()
    conn.execute(
        """
        DELETE FROM pins
        WHERE community_id = ? AND channel_id = ? AND message_id = ?
        """,
        (community_id, channel_id, message_id),
    )
    conn.commit()
    conn.close()
    return list_pins(community_id, channel_id)


def list_pins(community_id, channel_id):
    conn = connect()
    rows = conn.execute(
        """
        SELECT p.message_id, p.pinned_by, p.pinned_at,
               m.display_name, m.text, m.deleted_at
        FROM pins p
        JOIN messages m ON m.id = p.message_id
        WHERE p.community_id = ? AND p.channel_id = ?
        ORDER BY p.pinned_at DESC
        """,
        (community_id, channel_id),
    ).fetchall()
    out = []
    for r in rows:
        out.append(
            {
                "id": r["message_id"],
                "user": r["display_name"],
                "text": "(deleted)" if r["deleted_at"] else r["text"][:160],
                "pinned_by": r["pinned_by"],
                "pinned_at": r["pinned_at"],
            }
        )
    conn.close()
    return out


def mark_channel_read(username, community_id, channel_id, last_read_id):
    conn = connect()
    conn.execute(
        """
        INSERT INTO channel_reads (username, community_id, channel_id, last_read_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(username, community_id, channel_id)
        DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)
        """,
        (username, community_id, channel_id, last_read_id),
    )
    conn.commit()
    conn.close()


def unread_summary(username):
    # count messages newer than whatever this user last opened
    conn = connect()
    # normal community channels
    channel_rows = conn.execute(
        """
        SELECT c.community_id, c.id AS channel_id, c.name, c.type,
               COALESCE(r.last_read_id, 0) AS last_read_id,
               COALESCE(
                 (SELECT MAX(m.id) FROM messages m
                  WHERE m.community_id = c.community_id
                    AND m.channel_id = c.id
                    AND m.is_system = 0
                    AND m.deleted_at IS NULL),
                 0
               ) AS latest_id
        FROM channels c
        LEFT JOIN channel_reads r
          ON r.community_id = c.community_id
         AND r.channel_id = c.id
         AND r.username = ?
        WHERE c.community_id != '_dm'
        """,
        (username,),
    ).fetchall()

    channels = []
    for row in channel_rows:
        count = 0
        if row["latest_id"] > row["last_read_id"]:
            count = conn.execute(
                """
                SELECT COUNT(*) AS n FROM messages
                WHERE community_id = ? AND channel_id = ?
                  AND is_system = 0 AND deleted_at IS NULL
                  AND id > ?
                """,
                (row["community_id"], row["channel_id"], row["last_read_id"]),
            ).fetchone()["n"]
        if count:
            channels.append(
                {
                    "community": row["community_id"],
                    "channel": row["channel_id"],
                    "name": row["name"],
                    "unread": count,
                }
            )

    # DM channels involving this user
    dm_rows = conn.execute(
        """
        SELECT c.id AS channel_id, c.name,
               COALESCE(r.last_read_id, 0) AS last_read_id,
               COALESCE(
                 (SELECT MAX(m.id) FROM messages m
                  WHERE m.community_id = '_dm' AND m.channel_id = c.id
                    AND m.is_system = 0 AND m.deleted_at IS NULL),
                 0
               ) AS latest_id
        FROM channels c
        LEFT JOIN channel_reads r
          ON r.community_id = '_dm' AND r.channel_id = c.id AND r.username = ?
        WHERE c.community_id = '_dm'
          AND (c.id LIKE ? OR c.id LIKE ?)
        """,
        (username, f"{username}__%", f"%__{username}"),
    ).fetchall()

    dms = []
    for row in dm_rows:
        count = 0
        if row["latest_id"] > row["last_read_id"]:
            count = conn.execute(
                """
                SELECT COUNT(*) AS n FROM messages
                WHERE community_id = '_dm' AND channel_id = ?
                  AND is_system = 0 AND deleted_at IS NULL AND id > ?
                """,
                (row["channel_id"], row["last_read_id"]),
            ).fetchone()["n"]
        if count:
            dms.append(
                {
                    "community": "_dm",
                    "channel": row["channel_id"],
                    "name": row["name"],
                    "unread": count,
                }
            )

    conn.close()
    return {"channels": channels, "dms": dms}


def list_dm_threads(username):
    conn = connect()
    rows = conn.execute(
        """
        SELECT id, name, topic FROM channels
        WHERE community_id = '_dm'
          AND (id LIKE ? OR id LIKE ?)
        ORDER BY name
        """,
        (f"{username}__%", f"%__{username}"),
    ).fetchall()
    conn.close()
    out = []
    for r in rows:
        parts = r["id"].split("__")
        peer = parts[1] if parts[0] == username else parts[0]
        peer_user = get_user(peer)
        out.append(
            {
                "channel": r["id"],
                "peer": peer,
                "name": peer_user["display_name"] if peer_user else r["name"],
            }
        )
    return out


def _post_to_dict(conn, row, viewer_username):
    post_id = row["id"]
    likes = conn.execute(
        "SELECT username FROM post_likes WHERE post_id = ? ORDER BY username",
        (post_id,),
    ).fetchall()
    like_users = [r["username"] for r in likes]
    comments = conn.execute(
        """
        SELECT id, username, display_name, text, created_at
        FROM post_comments WHERE post_id = ?
        ORDER BY id ASC
        """,
        (post_id,),
    ).fetchall()
    return {
        "id": post_id,
        "username": row["username"],
        "user": row["display_name"],
        "text": row["text"],
        "image_url": row["image_url"] or "",
        "at": row["created_at"],
        "like_count": len(like_users),
        "liked_by_me": viewer_username in like_users,
        "comments": [
            {
                "id": c["id"],
                "username": c["username"],
                "user": c["display_name"],
                "text": c["text"],
                "at": c["created_at"],
            }
            for c in comments
        ],
    }


def create_post(username, display_name, text, image_url=""):
    # posts can be text, an image url, or both (instagram-ish)
    from datetime import datetime, timezone

    text = (text or "").strip()
    image_url = (image_url or "").strip()
    if not text and not image_url:
        return None, "write something or add an image url"
    if len(text) > 280:
        return None, "post is too long (280 max, like X)"
    if image_url and not (
        image_url.startswith("http://") or image_url.startswith("https://")
    ):
        return None, "image url must start with http:// or https://"
    if len(image_url) > 500:
        return None, "image url is too long"

    created = datetime.now(timezone.utc).isoformat()
    conn = connect()
    cur = conn.execute(
        """
        INSERT INTO posts (username, display_name, text, image_url, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (username, display_name, text, image_url, created),
    )
    post_id = cur.lastrowid
    conn.commit()
    row = conn.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone()
    post = _post_to_dict(conn, row, username)
    conn.close()
    return post, None


def list_feed(viewer_username, limit=30, before_id=None):
    # show your posts + friends' posts, newest first
    # (basically a tiny linkedin/instagram timeline)
    friends = [f["username"] for f in list_friends(viewer_username)]
    authors = [viewer_username] + friends
    placeholders = ",".join("?" for _ in authors)

    conn = connect()
    params = list(authors)
    sql = f"""
        SELECT id, username, display_name, text, image_url, created_at
        FROM posts
        WHERE username IN ({placeholders})
    """
    if before_id:
        sql += " AND id < ?"
        params.append(before_id)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(limit)

    rows = conn.execute(sql, params).fetchall()
    posts = [_post_to_dict(conn, r, viewer_username) for r in rows]
    has_more = False
    if posts:
        older = conn.execute(
            f"""
            SELECT 1 FROM posts
            WHERE username IN ({placeholders}) AND id < ?
            LIMIT 1
            """,
            authors + [posts[-1]["id"]],
        ).fetchone()
        has_more = older is not None
    conn.close()
    return {"posts": posts, "has_more": has_more, "append": before_id is not None}


def get_post(post_id, viewer_username):
    conn = connect()
    row = conn.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone()
    if not row:
        conn.close()
        return None
    if row["username"] != viewer_username and not are_friends(viewer_username, row["username"]):
        conn.close()
        return None
    post = _post_to_dict(conn, row, viewer_username)
    conn.close()
    return post


def toggle_post_like(post_id, username):
    # same pattern as message reactions - click again to unlike
    conn = connect()
    row = conn.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone()
    if not row:
        conn.close()
        return None
    if row["username"] != username and not are_friends(username, row["username"]):
        conn.close()
        return None
    existing = conn.execute(
        "SELECT 1 FROM post_likes WHERE post_id = ? AND username = ?",
        (post_id, username),
    ).fetchone()
    if existing:
        conn.execute(
            "DELETE FROM post_likes WHERE post_id = ? AND username = ?",
            (post_id, username),
        )
    else:
        conn.execute(
            "INSERT INTO post_likes (post_id, username) VALUES (?, ?)",
            (post_id, username),
        )
    conn.commit()
    post = _post_to_dict(conn, row, username)
    conn.close()
    return post


def add_post_comment(post_id, username, display_name, text):
    from datetime import datetime, timezone

    text = (text or "").strip()
    if not text:
        return None, "comment cannot be empty"
    if len(text) > 500:
        return None, "comment is too long"

    conn = connect()
    row = conn.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone()
    if not row:
        conn.close()
        return None, "post not found"
    if row["username"] != username and not are_friends(username, row["username"]):
        conn.close()
        return None, "post not found"
    conn.execute(
        """
        INSERT INTO post_comments (post_id, username, display_name, text, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (post_id, username, display_name, text, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    post = _post_to_dict(conn, row, username)
    conn.close()
    return post, None


def delete_post(post_id, username):
    conn = connect()
    row = conn.execute(
        "SELECT username FROM posts WHERE id = ?", (post_id,)
    ).fetchone()
    if not row or row["username"] != username:
        conn.close()
        return False
    conn.execute("DELETE FROM posts WHERE id = ?", (post_id,))
    conn.commit()
    conn.close()
    return True


def _purge_expired_stories(conn):
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat()
    conn.execute("DELETE FROM stories WHERE expires_at <= ?", (now,))


def create_story(username, display_name, text="", image_url="", bg_color="#1c212b"):
    # stories last 24 hours then get wiped
    from datetime import datetime, timedelta, timezone

    text = (text or "").strip()
    image_url = (image_url or "").strip()
    if not text and not image_url:
        return None, "add some text or an image url"
    if len(text) > 280:
        return None, "story text is too long (keep it under 280)"
    if image_url and not (
        image_url.startswith("http://") or image_url.startswith("https://")
    ):
        return None, "image url must start with http:// or https://"
    if len(image_url) > 500:
        return None, "image url is too long"

    # a few safe background colours for text-only stories
    allowed_bg = {
        "#1c212b",
        "#0f766e",
        "#1d4ed8",
        "#7c2d12",
        "#4c1d95",
        "#134e4a",
        "#9f1239",
    }
    if bg_color not in allowed_bg:
        bg_color = "#1c212b"

    now = datetime.now(timezone.utc)
    expires = now + timedelta(hours=24)
    conn = connect()
    _purge_expired_stories(conn)
    cur = conn.execute(
        """
        INSERT INTO stories
            (username, display_name, text, image_url, bg_color, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            username,
            display_name,
            text,
            image_url,
            bg_color,
            now.isoformat(),
            expires.isoformat(),
        ),
    )
    story_id = cur.lastrowid
    conn.commit()
    row = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
    story = dict(row)
    conn.close()
    return story, None


def list_story_groups(viewer_username):
    """
    Group active stories by user for the rings UI.
    Viewer sees their own + friends' stories.
    """
    from datetime import datetime, timezone

    friends = [f["username"] for f in list_friends(viewer_username)]
    authors = [viewer_username] + friends
    if not authors:
        return []

    placeholders = ",".join("?" for _ in authors)
    now = datetime.now(timezone.utc).isoformat()
    conn = connect()
    _purge_expired_stories(conn)
    conn.commit()

    rows = conn.execute(
        f"""
        SELECT id, username, display_name, text, image_url, bg_color,
               created_at, expires_at
        FROM stories
        WHERE username IN ({placeholders}) AND expires_at > ?
        ORDER BY username ASC, id ASC
        """,
        authors + [now],
    ).fetchall()

    groups = {}
    for row in rows:
        uname = row["username"]
        viewed = conn.execute(
            """
            SELECT 1 FROM story_views
            WHERE story_id = ? AND viewer_username = ?
            """,
            (row["id"], viewer_username),
        ).fetchone()
        item = {
            "id": row["id"],
            "username": row["username"],
            "user": row["display_name"],
            "text": row["text"],
            "image_url": row["image_url"],
            "bg_color": row["bg_color"],
            "at": row["created_at"],
            "expires_at": row["expires_at"],
            "seen": viewed is not None,
        }
        if uname not in groups:
            groups[uname] = {
                "username": uname,
                "user": row["display_name"],
                "is_me": uname == viewer_username,
                "stories": [],
                "has_unseen": False,
            }
        groups[uname]["stories"].append(item)
        if not item["seen"]:
            groups[uname]["has_unseen"] = True

    conn.close()

    # your own ring first, then unseen friends, then the rest
    out = list(groups.values())
    out.sort(
        key=lambda g: (
            0 if g["is_me"] else 1,
            0 if g["has_unseen"] else 1,
            g["user"].lower(),
        )
    )
    return out


def mark_story_viewed(story_id, viewer_username):
    from datetime import datetime, timezone

    conn = connect()
    row = conn.execute(
        "SELECT id, username FROM stories WHERE id = ? AND expires_at > ?",
        (story_id, datetime.now(timezone.utc).isoformat()),
    ).fetchone()
    if not row:
        conn.close()
        return False
    if row["username"] != viewer_username and not are_friends(viewer_username, row["username"]):
        conn.close()
        return False
    conn.execute(
        """
        INSERT OR IGNORE INTO story_views (story_id, viewer_username, viewed_at)
        VALUES (?, ?, ?)
        """,
        (story_id, viewer_username, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    conn.close()
    return True


def delete_story(story_id, username):
    conn = connect()
    row = conn.execute(
        "SELECT username FROM stories WHERE id = ?", (story_id,)
    ).fetchone()
    if not row or row["username"] != username:
        conn.close()
        return False
    conn.execute("DELETE FROM stories WHERE id = ?", (story_id,))
    conn.commit()
    conn.close()
    return True


def story_view_count(story_id):
    conn = connect()
    n = conn.execute(
        "SELECT COUNT(*) AS n FROM story_views WHERE story_id = ?",
        (story_id,),
    ).fetchone()["n"]
    conn.close()
    return n
