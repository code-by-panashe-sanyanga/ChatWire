"""HTTP auth hardening: tokens, password rules, lockout, headers."""

import db
import state
from app import app


def _fresh_db(tmp_path):
    db.DB_PATH = tmp_path / "auth.db"
    state.sessions.clear()
    state._login_failures.clear()
    if db.DB_PATH.exists():
        db.DB_PATH.unlink()
    db.init_db()
    state.refresh_layout()
    db.create_user(
        "demo",
        "Demo User",
        state.hash_password(state.DEMO_PASSWORD),
        is_admin=True,
    )


def test_login_returns_session_token(tmp_path):
    _fresh_db(tmp_path)
    client = app.test_client()
    res = client.post(
        "/api/auth/login",
        json={"username": "demo", "password": state.DEMO_PASSWORD},
    )
    assert res.status_code == 200
    data = res.get_json()
    assert data["ok"] is True
    assert data["token"]
    assert state.resolve_session_token(data["token"]) == "demo"


def test_password_rules_reject_short_password(tmp_path):
    _fresh_db(tmp_path)
    client = app.test_client()
    res = client.post(
        "/api/auth/register",
        json={"username": "newbie", "password": "short1", "display_name": "New"},
    )
    assert res.status_code == 400
    assert "10" in (res.get_json().get("error") or "")


def test_register_issues_token(tmp_path):
    _fresh_db(tmp_path)
    client = app.test_client()
    res = client.post(
        "/api/auth/register",
        json={
            "username": "newbie",
            "password": "goodpass12",
            "display_name": "New",
        },
    )
    assert res.status_code == 200
    data = res.get_json()
    assert data["token"]
    assert state.resolve_session_token(data["token"]) == "newbie"


def test_brute_force_lockout(tmp_path):
    _fresh_db(tmp_path)
    client = app.test_client()
    for _ in range(state.MAX_LOGIN_ATTEMPTS):
        res = client.post(
            "/api/auth/login",
            json={"username": "demo", "password": "wrong-password"},
        )
        assert res.status_code == 401

    locked = client.post(
        "/api/auth/login",
        json={"username": "demo", "password": state.DEMO_PASSWORD},
    )
    assert locked.status_code == 401
    assert "too many attempts" in (locked.get_json().get("error") or "")


def test_security_headers_present(tmp_path):
    _fresh_db(tmp_path)
    client = app.test_client()
    res = client.get("/api/health")
    assert res.headers.get("X-Content-Type-Options") == "nosniff"
    assert res.headers.get("X-Frame-Options") == "SAMEORIGIN"
    csp = res.headers.get("Content-Security-Policy") or ""
    assert "cdn.socket.io" in csp
    assert "fonts.googleapis.com" in csp


def test_socket_accepts_token(tmp_path):
    from app import socketio

    _fresh_db(tmp_path)
    token = state.issue_session_token("demo")
    client = socketio.test_client(app, flask_test_client=app.test_client())
    client.emit(
        "session_start",
        {
            "username": "demo",
            "token": token,
            "community": "dev-hub",
            "channel": "general",
        },
    )
    names = [p["name"] for p in client.get_received()]
    assert "session_ready" in names
    client.disconnect()


def test_password_errors_helper():
    assert state.password_errors("short") is not None
    assert state.password_errors("allletters!") is not None
    assert state.password_errors("1234567890") is not None
    assert state.password_errors("goodpass12") is None
