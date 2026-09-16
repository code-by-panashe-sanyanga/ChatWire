# Portfolio copy (paste anywhere)

## Card title
ChatWire

## One-liner
Real-time social app (Flask, Socket.IO, SQLite): started as a room join demo, rebuilt in v2 into Home, Explore, Chat and You with accounts, a friends feed, stories, Clips and Meet now.

## Short description (~40 to 60 words)
ChatWire started as a Socket.IO room chat: type a name, type a room, talk. v2 is a product: register and log in, post to a Home timeline, browse photos and Clips in Explore, chat in communities and DMs, and keep a You profile with private Saved boards. Privacy is checked in the data layer. Live on Railway.

## Longer blurb (~120 words)
I built ChatWire to practise real-time systems outside request and response APIs. v1 was a display name plus a room name, so anything in the room was public and nothing survived a restart. v2 is the version I show people: one shell with Home, Explore, Chat and You, a Following and For you timeline, quotes and reposts, short Clips, rooms with votes, 24h stories, device photo and video uploads, and profiles you can follow or message. Auth is JSON HTTP with a reconnectable session token; everything live rides Socket.IO. SQLite and uploads sit on a Railway volume so a deploy does not wipe them. The lesson was privacy: filtering the list endpoint was not enough when ids are sequential, so the same checks sit on every read and write helper, pinned by 38 pytest tests.

## Version 1 vs version 2
| Area | v1 | v2 (current) |
| --- | --- | --- |
| Getting in | Display name plus room name, no accounts | Register and login, bcrypt, signed session token, lockout |
| Shape | One shared room per page | Home, Explore, Chat, You in one shell |
| Messaging | Broadcast to the room | Communities, channels, pins, DMs, typing, reactions, edit |
| Social | None | Timeline with For you ranking, quotes, reposts, stories, follows, rooms with votes |
| Media | Text only | Device photo and short video uploads, Clips, saved boards |
| Profiles | Display name only | Avatar, status, posts, reposts, highlights, private Saved, Follow and Message |
| Calls | None | Meet now with mic, camera and screen share over WebRTC |
| Privacy | Everything in the room was public | Friend and visibility checks on every read and write helper |
| Storage | In memory, gone on restart | SQLite plus uploads on a mounted volume |
| Tests | Manual | 38 pytest tests across auth, sockets, feed, stories, Saved |

## Tech tags
Python · Flask · Socket.IO · SQLite · WebRTC · HTML/CSS/JS · Railway

## Links
- Live: https://chat-wire-production.up.railway.app
- Repo: https://github.com/code-by-panashe-sanyanga/ChatWire
- Demo: demo / demo123456

## Screenshots to use
- v2 (current): `chatwire-v2-home.png`, `chatwire-v2-explore.png`, `chatwire-v2-chat.png`, `chatwire-v2-you.png`, `chatwire-v2-login.png`
- v1 (earlier record): `screenshots/join.png`, `screenshots/chat.png`, plus the older timeline and light theme shots
