"""Socket.IO handler smoke tests using Flask-SocketIO's test client."""

import db
import state
from app import app, socketio


def _arg0(packet):
    args = packet.get("args")
    if isinstance(args, (list, tuple)):
        return args[0] if args else None
    return args


def _setup_temp_db(path):
    db.DB_PATH = path
    state.sessions.clear()
    state._login_failures.clear()
    if path.exists():
        path.unlink()
    db.init_db()
    state.refresh_layout()
    if not db.get_user("demo"):
        db.create_user(
            "demo", "Demo User", state.hash_password(state.DEMO_PASSWORD), is_admin=True
        )
    else:
        db.set_admin("demo", True)


def test_login_then_send_message(tmp_path):
    _setup_temp_db(tmp_path / "sock.db")

    client = socketio.test_client(app, flask_test_client=app.test_client())
    client.emit(
        "session_start",
        {
            "username": "demo",
            "password": state.DEMO_PASSWORD,
            "community": "dev-hub",
            "channel": "general",
        },
    )
    received = client.get_received()
    names = [packet["name"] for packet in received]
    assert "session_ready" in names, received
    assert "channel_history" in names

    client.emit("message", {"text": "hello from test"})
    received = client.get_received()
    messages = [
        p
        for p in received
        if p["name"] == "message" and _arg0(p) and not _arg0(p).get("system")
    ]
    assert messages
    assert _arg0(messages[-1])["text"] == "hello from test"
    client.disconnect()


def test_blank_message_emits_message_error(tmp_path):
    _setup_temp_db(tmp_path / "sock3.db")
    client = socketio.test_client(app, flask_test_client=app.test_client())
    client.emit(
        "session_start",
        {
            "username": "demo",
            "password": state.DEMO_PASSWORD,
            "community": "dev-hub",
            "channel": "general",
        },
    )
    client.get_received()
    client.emit("message", {"text": "   "})
    out = client.get_received()
    errors = [p for p in out if p["name"] == "message_error"]
    assert errors
    client.disconnect()


def test_load_older_messages_pagination(tmp_path):
    _setup_temp_db(tmp_path / "sock4.db")
    for i in range(55):
        db.store_message("dev-hub", "general", "demo", "Demo User", f"msg {i}")

    client = socketio.test_client(app, flask_test_client=app.test_client())
    client.emit(
        "session_start",
        {
            "username": "demo",
            "password": state.DEMO_PASSWORD,
            "community": "dev-hub",
            "channel": "general",
        },
    )
    received = client.get_received()
    hist = [p for p in received if p["name"] == "channel_history"]
    assert hist
    payload = _arg0(hist[-1])
    assert len(payload["messages"]) == 50
    assert payload["has_more"] is True
    oldest = payload["messages"][0]["id"]

    client.emit("load_older_messages", {"before_id": oldest})
    older = [p for p in client.get_received() if p["name"] == "older_messages"]
    assert older
    batch = _arg0(older[-1])
    assert len(batch["messages"]) == 5
    assert batch["has_more"] is False
    client.disconnect()


def test_cannot_edit_someone_elses_message(tmp_path):
    _setup_temp_db(tmp_path / "sock2.db")
    db.create_user("alice", "Alice", state.hash_password("password1"))
    db.create_user("bob", "Bob", state.hash_password("password1"))

    alice = socketio.test_client(app, flask_test_client=app.test_client())
    alice.emit(
        "session_start",
        {
            "username": "alice",
            "password": "password1",
            "community": "dev-hub",
            "channel": "general",
        },
    )
    alice.get_received()
    alice.emit("message", {"text": "only alice"})
    packets = alice.get_received()
    msgs = [
        p
        for p in packets
        if p["name"] == "message" and _arg0(p) and not _arg0(p).get("system")
    ]
    assert msgs, packets
    msg_id = _arg0(msgs[-1])["id"]

    bob = socketio.test_client(app, flask_test_client=app.test_client())
    bob.emit(
        "session_start",
        {
            "username": "bob",
            "password": "password1",
            "community": "dev-hub",
            "channel": "general",
        },
    )
    bob.get_received()
    bob.emit("edit_message", {"id": msg_id, "text": "hijack"})
    out = bob.get_received()
    errors = [p for p in out if p["name"] == "edit_error"]
    assert errors
    alice.disconnect()
    bob.disconnect()


def _login(client, username, password):
    client.emit(
        "session_start",
        {
            "username": username,
            "password": password,
            "community": "dev-hub",
            "channel": "general",
        },
    )
    return client.get_received()


def test_non_admin_cannot_rename_channel(tmp_path):
    _setup_temp_db(tmp_path / "sock_admin.db")
    db.create_user("bob", "Bob", state.hash_password("password1"), is_admin=False)

    bob = socketio.test_client(app, flask_test_client=app.test_client())
    _login(bob, "bob", "password1")
    bob.emit(
        "rename_channel",
        {"community_id": "dev-hub", "channel_id": "general", "name": "hacked"},
    )
    out = bob.get_received()
    errors = [p for p in out if p["name"] == "channel_error"]
    assert errors
    assert "admin" in (_arg0(errors[-1]).get("error") or "").lower()
    layout = db.get_layout()
    general = next(
        ch
        for c in layout["communities"]
        if c["id"] == "dev-hub"
        for ch in c["channels"]
        if ch["id"] == "general"
    )
    assert general["name"] != "hacked"
    bob.disconnect()


def test_admin_can_rename_channel(tmp_path):
    _setup_temp_db(tmp_path / "sock_admin2.db")
    demo = socketio.test_client(app, flask_test_client=app.test_client())
    ready = _login(demo, "demo", state.DEMO_PASSWORD)
    session = [p for p in ready if p["name"] == "session_ready"]
    assert session
    assert _arg0(session[-1]).get("is_admin") is True

    demo.emit(
        "rename_channel",
        {"community_id": "dev-hub", "channel_id": "general", "name": "lobby"},
    )
    out = demo.get_received()
    assert any(p["name"] == "layout_updated" for p in out)
    layout = db.get_layout()
    general = next(
        ch
        for c in layout["communities"]
        if c["id"] == "dev-hub"
        for ch in c["channels"]
        if ch["id"] == "general"
    )
    assert general["name"] == "lobby"
    demo.disconnect()


def test_unread_summary_and_mark_read(tmp_path):
    _setup_temp_db(tmp_path / "sock_unread.db")
    db.create_user("alice", "Alice", state.hash_password("password1"))
    db.create_user("bob", "Bob", state.hash_password("password1"))
    db.store_message("dev-hub", "general", "bob", "Bob", "hey alice")

    alice = socketio.test_client(app, flask_test_client=app.test_client())
    # start alice in a different channel so general stays unread
    alice.emit(
        "session_start",
        {
            "username": "alice",
            "password": "password1",
            "community": "dev-hub",
            "channel": "projects",
        },
    )
    received = alice.get_received()
    session = [p for p in received if p["name"] == "session_ready"]
    assert session
    summary = _arg0(session[-1]).get("unreads") or {}
    general_unread = [
        row for row in summary.get("channels", []) if row["channel"] == "general"
    ]
    assert general_unread
    assert general_unread[0]["unread"] >= 1

    alice.emit("join_channel", {"community": "dev-hub", "channel": "general"})
    after = alice.get_received()
    cleared = [p for p in after if p["name"] == "unreads"]
    assert cleared
    summary2 = _arg0(cleared[-1])
    still = [
        row for row in summary2.get("channels", []) if row["channel"] == "general"
    ]
    assert not still
    alice.disconnect()


def test_open_dm_creates_thread(tmp_path):
    _setup_temp_db(tmp_path / "sock_dm.db")
    db.create_user("alice", "Alice", state.hash_password("password1"))
    db.create_user("bob", "Bob", state.hash_password("password1"))
    db.add_friend("alice", "bob")

    alice = socketio.test_client(app, flask_test_client=app.test_client())
    _login(alice, "alice", "password1")
    alice.emit("open_dm", {"username": "bob"})
    out = alice.get_received()
    switched = [p for p in out if p["name"] == "channel_switched"]
    assert switched
    payload = _arg0(switched[-1])
    assert payload["community"] == "_dm"
    assert "alice" in payload["channel"] and "bob" in payload["channel"]

    dms = [p for p in out if p["name"] == "dms"]
    assert dms
    threads = _arg0(dms[-1]).get("threads") or []
    assert any(t.get("peer") == "bob" for t in threads)
    alice.disconnect()


def test_add_friend_socket(tmp_path):
    _setup_temp_db(tmp_path / "sock_friend.db")
    db.create_user("alice", "Alice", state.hash_password("password1"))
    db.create_user("bob", "Bob", state.hash_password("password1"))

    alice = socketio.test_client(app, flask_test_client=app.test_client())
    _login(alice, "alice", "password1")
    alice.emit("add_friend", {"username": "bob"})
    out = alice.get_received()
    added = [p for p in out if p["name"] == "friend_added"]
    assert added
    assert _arg0(added[-1])["username"] == "bob"
    alice.disconnect()
