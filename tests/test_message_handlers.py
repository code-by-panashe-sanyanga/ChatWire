from validate import require_str
import db
import state


def test_require_str_strips_text():
    ok, value = require_str({"text": "  hello  "}, "text")
    assert ok is True
    assert value == "hello"


def test_require_str_rejects_blank():
    ok, err = require_str({"text": "   "}, "text")
    assert ok is False


def test_store_and_react_message_in_sql(tmp_path, monkeypatch):
    # use a throwaway database file for the test
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.db")
    db.init_db()
    state.bootstrap = lambda: None  # already inited

    msg = db.store_message("dev-hub", "general", "alice", "Alice", "nice")
    assert msg["text"] == "nice"
    assert msg["user"] == "Alice"

    updated = db.toggle_reaction(msg["id"], "🔥", "bob")
    assert updated["reactions"]["🔥"] == ["bob"]

    updated = db.toggle_reaction(msg["id"], "🔥", "bob")
    assert "🔥" not in updated["reactions"]


def test_feed_posts_likes_and_comments(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "feed.db")
    db.init_db()
    db.create_user("alice", "Alice", "x")
    db.create_user("bob", "Bob", "x")
    db.add_friend("alice", "bob")

    post, err = db.create_post("bob", "Bob", "hello feed", "https://example.com/a.jpg")
    assert err is None
    assert post["text"] == "hello feed"

    feed = db.list_feed("alice")
    assert len(feed["posts"]) == 1

    liked = db.toggle_post_like(post["id"], "alice")
    assert liked["liked_by_me"] is True
    assert liked["like_count"] == 1

    commented, err = db.add_post_comment(post["id"], "alice", "Alice", "nice pic")
    assert err is None
    assert commented["comments"][0]["text"] == "nice pic"


def test_strangers_cannot_access_friends_only_post(tmp_path, monkeypatch):
    # a post from bob should only be readable/likeable/commentable by bob
    # himself or his friends - not by any other authenticated user who
    # just guesses the (sequential, easily-guessable) post id
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "feed_privacy.db")
    db.init_db()
    db.create_user("alice", "Alice", "x")
    db.create_user("bob", "Bob", "x")
    db.create_user("mallory", "Mallory", "x")
    db.add_friend("alice", "bob")
    # note: mallory is NOT friends with bob

    post, err = db.create_post("bob", "Bob", "private-ish update", "")
    assert err is None

    # alice (bob's friend) can see, like, and comment
    assert db.get_post(post["id"], "alice") is not None
    liked = db.toggle_post_like(post["id"], "alice")
    assert liked is not None and liked["liked_by_me"] is True
    commented, err = db.add_post_comment(post["id"], "alice", "Alice", "hey!")
    assert err is None and commented is not None

    # mallory (a stranger) cannot see, like, or comment on the same post
    assert db.get_post(post["id"], "mallory") is None
    assert db.toggle_post_like(post["id"], "mallory") is None
    blocked_comment, err = db.add_post_comment(post["id"], "mallory", "Mallory", "hi")
    assert blocked_comment is None
    assert err == "post not found"

    # bob can always see his own post
    assert db.get_post(post["id"], "bob") is not None


def test_strangers_cannot_mark_friends_only_story_viewed(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "story_privacy.db")
    db.init_db()
    db.create_user("alice", "Alice", "x")
    db.create_user("bob", "Bob", "x")
    db.create_user("mallory", "Mallory", "x")
    db.add_friend("alice", "bob")

    story, err = db.create_story("bob", "Bob", "just posted", "", "#111")
    assert err is None

    assert db.mark_story_viewed(story["id"], "alice") is True
    assert db.mark_story_viewed(story["id"], "mallory") is False


def test_status_and_stories(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "stories.db")
    db.init_db()
    db.create_user("alice", "Alice", "x")
    db.create_user("bob", "Bob", "x")
    db.add_friend("alice", "bob")

    ok, detail = db.set_user_status("alice", "busy", "In labs")
    assert ok is True
    assert detail["status"] == "busy"
    assert db.get_user("alice")["status_text"] == "In labs"

    story, err = db.create_story("bob", "Bob", "hello", "", "#0f766e")
    assert err is None
    groups = db.list_story_groups("alice")
    assert len(groups) == 1
    assert groups[0]["username"] == "bob"
    assert db.mark_story_viewed(story["id"], "alice") is True


def test_edit_only_own_message(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test2.db")
    db.init_db()

    msg = db.store_message("dev-hub", "general", "alice", "Alice", "first")
    assert db.edit_message(msg["id"], "bob", "hacked", "now") is None
    edited = db.edit_message(msg["id"], "alice", "second", "now")
    assert edited["text"] == "second"
