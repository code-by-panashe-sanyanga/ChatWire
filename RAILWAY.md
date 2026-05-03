# Deploy ChatWire on Railway

ChatWire is a **single** Python service (Flask + Socket.IO + static UI). Easier than NovaBank.

## Steps

1. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub** → `ChatWire`
2. Root Directory: leave empty (repo root)
3. Variables:

| Name | Value |
| --- | --- |
| `SECRET_KEY` | long random string |
| `CORS_ORIGINS` | `*` |
| `PORT` | set automatically by Railway |

4. Settings → Networking → **Generate domain**
5. Deploy → open the URL → login `demo` / `demo123456`
6. Open two tabs to test live chat

## Why it usually fails

| Symptom | Fix |
| --- | --- |
| Crash on boot / wrong port | Must use `PORT` from Railway (app already does) |
| Build can’t start | Need `Procfile` / `railway.toml` start command (`python app.py`). Already in the repo. |
| Page loads, sockets die | Host must support WebSockets (Railway does). Hard refresh after deploy |
| CORS errors | Set `CORS_ORIGINS=*` |

## After it works

Set the GitHub repo homepage + portfolio “Live demo” link to the Railway URL.
