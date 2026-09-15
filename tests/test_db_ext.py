"""Smoke tests for ChatWire v2 social extensions."""

import db
import db_ext
import state
from app import app


def test_friend_request_flow(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "t.db")
    db.init_db()
    db.create_user("alice", "Alice", state.hash_password("alice12345"))
    db.create_user("bob", "Bob", state.hash_password("bob12345678"))
    ok, err = db_ext.send_friend_request("alice", "bob")
    assert ok, err
    incoming = db_ext.list_incoming_requests("bob")
    assert incoming and incoming[0]["username"] == "alice"
    ok, name = db_ext.accept_friend_request("bob", "alice")
    assert ok
    friends = {f["username"] for f in db.list_friends("alice")}
    assert "bob" in friends


def test_vote_and_discover(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "t2.db")
    db.init_db()
    db.create_user("alice", "Alice", state.hash_password("alice12345"))
    db.create_user("bob", "Bob", state.hash_password("bob12345678"))
    db.add_friend("alice", "bob")
    post, err = db.create_post(
        "alice", "Alice", "hello discover", "https://picsum.photos/seed/discover1/600/800"
    )
    assert post, err
    ok, detail = db_ext.vote_post(post["id"], "bob", 1)
    assert ok
    assert detail["score"] == 1
    feed = db_ext.list_discover_posts("bob")
    assert any(p["id"] == post["id"] for p in feed["posts"])


def test_live_session(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "t3.db")
    db.init_db()
    db.create_user("alice", "Alice", state.hash_password("alice12345"))
    live = db_ext.start_live("dev-hub", "general", "alice", "Standup live")
    assert live["active"] in (True, 1)
    assert db_ext.get_active_live("dev-hub", "general")["host_username"] == "alice"
    db_ext.end_live("alice")
    assert db_ext.get_active_live("dev-hub", "general") is None


def test_profile_saved_is_private(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "t-profile.db")
    db.init_db()
    db.create_user("alice", "Alice", state.hash_password("alice12345"))
    db.create_user("bob", "Bob", state.hash_password("bob12345678"))
    board, board_err = db_ext.create_board("alice", "Favorites")
    assert board, board_err
    post, err = db.create_post(
        "alice", "Alice", "pin me", "https://picsum.photos/seed/priv/400/400"
    )
    assert post, err
    ok, _ = db_ext.pin_post_to_board(board["id"], post["id"], "alice")
    assert ok
    own = db_ext.profile_stats("alice", "alice")
    assert own["is_self"] is True
    assert own["saved"] >= 1
    assert own["board_list"]
    other = db_ext.profile_stats("bob", "alice")
    assert other["is_self"] is False
    assert other["saved"] == 0
    assert other["board_list"] == []
    # Strangers don't see friends-only post counts
    assert other["posts"] == 0


def test_strangers_cannot_list_private_profile_posts(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "t-profile-posts.db")
    db.init_db()
    db.create_user("alice", "Alice", state.hash_password("alice12345"))
    db.create_user("bob", "Bob", state.hash_password("bob12345678"))
    post, err = db.create_post("alice", "Alice", "friends only vibe", "")
    assert post, err
    # No friendship: Bob must not see Alice's friends-only posts on her profile
    visible = db_ext.list_user_posts("bob", "alice")
    assert visible["posts"] == []
    # Alice sees her own
    mine = db_ext.list_user_posts("alice", "alice")
    assert any(p["id"] == post["id"] for p in mine["posts"])


def test_cannot_quote_unseen_post(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "t-quote-priv.db")
    db.init_db()
    db.create_user("alice", "Alice", state.hash_password("alice12345"))
    db.create_user("bob", "Bob", state.hash_password("bob12345678"))
    post, err = db.create_post("alice", "Alice", "secret sauce", "")
    assert post, err
    quoted, qerr = db_ext.create_wave_post(
        "bob", "Bob", "trying to leak", quote_of=post["id"]
    )
    assert quoted is None
    assert "not found" in (qerr or "").lower()


def test_version_and_ice_routes():
    client = app.test_client()
    v = client.get("/api/version")
    assert v.status_code == 200
    body = v.get_json()
    assert body["version"] == "4.4.0"
    assert body.get("codename") == "wave"
    ice = client.get("/api/webrtc/ice")
    assert ice.status_code == 200
    servers = ice.get_json()["iceServers"]
    assert any("stun:" in str(s.get("urls")) for s in servers)
