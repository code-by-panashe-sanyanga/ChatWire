# Deploy ChatWire on Railway

ChatWire is a **single** Python service (Flask + Socket.IO + static UI). Easier than NovaBank.

## Steps

1. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub** → `ChatWire`
2. Root Directory: leave empty (repo root)
3. **Add a volume** (required for durable SQLite + uploads):
   - Settings → Volumes → **Add Volume**
   - Mount path: `/data`
4. Variables:

| Name | Value |
| --- | --- |
| `SECRET_KEY` | long random string (**required** — app refuses to boot without it on Railway) |
| `DATA_DIR` | `/data` |
| `CORS_ORIGINS` | `*` (or pin your Railway domain) |
| `FLASK_DEBUG` | `0` |
| `PORT` | set automatically by Railway |

5. Settings → Networking → **Generate domain**
6. Deploy → open the URL → you should see the **Log in / Register** screen (not a room-name join form)
7. Login `demo` / `demo123456`
8. Open two tabs to test live chat

If you still see “Join a chat room”, the deploy is on an old commit that replaced the full UI — redeploy from `main` after the full `static/` UI is restored.

## Why it usually fails

| Symptom | Fix |
| --- | --- |
| Crash on boot / wrong port | Must use `PORT` from Railway (app already does) |
| Build can’t start | Need `Procfile` / `railway.toml` start command (`python app.py`). Already in the repo. |
| Page loads, sockets die | Host must support WebSockets (Railway does). Hard refresh after deploy |
| CORS errors | Set `CORS_ORIGINS=*` |
| DB / uploads reset every deploy | Mount a volume at `/data` and set `DATA_DIR=/data` |
| Weak `SECRET_KEY` on Railway | App exits — set a long random `SECRET_KEY` |

## After it works

Set the GitHub repo homepage + portfolio “Live demo” link to the Railway URL.
