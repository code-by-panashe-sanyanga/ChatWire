"""
Extra SQLite tables for ChatWire social features.

Friend requests, blocks, reports, follows, post votes, boards, live sessions,
plus Wave (Clips / Wire / Rooms / Pulse / Boards / Hubs).
Keeps the core schema in db.py untouched - just IF NOT EXISTS tables on top.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

import db

_HASHTAG_RE = re.compile(r"#([A-Za-z0-9]+)")


def _now():
    return datetime.now(timezone.utc).isoformat()


def _ensure_column(conn, table, column, ddl_suffix):
    cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl_suffix}")


def init_ext():
    conn = db.connect()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS friend_requests (
            from_user TEXT NOT NULL,
            to_user TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (from_user, to_user)
        );

        CREATE TABLE IF NOT EXISTS blocks (
            blocker TEXT NOT NULL,
            blocked TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (blocker, blocked)
        );

        CREATE TABLE IF NOT EXISTS reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            reporter TEXT NOT NULL,
            target_username TEXT NOT NULL,
            target_type TEXT NOT NULL,
            target_id TEXT NOT NULL,
            reason TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS follows (
            follower TEXT NOT NULL,
            following TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (follower, following)
        );

        CREATE TABLE IF NOT EXISTS post_votes (
            post_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            value INTEGER NOT NULL,
            PRIMARY KEY (post_id, username)
        );

        CREATE TABLE IF NOT EXISTS boards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_username TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS board_pins (
            board_id INTEGER NOT NULL,
            post_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (board_id, post_id)
        );

        CREATE TABLE IF NOT EXISTS live_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            community_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            host_username TEXT NOT NULL,
            title TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        );

        -- Wave: hashtags for Wire trends
        CREATE TABLE IF NOT EXISTS hashtags (
            tag TEXT NOT NULL,
            post_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (tag, post_id)
        );

        -- Wave / Pulse: ephemeral 1:1 snaps
        CREATE TABLE IF NOT EXISTS snaps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_user TEXT NOT NULL,
            to_user TEXT NOT NULL,
            text TEXT NOT NULL DEFAULT '',
            media_url TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            opened_at TEXT
        );
        """
    )
    # Wave columns on core posts/comments (safe ALTER)
    _ensure_column(conn, "posts", "media_kind", "TEXT NOT NULL DEFAULT 'image'")
    _ensure_column(conn, "posts", "quote_of", "INTEGER")
    _ensure_column(conn, "posts", "community_id", "TEXT NOT NULL DEFAULT ''")
    _ensure_column(conn, "post_comments", "parent_id", "INTEGER")
    conn.commit()
    conn.close()


# --- friend requests ---------------------------------------------------------


def send_friend_request(from_user, to_user):
    from_user = (from_user or "").strip()
    to_user = (to_user or "").strip()
    if not from_user or not to_user:
        return False, "missing username"
    if from_user == to_user:
        return False, "you cannot add yourself"
    if not db.get_user(to_user):
        return False, "no account with that username"
    if is_blocked(from_user, to_user):
        return False, "cannot send request"
    if db.are_friends(from_user, to_user):
        return False, "already friends"

    conn = db.connect()
    existing = conn.execute(
        """
        SELECT 1 FROM friend_requests
        WHERE from_user = ? AND to_user = ?
        """,
        (from_user, to_user),
    ).fetchone()
    if existing:
        conn.close()
        return False, "request already sent"

    # if they already requested us, just accept
    incoming = conn.execute(
        """
        SELECT 1 FROM friend_requests
        WHERE from_user = ? AND to_user = ?
        """,
        (to_user, from_user),
    ).fetchone()
    if incoming:
        conn.close()
        return accept_friend_request(from_user, to_user)

    conn.execute(
        """
        INSERT INTO friend_requests (from_user, to_user, created_at)
        VALUES (?, ?, ?)
        """,
        (from_user, to_user, _now()),
    )
    conn.commit()
    conn.close()
    return True, None


def accept_friend_request(to_user, from_user):
    conn = db.connect()
    row = conn.execute(
        """
        SELECT 1 FROM friend_requests
        WHERE from_user = ? AND to_user = ?
        """,
        (from_user, to_user),
    ).fetchone()
    if not row:
        conn.close()
        return False, "no pending request"
    conn.execute(
        """
        DELETE FROM friend_requests
        WHERE from_user = ? AND to_user = ?
        """,
        (from_user, to_user),
    )
    conn.commit()
    conn.close()
    ok, detail = db.add_friend(to_user, from_user)
    if not ok:
        return False, detail
    return True, None


def decline_friend_request(to_user, from_user):
    conn = db.connect()
    conn.execute(
        """
        DELETE FROM friend_requests
        WHERE from_user = ? AND to_user = ?
        """,
        (from_user, to_user),
    )
    conn.commit()
    conn.close()
    return True, None


def list_incoming_requests(username):
    conn = db.connect()
    rows = conn.execute(
        """
        SELECT fr.from_user AS username, u.display_name AS name, fr.created_at
        FROM friend_requests fr
        LEFT JOIN users u ON u.username = fr.from_user
        WHERE fr.to_user = ?
        ORDER BY fr.created_at DESC
        """,
        ((username or "").lower(),),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def list_outgoing_requests(username):
    conn = db.connect()
    rows = conn.execute(
        """
        SELECT fr.to_user AS username, u.display_name AS name, fr.created_at
        FROM friend_requests fr
        LEFT JOIN users u ON u.username = fr.to_user
        WHERE fr.from_user = ?
        ORDER BY fr.created_at DESC
        """,
        ((username or "").lower(),),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# --- blocks ------------------------------------------------------------------


def block_user(blocker, blocked):
    blocker = (blocker or "").strip()
    blocked = (blocked or "").strip()
    if not blocker or not blocked or blocker == blocked:
        return False, "invalid block"
    conn = db.connect()
    conn.execute(
        """
        INSERT OR IGNORE INTO blocks (blocker, blocked, created_at)
        VALUES (?, ?, ?)
        """,
        (blocker, blocked, _now()),
    )
    # drop any pending friend requests both ways
    conn.execute(
        """
        DELETE FROM friend_requests
        WHERE (from_user = ? AND to_user = ?)
           OR (from_user = ? AND to_user = ?)
        """,
        (blocker, blocked, blocked, blocker),
    )
    conn.commit()
    conn.close()
    if hasattr(db, "remove_friend"):
        db.remove_friend(blocker, blocked)
    return True, None


def unblock_user(blocker, blocked):
    conn = db.connect()
    conn.execute(
        "DELETE FROM blocks WHERE blocker = ? AND blocked = ?",
        (blocker, blocked),
    )
    conn.commit()
    conn.close()
    return True, None


def is_blocked(a, b):
    # either direction counts as blocked
    conn = db.connect()
    row = conn.execute(
        """
        SELECT 1 FROM blocks
        WHERE (blocker = ? AND blocked = ?)
           OR (blocker = ? AND blocked = ?)
        """,
        (a, b, b, a),
    ).fetchone()
    conn.close()
    return row is not None


def list_blocks(username):
    conn = db.connect()
    rows = conn.execute(
        """
        SELECT blocker, blocked, created_at
        FROM blocks
        WHERE blocker = ?
        ORDER BY created_at DESC
        """,
        (username,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# --- reports -----------------------------------------------------------------


def create_report(reporter, target_username, target_type, target_id, reason):
    reason = (reason or "").strip()
    if not reason:
        return None, "reason required"
    conn = db.connect()
    cur = conn.execute(
        """
        INSERT INTO reports
            (reporter, target_username, target_type, target_id, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            reporter,
            target_username or "",
            target_type or "",
            str(target_id or ""),
            reason[:500],
            _now(),
        ),
    )
    report_id = cur.lastrowid
    conn.commit()
    row = conn.execute("SELECT * FROM reports WHERE id = ?", (report_id,)).fetchone()
    conn.close()
    return dict(row), None


# --- follows -----------------------------------------------------------------


def follow_user(follower, following):
    follower = (follower or "").strip()
    following = (following or "").strip()
    if not follower or not following:
        return False, "missing username"
    if follower == following:
        return False, "you cannot follow yourself"
    if not db.get_user(following):
        return False, "no account with that username"
    if is_blocked(follower, following):
        return False, "cannot follow"
    conn = db.connect()
    conn.execute(
        """
        INSERT OR IGNORE INTO follows (follower, following, created_at)
        VALUES (?, ?, ?)
        """,
        (follower, following, _now()),
    )
    conn.commit()
    conn.close()
    return True, None


def unfollow_user(follower, following):
    conn = db.connect()
    conn.execute(
        "DELETE FROM follows WHERE follower = ? AND following = ?",
        (follower, following),
    )
    conn.commit()
    conn.close()
    return True, None


def is_following(follower, following):
    conn = db.connect()
    row = conn.execute(
        """
        SELECT 1 FROM follows
        WHERE follower = ? AND following = ?
        """,
        (follower, following),
    ).fetchone()
    conn.close()
    return row is not None


def list_following(username):
    conn = db.connect()
    rows = conn.execute(
        """
        SELECT f.following AS username, u.display_name, f.created_at
        FROM follows f
        LEFT JOIN users u ON u.username = f.following
        WHERE f.follower = ?
        ORDER BY f.created_at DESC
        """,
        (username,),
    ).fetchall()
    conn.close()
    return [
        {
            "username": r["username"],
            "name": r["display_name"] or r["username"],
            "created_at": r["created_at"],
        }
        for r in rows
    ]


def list_followers(username):
    conn = db.connect()
    rows = conn.execute(
        """
        SELECT f.follower AS username, u.display_name, f.created_at
        FROM follows f
        LEFT JOIN users u ON u.username = f.follower
        WHERE f.following = ?
        ORDER BY f.created_at DESC
        """,
        (username,),
    ).fetchall()
    conn.close()
    return [
        {
            "username": r["username"],
            "name": r["display_name"] or r["username"],
            "created_at": r["created_at"],
        }
        for r in rows
    ]


# --- post votes --------------------------------------------------------------


def vote_post(post_id, username, value):
    try:
        value = int(value)
    except (TypeError, ValueError):
        return False, "invalid vote"
    if value not in (-1, 0, 1):
        return False, "value must be -1, 0, or 1"

    conn = db.connect()
    post = conn.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone()
    if not post:
        conn.close()
        return False, "post not found"
    if not _can_see_post(username, post):
        conn.close()
        return False, "post not found"

    if value == 0:
        conn.execute(
            "DELETE FROM post_votes WHERE post_id = ? AND username = ?",
            (post_id, username),
        )
    else:
        conn.execute(
            """
            INSERT INTO post_votes (post_id, username, value)
            VALUES (?, ?, ?)
            ON CONFLICT(post_id, username)
            DO UPDATE SET value = excluded.value
            """,
            (post_id, username, value),
        )
    conn.commit()
    conn.close()
    return True, {
        "score": get_vote_score(post_id),
        "my_vote": 0 if value == 0 else get_user_vote(post_id, username),
    }


def get_vote_score(post_id):
    conn = db.connect()
    row = conn.execute(
        "SELECT COALESCE(SUM(value), 0) AS score FROM post_votes WHERE post_id = ?",
        (post_id,),
    ).fetchone()
    conn.close()
    return int(row["score"]) if row else 0


def get_user_vote(post_id, username):
    conn = db.connect()
    row = conn.execute(
        "SELECT value FROM post_votes WHERE post_id = ? AND username = ?",
        (post_id, username),
    ).fetchone()
    conn.close()
    return int(row["value"]) if row else 0


# --- discover feed -----------------------------------------------------------


def list_discover_posts(viewer, limit=30, before_id=None):
    """Explore For you: network posts, media-first for pin masonry."""
    friends = [f["username"] for f in db.list_friends(viewer)]
    following = [f["username"] for f in list_following(viewer)]
    authors = list({viewer, *friends, *following})
    if not authors:
        return {"posts": [], "has_more": False}

    placeholders = ",".join("?" for _ in authors)
    conn = db.connect()
    params = list(authors)
    sql = f"""
        SELECT *
        FROM posts
        WHERE username IN ({placeholders})
          AND COALESCE(image_url, '') != ''
    """
    if before_id:
        sql += " AND id < ?"
        params.append(before_id)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(limit + 1)

    rows = conn.execute(sql, params).fetchall()
    has_more = len(rows) > limit
    rows = rows[:limit]
    posts = [_wave_post_to_dict(conn, r, viewer) for r in rows]
    conn.close()
    return {"posts": posts, "has_more": has_more}


# --- boards ------------------------------------------------------------------


def create_board(owner_username, name):
    name = (name or "").strip()
    if not name:
        return None, "name required"
    if len(name) > 80:
        return None, "name too long"
    conn = db.connect()
    cur = conn.execute(
        """
        INSERT INTO boards (owner_username, name, created_at)
        VALUES (?, ?, ?)
        """,
        (owner_username, name, _now()),
    )
    board_id = cur.lastrowid
    conn.commit()
    row = conn.execute("SELECT * FROM boards WHERE id = ?", (board_id,)).fetchone()
    conn.close()
    return dict(row), None


def list_boards(owner):
    conn = db.connect()
    rows = conn.execute(
        """
        SELECT b.id, b.owner_username, b.name, b.created_at,
               (SELECT COUNT(*) FROM board_pins bp WHERE bp.board_id = b.id) AS pin_count
        FROM boards b
        WHERE b.owner_username = ?
        ORDER BY b.id DESC
        """,
        (owner,),
    ).fetchall()
    conn.close()
    out = []
    for r in rows:
        item = dict(r)
        item["pin_count"] = int(item.get("pin_count") or 0)
        out.append(item)
    return out


def pin_post_to_board(board_id, post_id, viewer=None):
    conn = db.connect()
    board = conn.execute("SELECT id FROM boards WHERE id = ?", (board_id,)).fetchone()
    post = conn.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone()
    if not board or not post:
        conn.close()
        return False, "board or post not found"
    if viewer and not _can_see_post(viewer, post):
        conn.close()
        return False, "post not found"
    conn.execute(
        """
        INSERT OR IGNORE INTO board_pins (board_id, post_id, created_at)
        VALUES (?, ?, ?)
        """,
        (board_id, post_id, _now()),
    )
    conn.commit()
    conn.close()
    return True, None


def unpin_post_from_board(board_id, post_id, owner_username):
    """Remove a saved pin. Only the board owner can unpin."""
    conn = db.connect()
    board = conn.execute(
        "SELECT id FROM boards WHERE id = ? AND owner_username = ?",
        (board_id, owner_username),
    ).fetchone()
    if not board:
        conn.close()
        return False, "board not found"
    cur = conn.execute(
        "DELETE FROM board_pins WHERE board_id = ? AND post_id = ?",
        (board_id, post_id),
    )
    conn.commit()
    removed = cur.rowcount > 0
    conn.close()
    return (True, None) if removed else (False, "pin not found")


def count_saved_pins(owner):
    conn = db.connect()
    row = conn.execute(
        """
        SELECT COUNT(*) AS n
        FROM board_pins bp
        JOIN boards b ON b.id = bp.board_id
        WHERE b.owner_username = ?
        """,
        (owner,),
    ).fetchone()
    conn.close()
    return int(row["n"] if row else 0)


def list_user_posts(viewer, target_username, limit=30, before_id=None, quotes_only=False):
    """Posts authored by target_username (for profile grid)."""
    target = (target_username or "").strip()
    if not target:
        return {"posts": [], "has_more": False}
    if is_blocked(viewer, target):
        return {"posts": [], "has_more": False}
    conn = db.connect()
    params = [target]
    sql = """
        SELECT *
        FROM posts
        WHERE username = ?
    """
    if quotes_only:
        sql += " AND quote_of IS NOT NULL"
    else:
        sql += " AND quote_of IS NULL"
    if before_id:
        sql += " AND id < ?"
        params.append(int(before_id))
    # Over-fetch so visibility filtering still fills a page.
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(max(int(limit) * 4, 40))
    rows = conn.execute(sql, params).fetchall()
    visible = [r for r in rows if _can_see_post(viewer, r)]
    has_more = len(visible) > limit
    visible = visible[:limit]
    posts = [_wave_post_to_dict(conn, r, viewer) for r in visible]
    conn.close()
    return {
        "posts": posts,
        "has_more": has_more,
        "username": target,
        "quotes_only": bool(quotes_only),
    }


def count_user_reposts(username):
    conn = db.connect()
    row = conn.execute(
        """
        SELECT COUNT(*) AS n FROM posts
        WHERE username = ? AND quote_of IS NOT NULL
        """,
        (username,),
    ).fetchone()
    conn.close()
    return int(row["n"] if row else 0)


def profile_stats(viewer, target_username=None):
    """Lightweight counts for You / profile surface."""
    target = (target_username or viewer or "").strip()
    if not target:
        return {}
    conn = db.connect()
    post_rows = conn.execute(
        """
        SELECT * FROM posts
        WHERE username = ? AND quote_of IS NULL
        """,
        (target,),
    ).fetchall()
    quote_rows = conn.execute(
        """
        SELECT * FROM posts
        WHERE username = ? AND quote_of IS NOT NULL
        """,
        (target,),
    ).fetchall()
    user_row = conn.execute(
        "SELECT display_name, avatar_url, status, status_text FROM users WHERE username = ?",
        (target,),
    ).fetchone()
    conn.close()
    is_self = target == viewer
    visible_posts = [r for r in post_rows if _can_see_post(viewer, r)]
    visible_reposts = [r for r in quote_rows if _can_see_post(viewer, r)]
    followers = list_followers(target)
    boards = list_boards(target) if is_self else []
    return {
        "username": target,
        "display_name": (user_row["display_name"] if user_row else target) or target,
        "avatar_url": (user_row["avatar_url"] if user_row else "") or "",
        "status": (user_row["status"] if user_row else "available") or "available",
        "status_text": (user_row["status_text"] if user_row else "") or "",
        "is_self": is_self,
        "posts": len(post_rows) if is_self else len(visible_posts),
        "followers": len(followers),
        "reposts": len(quote_rows) if is_self else len(visible_reposts),
        "boards": len(boards),
        "saved": count_saved_pins(target) if is_self else 0,
        "followers_users": followers if is_self else [],
        "board_list": boards if is_self else [],
    }


def list_board_pins(board_id, viewer):
    conn = db.connect()
    rows = conn.execute(
        """
        SELECT p.id, p.username, p.display_name, p.text, p.image_url, p.created_at,
               bp.created_at AS pinned_at
        FROM board_pins bp
        JOIN posts p ON p.id = bp.post_id
        WHERE bp.board_id = ?
        ORDER BY bp.created_at DESC
        """,
        (board_id,),
    ).fetchall()
    out = []
    for r in rows:
        post_id = r["id"]
        score_row = conn.execute(
            "SELECT COALESCE(SUM(value), 0) AS score FROM post_votes WHERE post_id = ?",
            (post_id,),
        ).fetchone()
        my_row = conn.execute(
            "SELECT value FROM post_votes WHERE post_id = ? AND username = ?",
            (post_id, viewer),
        ).fetchone()
        out.append(
            {
                "id": post_id,
                "user": r["display_name"],
                "username": r["username"],
                "text": r["text"],
                "image_url": r["image_url"] or "",
                "at": r["created_at"],
                "pinned_at": r["pinned_at"],
                "score": int(score_row["score"]) if score_row else 0,
                "my_vote": int(my_row["value"]) if my_row else 0,
            }
        )
    conn.close()
    return out


# --- live sessions -----------------------------------------------------------


def start_live(community, channel, host, title):
    title = (title or "").strip() or "Live"
    conn = db.connect()
    # one active session per host
    conn.execute(
        "UPDATE live_sessions SET active = 0 WHERE host_username = ? AND active = 1",
        (host,),
    )
    cur = conn.execute(
        """
        INSERT INTO live_sessions
            (community_id, channel_id, host_username, title, active, created_at)
        VALUES (?, ?, ?, ?, 1, ?)
        """,
        (community, channel, host, title[:120], _now()),
    )
    session_id = cur.lastrowid
    conn.commit()
    row = conn.execute(
        "SELECT * FROM live_sessions WHERE id = ?", (session_id,)
    ).fetchone()
    conn.close()
    return dict(row)


def end_live(host):
    conn = db.connect()
    conn.execute(
        "UPDATE live_sessions SET active = 0 WHERE host_username = ? AND active = 1",
        (host,),
    )
    conn.commit()
    conn.close()
    return True


def get_active_live(community, channel):
    conn = db.connect()
    row = conn.execute(
        """
        SELECT id, community_id, channel_id, host_username, title, active, created_at
        FROM live_sessions
        WHERE community_id = ? AND channel_id = ? AND active = 1
        ORDER BY id DESC
        LIMIT 1
        """,
        (community, channel),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def list_active_lives():
    conn = db.connect()
    rows = conn.execute(
        """
        SELECT id, community_id, channel_id, host_username, title, active, created_at
        FROM live_sessions
        WHERE active = 1
        ORDER BY id DESC
        """
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# --- Wave helpers (Clips / Wire / Rooms / Pulse / Boards / Hubs) --------------


def _feed_authors(viewer):
    friends = [f["username"] for f in db.list_friends(viewer)]
    following = [f["username"] for f in list_following(viewer)]
    return list({viewer, *friends, *following})


def _blocked_sql():
    return """
        NOT EXISTS (
            SELECT 1 FROM blocks
            WHERE (blocker = ? AND blocked = p.username)
               OR (blocker = p.username AND blocked = ?)
        )
    """


def _age_hours(created_at):
    try:
        created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        hours = (datetime.now(timezone.utc) - created).total_seconds() / 3600.0
        return max(hours, 0.1)
    except (TypeError, ValueError, AttributeError):
        return 24.0


def _hot_score(vote_score, like_count, comment_count, created_at):
    return (vote_score * 2 + like_count + comment_count) / _age_hours(created_at)


def _quote_stub(conn, quote_of):
    if not quote_of:
        return None
    try:
        qid = int(quote_of)
    except (TypeError, ValueError):
        return None
    row = conn.execute(
        """
        SELECT id, username, display_name, text, image_url, media_kind, community_id
        FROM posts WHERE id = ?
        """,
        (qid,),
    ).fetchone()
    if not row:
        return None
    return {
        "id": row["id"],
        "username": row["username"],
        "user": row["display_name"],
        "text": row["text"],
        "image_url": row["image_url"] or "",
        "media_kind": row["media_kind"] if "media_kind" in row.keys() else "image",
        "community_id": row["community_id"] if "community_id" in row.keys() else "",
    }


def _wave_post_to_dict(conn, row, viewer_username):
    post_id = row["id"]
    likes = conn.execute(
        "SELECT username FROM post_likes WHERE post_id = ? ORDER BY username",
        (post_id,),
    ).fetchall()
    like_users = [r["username"] for r in likes]
    comments = conn.execute(
        """
        SELECT id, username, display_name, text, created_at, parent_id
        FROM post_comments WHERE post_id = ?
        ORDER BY id ASC
        """,
        (post_id,),
    ).fetchall()
    score_row = conn.execute(
        "SELECT COALESCE(SUM(value), 0) AS score FROM post_votes WHERE post_id = ?",
        (post_id,),
    ).fetchone()
    vote_score = int(score_row["score"]) if score_row else 0
    my_row = conn.execute(
        "SELECT value FROM post_votes WHERE post_id = ? AND username = ?",
        (post_id, viewer_username),
    ).fetchone()
    user_vote = int(my_row["value"]) if my_row else 0
    keys = row.keys() if hasattr(row, "keys") else []
    media_kind = row["media_kind"] if "media_kind" in keys else "image"
    quote_of = row["quote_of"] if "quote_of" in keys else None
    community_id = row["community_id"] if "community_id" in keys else ""
    return {
        "id": post_id,
        "username": row["username"],
        "user": row["display_name"],
        "text": row["text"],
        "image_url": row["image_url"] or "",
        "media_kind": media_kind or "image",
        "quote_of": _quote_stub(conn, quote_of),
        "quote_of_id": quote_of,
        "community_id": community_id or "",
        "at": row["created_at"],
        "like_count": len(like_users),
        "liked_by_me": viewer_username in like_users,
        "comment_count": len(comments),
        "vote_score": vote_score,
        "user_vote": user_vote,
        "comments": [
            {
                "id": c["id"],
                "username": c["username"],
                "user": c["display_name"],
                "text": c["text"],
                "at": c["created_at"],
                "parent_id": c["parent_id"],
            }
            for c in comments
        ],
    }


def get_wave_post(post_id, viewer_username):
    """Load one Wave-shaped post if the viewer may see it."""
    conn = db.connect()
    row = conn.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone()
    if not row or not _can_see_post(viewer_username, row):
        conn.close()
        return None
    post = _wave_post_to_dict(conn, row, viewer_username)
    conn.close()
    return post



def extract_and_save_hashtags(post_id, text):
    """Parse #tags from text (lowercase alnum) and store for Wire trends."""
    tags = sorted({m.group(1).lower() for m in _HASHTAG_RE.finditer(text or "")})
    if not tags:
        return tags
    now = _now()
    conn = db.connect()
    for tag in tags:
        conn.execute(
            """
            INSERT OR IGNORE INTO hashtags (tag, post_id, created_at)
            VALUES (?, ?, ?)
            """,
            (tag, post_id, now),
        )
    conn.commit()
    conn.close()
    return tags


def create_wave_post(
    username,
    display_name,
    text,
    image_url="",
    media_kind="image",
    quote_of=None,
    community_id="",
):
    """Create a Wire/Clips/Rooms post; video kinds need a media url."""
    import uploads as upload_mod

    text = (text or "").strip()
    image_url = (image_url or "").strip()
    media_kind = (media_kind or "image").strip().lower()
    community_id = (community_id or "").strip()
    if media_kind not in ("text", "image", "video"):
        return None, "media_kind must be text, image, or video"
    if media_kind == "video" and not image_url:
        return None, "video clips need a media url"
    if len(text) > 280:
        return None, "post is too long (280 max)"
    if image_url and not upload_mod.is_allowed_media_url(image_url):
        return None, "use an uploaded file or an http(s) media link"
    if len(image_url) > 500:
        return None, "media url is too long"
    if len(community_id) > 40:
        return None, "community_id too long"

    qid = None
    if quote_of is not None and quote_of != "":
        try:
            qid = int(quote_of)
        except (TypeError, ValueError):
            return None, "invalid quote_of"
        conn = db.connect()
        quoted = conn.execute("SELECT * FROM posts WHERE id = ?", (qid,)).fetchone()
        conn.close()
        if not quoted or not _can_see_post(username, quoted):
            return None, "quoted post not found"

    if not text and not image_url and qid is None:
        return None, "write something or add media"

    if media_kind == "text" and not image_url:
        media_kind = "text"
    elif image_url and media_kind not in ("video", "image"):
        media_kind = "image"

    created = _now()
    conn = db.connect()
    cur = conn.execute(
        """
        INSERT INTO posts
            (username, display_name, text, image_url, created_at,
             media_kind, quote_of, community_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            username,
            display_name,
            text,
            image_url,
            created,
            media_kind,
            qid,
            community_id,
        ),
    )
    post_id = cur.lastrowid
    conn.commit()
    row = conn.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone()
    post = _wave_post_to_dict(conn, row, username)
    conn.close()
    extract_and_save_hashtags(post_id, text)
    return post, None


def _rank_posts(conn, rows, viewer, limit):
    scored = []
    for r in rows:
        post = _wave_post_to_dict(conn, r, viewer)
        score = _hot_score(
            post["vote_score"],
            post["like_count"],
            post["comment_count"],
            post["at"],
        )
        scored.append((score, post["id"], post))
    scored.sort(key=lambda x: (-x[0], -x[1]))
    posts = [p for _, _, p in scored[:limit]]
    has_more = len(scored) > limit
    return {"posts": posts, "has_more": has_more}


def list_clips(viewer, limit=20, before_id=None):
    """Clips For You: any non-blocked video, hot-ranked (not friends-only)."""
    conn = db.connect()
    params = [viewer, viewer]
    sql = f"""
        SELECT p.*
        FROM posts p
        WHERE COALESCE(p.media_kind, '') = 'video'
          AND {_blocked_sql()}
    """
    if before_id:
        sql += " AND p.id < ?"
        params.append(int(before_id))
    sql += " ORDER BY p.id DESC LIMIT ?"
    params.append(max(limit * 4, 60))
    rows = conn.execute(sql, params).fetchall()
    rows = [r for r in rows if _can_see_post(viewer, r)]
    payload = _rank_posts(conn, rows, viewer, limit)
    conn.close()
    return payload


def list_foryou_posts(viewer, limit=30, before_id=None):
    """Wire For You: network + room posts + recent videos, hot-ranked."""
    authors = _feed_authors(viewer)
    conn = db.connect()
    if authors:
        placeholders = ",".join("?" for _ in authors)
        where = (
            f"(p.username IN ({placeholders}) "
            f"OR COALESCE(p.community_id, '') != '' "
            f"OR COALESCE(p.media_kind, '') = 'video')"
        )
        params = list(authors) + [viewer, viewer]
    else:
        where = (
            "COALESCE(p.community_id, '') != '' "
            "OR COALESCE(p.media_kind, '') = 'video'"
        )
        params = [viewer, viewer]

    sql = f"""
        SELECT p.*
        FROM posts p
        WHERE {where}
          AND {_blocked_sql()}
    """
    if before_id:
        sql += " AND p.id < ?"
        params.append(int(before_id))
    sql += " ORDER BY p.id DESC LIMIT ?"
    params.append(max(limit * 4, 80))
    rows = conn.execute(sql, params).fetchall()
    rows = [r for r in rows if _can_see_post(viewer, r)]
    payload = _rank_posts(conn, rows, viewer, limit)
    conn.close()
    return payload


def list_trending_tags(limit=12):
    """Hashtag counts from the last 7 days for Wire trends."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    conn = db.connect()
    rows = conn.execute(
        """
        SELECT tag, COUNT(*) AS count
        FROM hashtags
        WHERE created_at >= ?
        GROUP BY tag
        ORDER BY count DESC, tag ASC
        LIMIT ?
        """,
        (cutoff, limit),
    ).fetchall()
    conn.close()
    return [{"tag": r["tag"], "count": int(r["count"])} for r in rows]


def list_room_posts(viewer, community_id, sort="hot", limit=30):
    """Rooms: posts for a community_id, sorted hot or new."""
    community_id = (community_id or "").strip()
    if not community_id:
        return {"posts": [], "has_more": False}
    sort = (sort or "hot").strip().lower()
    if sort not in ("hot", "new"):
        sort = "hot"

    conn = db.connect()
    rows = conn.execute(
        f"""
        SELECT p.*
        FROM posts p
        WHERE p.community_id = ?
          AND {_blocked_sql()}
        ORDER BY p.id DESC
        LIMIT ?
        """,
        (community_id, viewer, viewer, max(limit * 4, 80) if sort == "hot" else limit + 1),
    ).fetchall()

    if sort == "new":
        posts = [_wave_post_to_dict(conn, r, viewer) for r in rows[:limit]]
        has_more = len(rows) > limit
        conn.close()
        return {"posts": posts, "has_more": has_more, "community_id": community_id}

    payload = _rank_posts(conn, rows, viewer, limit)
    payload["community_id"] = community_id
    conn.close()
    return payload


def _can_see_post(viewer, row):
    author = row["username"]
    if author == viewer:
        return True
    if is_blocked(viewer, author):
        return False
    if db.are_friends(viewer, author):
        return True
    if is_following(viewer, author):
        return True
    keys = row.keys() if hasattr(row, "keys") else []
    community_id = row["community_id"] if "community_id" in keys else ""
    if community_id:
        return True
    return False


def add_comment(post_id, username, display_name, text, parent_id=None):
    """Threaded Rooms/Wire comment; parent_id for replies."""
    text = (text or "").strip()
    if not text:
        return None, "comment cannot be empty"
    if len(text) > 500:
        return None, "comment is too long"

    pid = None
    if parent_id is not None and parent_id != "":
        try:
            pid = int(parent_id)
        except (TypeError, ValueError):
            return None, "invalid parent_id"

    conn = db.connect()
    row = conn.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone()
    if not row:
        conn.close()
        return None, "post not found"
    if not _can_see_post(username, row):
        conn.close()
        return None, "post not found"
    if pid is not None:
        parent = conn.execute(
            "SELECT id FROM post_comments WHERE id = ? AND post_id = ?",
            (pid, post_id),
        ).fetchone()
        if not parent:
            conn.close()
            return None, "parent comment not found"

    conn.execute(
        """
        INSERT INTO post_comments
            (post_id, username, display_name, text, created_at, parent_id)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (post_id, username, display_name, text, _now(), pid),
    )
    conn.commit()
    post = _wave_post_to_dict(conn, row, username)
    conn.close()
    return post, None


def send_snap(from_user, to_user, text, media_url=""):
    """Pulse: send an ephemeral snap (24h). Requires friendship."""
    from_user = (from_user or "").strip()
    to_user = (to_user or "").strip()
    text = (text or "").strip()
    media_url = (media_url or "").strip()
    if not from_user or not to_user:
        return None, "missing user"
    if from_user == to_user:
        return None, "cannot snap yourself"
    if not db.get_user(to_user):
        return None, "user not found"
    if is_blocked(from_user, to_user):
        return None, "cannot send snap"
    if not db.are_friends(from_user, to_user):
        return None, "snaps require friendship"
    if not text and not media_url:
        return None, "write something or add media"
    if len(text) > 500:
        return None, "snap text too long"
    if media_url:
        import uploads as upload_mod

        if not upload_mod.is_allowed_media_url(media_url):
            return None, "invalid media url"
        if len(media_url) > 500:
            return None, "media url too long"

    created = datetime.now(timezone.utc)
    expires = created + timedelta(hours=24)
    conn = db.connect()
    cur = conn.execute(
        """
        INSERT INTO snaps
            (from_user, to_user, text, media_url, created_at, expires_at, opened_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL)
        """,
        (
            from_user,
            to_user,
            text,
            media_url,
            created.isoformat(),
            expires.isoformat(),
        ),
    )
    snap_id = cur.lastrowid
    conn.commit()
    row = conn.execute("SELECT * FROM snaps WHERE id = ?", (snap_id,)).fetchone()
    conn.close()
    return dict(row), None


def list_snaps_inbox(username):
    """Unexpired Pulse snaps addressed to username (newest first)."""
    now = _now()
    conn = db.connect()
    rows = conn.execute(
        """
        SELECT id, from_user, to_user, text, media_url, created_at, expires_at, opened_at
        FROM snaps
        WHERE to_user = ? AND expires_at > ?
        ORDER BY id DESC
        """,
        (username, now),
    ).fetchall()
    out = []
    for r in rows:
        if is_blocked(username, r["from_user"]):
            continue
        out.append(dict(r))
    conn.close()
    return out


def open_snap(snap_id, username):
    """Mark a Pulse snap opened; hide if expired or not for this user."""
    now = _now()
    conn = db.connect()
    row = conn.execute("SELECT * FROM snaps WHERE id = ?", (snap_id,)).fetchone()
    if not row:
        conn.close()
        return None, "snap not found"
    if row["to_user"] != username:
        conn.close()
        return None, "snap not found"
    if row["expires_at"] <= now:
        conn.close()
        return None, "snap expired"
    if is_blocked(username, row["from_user"]):
        conn.close()
        return None, "snap not found"
    if not row["opened_at"]:
        conn.execute(
            "UPDATE snaps SET opened_at = ? WHERE id = ?",
            (now, snap_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM snaps WHERE id = ?", (snap_id,)).fetchone()
    snap = dict(row)
    conn.close()
    return snap, None


def list_board_pins_enriched(board_id, viewer):
    """Boards: pins with post image/text/media_kind for masonry."""
    conn = db.connect()
    rows = conn.execute(
        """
        SELECT p.id, p.username, p.display_name, p.text, p.image_url, p.created_at,
               COALESCE(p.media_kind, 'image') AS media_kind,
               COALESCE(p.community_id, '') AS community_id,
               bp.created_at AS pinned_at
        FROM board_pins bp
        JOIN posts p ON p.id = bp.post_id
        WHERE bp.board_id = ?
        ORDER BY bp.created_at DESC
        """,
        (board_id,),
    ).fetchall()
    out = []
    for r in rows:
        if is_blocked(viewer, r["username"]):
            continue
        post_id = r["id"]
        score_row = conn.execute(
            "SELECT COALESCE(SUM(value), 0) AS score FROM post_votes WHERE post_id = ?",
            (post_id,),
        ).fetchone()
        my_row = conn.execute(
            "SELECT value FROM post_votes WHERE post_id = ? AND username = ?",
            (post_id, viewer),
        ).fetchone()
        likes = conn.execute(
            "SELECT COUNT(*) AS n FROM post_likes WHERE post_id = ?",
            (post_id,),
        ).fetchone()
        out.append(
            {
                "id": post_id,
                "user": r["display_name"],
                "username": r["username"],
                "text": r["text"],
                "image_url": r["image_url"] or "",
                "media_kind": r["media_kind"] or "image",
                "community_id": r["community_id"] or "",
                "at": r["created_at"],
                "pinned_at": r["pinned_at"],
                "vote_score": int(score_row["score"]) if score_row else 0,
                "user_vote": int(my_row["value"]) if my_row else 0,
                "like_count": int(likes["n"]) if likes else 0,
            }
        )
    conn.close()
    return out


# Hubs: Discord-style channel message pins (thin wrappers)

def hub_pin_message(community_id, channel_id, message_id, username):
    return db.pin_message(community_id, channel_id, message_id, username, _now())


def hub_list_pins(community_id, channel_id):
    return db.list_pins(community_id, channel_id)


def hub_unpin_message(community_id, channel_id, message_id):
    return db.unpin_message(community_id, channel_id, message_id)
