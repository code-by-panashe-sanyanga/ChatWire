# ChatWire backend
# Flask serves the HTML/CSS/JS UI and JSON auth routes.
# Flask-SocketIO pushes live chat events to connected browsers.

import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
from flask_socketio import SocketIO
from werkzeug.exceptions import HTTPException

import db
import state
import uploads
from sockets import register_handlers

load_dotenv()

app = Flask(__name__, static_folder="static")
app.config["MAX_CONTENT_LENGTH"] = max(
    uploads.MAX_IMAGE_BYTES, uploads.MAX_VIDEO_BYTES
) + (512 * 1024)
_secret = os.getenv("SECRET_KEY", "chatwire-dev")
app.config["SECRET_KEY"] = _secret
_bad_secrets = {"", "chatwire-dev", "change-me-in-production"}
_is_prod = bool(
    os.getenv("RAILWAY_ENVIRONMENT")
    or os.getenv("CHATWIRE_ENV", "").strip().lower() == "production"
)
if _secret.strip() in _bad_secrets:
    print(
        "WARNING: SECRET_KEY is still the default. Set a long random value before any real deploy.",
        file=sys.stderr,
    )
    if _is_prod:
        sys.exit("Refusing to start: set SECRET_KEY before deploying to production")

# Default * so local PORT changes (5001/5003/5004) don't break Socket.IO.
# Pin specific origins in production if you serve the UI from another host.
cors_raw = os.getenv("CORS_ORIGINS", "*").strip()
if cors_raw == "*":
    cors_origins = "*"
else:
    cors_origins = [o.strip() for o in cors_raw.split(",") if o.strip()]
    # Always allow this process's own origin when PORT is set.
    port = (os.getenv("PORT") or "").strip()
    if port.isdigit():
        for host in ("http://localhost:", "http://127.0.0.1:"):
            origin = host + port
            if origin not in cors_origins:
                cors_origins.append(origin)

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
    # Keep real HTTP errors (404, 405, …) — don't rewrite them as a generic 500.
    if isinstance(err, HTTPException):
        return err
    app.logger.exception(err)
    return jsonify({"error": "Something went wrong on our end"}), 500


@socketio.on_error_default
def default_socket_error(err):
    app.logger.exception("socket error: %s", err)
    return False


@app.route("/")
def index():
    response = send_from_directory("static", "index.html")
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    return response


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


@app.route("/api/version")
def api_version():
    return jsonify(
        {"version": "4.4.0", "product": "ChatWire", "codename": "wave"}
    )


@app.route("/api/webrtc/ice")
def api_webrtc_ice():
    """STUN is public; TURN credentials require a valid session token."""
    ice_servers = [
        {"urls": "stun:stun.l.google.com:19302"},
        {"urls": "stun:stun1.l.google.com:19302"},
    ]
    token = (
        (request.args.get("token") or "").strip()
        or (request.headers.get("X-Session-Token") or "").strip()
    )
    username = (request.args.get("username") or "").strip().lower()
    if not token:
        body = request.get_json(silent=True) or {}
        token = (body.get("token") or "").strip()
        username = username or (body.get("username") or "").strip().lower()
    token_user = state.resolve_session_token(token) if token else None
    authed = bool(token_user and (not username or token_user == username))

    turn_urls = [
        u.strip() for u in (os.getenv("TURN_URLS") or "").split(",") if u.strip()
    ]
    turn_username = (os.getenv("TURN_USERNAME") or "").strip()
    turn_credential = (os.getenv("TURN_CREDENTIAL") or "").strip()
    if authed and turn_urls and turn_username and turn_credential:
        for url in turn_urls:
            ice_servers.append(
                {
                    "urls": url,
                    "username": turn_username,
                    "credential": turn_credential,
                }
            )
    return jsonify({"iceServers": ice_servers, "turn": bool(authed and turn_urls)})


@app.post("/api/auth/logout")
def api_logout():
    data = request.get_json() or {}
    username = (data.get("username") or "").strip().lower()
    token = (data.get("token") or "").strip()
    token_user = state.resolve_session_token(token)
    if username and token_user and token_user != username:
        return jsonify({"error": "invalid session"}), 401
    # tokens expire on their own; client clears local storage
    return jsonify({"ok": True})


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


@app.post("/api/upload")
def api_upload():
    username = (request.form.get("username") or "").strip().lower()
    token = (request.form.get("token") or "").strip()
    token_user = state.resolve_session_token(token)
    if not username or not token_user or token_user != username:
        return jsonify({"error": "login required"}), 401
    url, err = uploads.save_upload(request.files.get("file"))
    if err:
        return jsonify({"error": err}), 400
    return jsonify({"ok": True, "url": url})


@app.route("/uploads/<path:name>")
def uploaded_file(name):
    # only serve files that live directly in the uploads folder
    safe = Path(name).name
    if safe != name or ".." in name:
        return jsonify({"error": "not found"}), 404
    return send_from_directory(uploads.UPLOAD_DIR, safe)


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
