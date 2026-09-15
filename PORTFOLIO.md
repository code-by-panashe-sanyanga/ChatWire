# Portfolio copy (paste anywhere)

## Card title
ChatWire

## One-liner
Real-time social chat (Flask, Socket.IO, SQLite): started as a room join demo, grew into Home · Explore · Chat · You with accounts, friends-only feed/stories, Clips, and Meet now WebRTC.

## Short description (~40 to 60 words)
ChatWire began as a simple Socket.IO room chat. v2 added accounts, communities, a friends feed, stories, and Meet now. The current UI is Home / Explore / Chat / You, live channels and DMs, For You / Clips, private Saved boards, and profile Follow / Message. Privacy checks sit in the data layer. Live on Railway.

## Longer blurb (~120 words)
I built ChatWire to practice real-time systems outside request/response APIs. v1 was display-name + room join. v2 replaced that with login, Discord-style communities, a friends-only feed and stories, and Meet now. The latest work reshapes it into Home, Explore, Chat, and You, ranked For You, short Clips, rooms with votes, private Saved, and opening other profiles with Follow / Message. Auth is JSON HTTP with a reconnectable session token; everything live rides Socket.IO. Durable data is SQLite (Railway volume for deploys); presence stays in memory. The hard lesson was friends-only privacy: filtering list endpoints was not enough when post ids are sequential, so the same checks sit on every read/write helper, covered by pytest. Stack: HTML/CSS/JS, Python, Flask, Flask-SocketIO, SQLite, WebRTC.

## Tech tags
Python · Flask · Socket.IO · SQLite · WebRTC · HTML/CSS/JS · Railway

## Links
- Live: https://chat-wire-production.up.railway.app
- Repo: https://github.com/code-by-panashe-sanyanga/ChatWire
- Demo: demo / demo123456

## Screenshots to use
- v1: `screenshots/join.png`, `screenshots/chat.png`
- v2: `screenshots/Screenshot_19-8-2026_144544_…jpeg` (login), `…144621…` (chat), `…14466…` (feed)
