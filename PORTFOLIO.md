# Portfolio copy (paste anywhere)

## Card title
ChatWire

## One-liner
Real-time social chat (Flask, Socket.IO, SQLite): Home · Explore · Chat · You, friends-only feed/stories, Clips, Meet now WebRTC.

## Short description (~40–60 words)
ChatWire is a single-process social app: live communities and DMs, a Home feed, Explore (For You / Clips / Rooms), and You profiles with private Saved boards. Socket.IO pushes messages and presence; privacy for posts, stories, and Saved lives in the data layer. Optional Meet now uses WebRTC. Live on Railway.

## Longer blurb (~120 words)
I built ChatWire to practice real-time systems outside request/response APIs. The product is one shell with four modes—Home, Explore, Chat, and You—covering channels, DMs, a ranked For You feed, short Clips, rooms with votes, 24h stories, and profile Follow / Message. Auth is JSON HTTP with a reconnectable session token; everything live rides Socket.IO. Durable data is SQLite (with a Railway volume for deploys); presence and call rooms stay in memory. The hard lesson was friends-only privacy: filtering list endpoints was not enough when post ids are sequential, so the same visibility checks sit on every read/write helper, covered by pytest. Stack: HTML/CSS/JS, Python, Flask, Flask-SocketIO, SQLite, WebRTC.

## Tech tags
Python · Flask · Socket.IO · SQLite · WebRTC · HTML/CSS/JS · Railway

## Links
- Live: https://chat-wire-production.up.railway.app
- Repo: https://github.com/code-by-panashe-sanyanga/ChatWire
- Demo: demo / demo123456
