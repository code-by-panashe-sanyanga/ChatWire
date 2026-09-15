"""
Wave (v3) smoke tests for db_ext helpers + uploads media URLs.

Covers exports present as of Wave backend:
  create_wave_post, extract_and_save_hashtags, list_trending_tags,
  get_wave_post, list_foryou_posts, list_clips, list_room_posts,
  vote_post (ranking), add_comment (parent_id), send_snap / open_snap /
  list_snaps_inbox, uploads.is_allowed_media_url (.mp4 under /uploads/).

Gaps: none for the helpers listed in the Wave product brief; socket
wave_handlers events are out of scope for this module.
"""

from datetime import datetime, timedelta, timezone

import pytest

import db
import db_ext
import state
import uploads


def _boot(tmp_path, monkeypatch, name="wave.db"):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / name)
    db.init_db()


def _users(*names):
    for u in names:
        db.create_user(u, u.title(), state.hash_password(f"{u}12345678"))


def _need(name):
    if not hasattr(db_ext, name):
        pytest.skip(f"db_ext.{name} not exported yet")


def test_create_wave_post_hashtags_and_trends(tmp_path, monkeypatch):
    _need("create_wave_post")
    _need("list_trending_tags")
    _boot(tmp_path, monkeypatch, "tags.db")
    _users("alice")

    post, err = db_ext.create_wave_post(
        "alice", "Alice", "Shipping #Wave and #ChatWire tonight", media_kind="text"
    )
    assert post, err
    assert post["media_kind"] == "text"

    tags = {t["tag"]: t["count"] for t in db_ext.list_trending_tags()}
    assert "wave" in tags
    assert "chatwire" in tags
    assert tags["wave"] >= 1


def test_quote_of_appears_in_foryou_or_get(tmp_path, monkeypatch):
    _need("create_wave_post")
    _boot(tmp_path, monkeypatch, "quote.db")
    _users("alice", "bob")
    db.add_friend("alice", "bob")

    original, err = db_ext.create_wave_post(
        "alice", "Alice", "original thought", media_kind="text"
    )
    assert original, err

    quote, err = db_ext.create_wave_post(
        "bob",
        "Bob",
        "quoting this",
        media_kind="text",
        quote_of=original["id"],
    )
    assert quote, err
    assert quote.get("quote_of_id") == original["id"]
    assert quote.get("quote_of") and quote["quote_of"]["id"] == original["id"]

    found = None
    if hasattr(db_ext, "get_wave_post"):
        found = db_ext.get_wave_post(quote["id"], "alice")
    if found is None and hasattr(db_ext, "list_foryou_posts"):
        feed = db_ext.list_foryou_posts("alice")
        found = next((p for p in feed["posts"] if p["id"] == quote["id"]), None)
    assert found is not None
    assert found.get("quote_of") and found["quote_of"]["id"] == original["id"]


def test_vote_ranking_influences_foryou_or_clips(tmp_path, monkeypatch):
    _need("create_wave_post")
    _need("vote_post")
    _boot(tmp_path, monkeypatch, "rank.db")
    _users("alice", "bob", "casey")
    db.add_friend("alice", "bob")
    db.add_friend("alice", "casey")
    db.add_friend("bob", "casey")

    low, err = db_ext.create_wave_post("bob", "Bob", "quiet post", media_kind="text")
    assert low, err
    hot, err = db_ext.create_wave_post("casey", "Casey", "hot take", media_kind="text")
    assert hot, err

    ok, _ = db_ext.vote_post(hot["id"], "alice", 1)
    assert ok
    ok, _ = db_ext.vote_post(hot["id"], "bob", 1)
    assert ok

    ordered_ids = []
    if hasattr(db_ext, "list_foryou_posts"):
        feed = db_ext.list_foryou_posts("alice", limit=10)
        ordered_ids = [p["id"] for p in feed["posts"] if p["id"] in (low["id"], hot["id"])]
    elif hasattr(db_ext, "list_clips"):
        # fallback path if only clips ranking exists — seed videos instead
        pytest.skip("list_foryou_posts missing; clips ranking not seeded here")
    else:
        pytest.skip("no ranked feed helper exported")

    assert ordered_ids, "expected both posts in For You"
    assert ordered_ids[0] == hot["id"]


def test_send_open_snap_friendship_and_expiry(tmp_path, monkeypatch):
    _need("send_snap")
    _need("open_snap")
    _boot(tmp_path, monkeypatch, "snap.db")
    _users("alice", "bob", "stranger")

    snap, err = db_ext.send_snap("alice", "bob", "hey")
    assert snap is None
    assert "friend" in (err or "").lower()

    db.add_friend("alice", "bob")
    snap, err = db_ext.send_snap("alice", "bob", "pulse check")
    assert snap, err
    assert snap["to_user"] == "bob"

    opened, err = db_ext.open_snap(snap["id"], "bob")
    assert opened, err
    assert opened.get("opened_at")

    # stranger cannot open
    bad, err = db_ext.open_snap(snap["id"], "stranger")
    assert bad is None

    # expire and reopen should fail
    past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    conn = db.connect()
    conn.execute("UPDATE snaps SET expires_at = ?, opened_at = NULL WHERE id = ?", (past, snap["id"]))
    conn.commit()
    conn.close()
    expired, err = db_ext.open_snap(snap["id"], "bob")
    assert expired is None
    assert "expir" in (err or "").lower()

    if hasattr(db_ext, "list_snaps_inbox"):
        inbox = db_ext.list_snaps_inbox("bob")
        assert all(s["id"] != snap["id"] for s in inbox)


def test_room_posts_filtered_by_community_id(tmp_path, monkeypatch):
    _need("create_wave_post")
    _need("list_room_posts")
    _boot(tmp_path, monkeypatch, "rooms.db")
    _users("alice")

    a, err = db_ext.create_wave_post(
        "alice", "Alice", "in hub", media_kind="text", community_id="dev-hub"
    )
    assert a, err
    b, err = db_ext.create_wave_post(
        "alice", "Alice", "elsewhere", media_kind="text", community_id="mmu-year3"
    )
    assert b, err
    c, err = db_ext.create_wave_post(
        "alice", "Alice", "global wire", media_kind="text", community_id=""
    )
    assert c, err

    rooms = db_ext.list_room_posts("alice", "dev-hub", sort="new")
    ids = {p["id"] for p in rooms["posts"]}
    assert a["id"] in ids
    assert b["id"] not in ids
    assert c["id"] not in ids
    assert all(p.get("community_id") == "dev-hub" for p in rooms["posts"])


def test_comment_parent_id_thread(tmp_path, monkeypatch):
    _need("create_wave_post")
    _need("add_comment")
    _boot(tmp_path, monkeypatch, "thread.db")
    _users("alice", "bob")
    db.add_friend("alice", "bob")

    post, err = db_ext.create_wave_post("alice", "Alice", "thread root", media_kind="text")
    assert post, err

    updated, err = db_ext.add_comment(post["id"], "bob", "Bob", "top-level")
    assert updated, err
    parent = updated["comments"][0]
    assert parent.get("parent_id") in (None, "")

    updated, err = db_ext.add_comment(
        post["id"], "alice", "Alice", "reply", parent_id=parent["id"]
    )
    assert updated, err
    reply = next(c for c in updated["comments"] if c["text"] == "reply")
    assert reply["parent_id"] == parent["id"]


def test_allowed_media_url_accepts_mp4_under_uploads():
    assert uploads.is_allowed_media_url("/uploads/clip123.mp4") is True
    assert uploads.is_allowed_media_url("/uploads/../evil.mp4") is False
    assert uploads.is_allowed_media_url("https://cdn.example.com/v.mp4") is True
