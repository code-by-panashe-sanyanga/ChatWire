# ChatWire backend
# Flask serves the HTML/CSS/JS UI and JSON auth routes.
# Flask-SocketIO pushes live chat events to connected browsers.

import os
import sys

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
from flask_socketio import SocketIO

import db
import state
from sockets import register_handlers

load_dotenv()

app = Flask(__name__, static_folder="static")
_secret = os.getenv("SECRET_KEY", "chatwire-dev")
app.config["SECRET_KEY"] = _secret
if _secret == "chatwire-dev":
    print(
        "WARNING: SECRET_KEY is still the default. Set a long random value before any real deploy.",
        file=sys.stderr,
    )

cors_raw = os.getenv("CORS_ORIGINS", "http://localhost:5001,http://127.0.0.1:5001").strip()
if cors_raw == "*":
    cors_origins = "*"
else:
    cors_origins = [o.strip() for o in cors_raw.split(",") if o.strip()]

socketio = SocketIO(app, cors_allowed_origins=cors_origins, async_mode="threading")
state.socketio = socketio

state.bootstrap()
register_handlers(socketio)


@app.after_request
def add_security_headers(response):
    # basic browser hardening - keep CSP aligned with index.html dependencies
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' https://cdn.socket.io; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com data:; "
        "img-src 'self' data: https:; "
        "media-src 'self' blob: mediastream:; "
        "connect-src 'self' ws: wss:; "
        "frame-ancestors 'self'"
    )
    return response


@app.errorhandler(Exception)
def handle_unexpected_error(err):
    app.logger.exception(err)
    return jsonify({"error": "Something went wrong on our end"}), 500


@socketio.on_error_default
def default_socket_error(err):
    app.logger.exception("socket error: %s", err)
    return False


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/api/layout")
def api_layout():
    state.refresh_layout()
    return jsonify(state.LAYOUT)


@app.post("/api/auth/register")
def api_register():
    data = request.get_json() or {}
    username = (data.get("username") or "").strip().lower()
    password = data.get("password") or ""
    display_name = (data.get("display_name") or username).strip()[:32]

    if not state.USERNAME_RE.match(username):
        return jsonify({"error": "username must be 3-20 letters, numbers, or underscores"}), 400
    pw_err = state.password_errors(password)
    if pw_err:
        return jsonify({"error": pw_err}), 400
    if db.get_user(username):
        return jsonify({"error": "username already taken"}), 409

    db.create_user(username, display_name or username, state.hash_password(password))
    token = state.issue_session_token(username)
    return jsonify(
        {
            "ok": True,
            "username": username,
            "display_name": display_name or username,
            "token": token,
        }
    )


@app.post("/api/auth/login")
def api_login():
    data = request.get_json() or {}
    username = (data.get("username") or "").strip().lower()
    password = data.get("password") or ""

    display_name, err = state.verify_user(username, password)
    if not display_name:
        return jsonify({"error": err or "invalid username or password"}), 401

    token = state.issue_session_token(username)
    return jsonify(
        {
            "ok": True,
            "username": username,
            "display_name": display_name,
            "token": token,
        }
    )


@app.post("/api/auth/change-password")
def api_change_password():
    data = request.get_json() or {}
    username = (data.get("username") or "").strip().lower()
    current = data.get("current_password") or ""
    new_password = data.get("new_password") or ""

    # reuse the same lockout-protected path as /api/auth/login so this
    # endpoint can't be used to brute-force a user's current password
    # with unlimited attempts
    display_name, err = state.verify_user(username, current)
    if not display_name:
        return jsonify({"error": err or "current password is wrong"}), 401
    pw_err = state.password_errors(new_password)
    if pw_err:
        return jsonify({"error": pw_err}), 400

    db.update_password(username, state.hash_password(new_password))
    return jsonify({"ok": True, "token": state.issue_session_token(username)})


@app.route("/api/health")
def api_health():
    return jsonify({"status": "ok"})


@app.route("/api/ready")
def api_ready():
    # process is up AND sqlite answers a simple query
    try:
        conn = db.connect()
        conn.execute("SELECT 1").fetchone()
        conn.close()
        return jsonify({"status": "ready", "database": "up"})
    except Exception:
        return jsonify({"status": "not_ready", "database": "down"}), 503


@app.route("/<path:path>")
def static_files(path):
    return send_from_directory("static", path)


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5001"))
    debug = os.getenv("FLASK_DEBUG", "0") == "1"
    socketio.run(
        app,
        host="0.0.0.0",
        port=port,
        debug=debug,
        allow_unsafe_werkzeug=True,
    )
