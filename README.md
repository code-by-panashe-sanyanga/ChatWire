# ChatWire

ChatWire is a small real time chat app. You type your name, pick a room, and
start chatting with anyone else in that room. Messages show up straight away
without refreshing the page. It is a learning project to practice WebSockets
with Flask-SocketIO.

![Login](screenshots/Screenshot_19-8-2026_144544_chat-wire-production.up.railway.app.jpeg)

![Chat room](screenshots/Screenshot_19-8-2026_144544_chat-wire-production.up.railway.app.jpeg)

## What the project does

- Shows a join screen where you enter your name and a room name.
- Connects to the server using WebSockets so messages are instant.
- Shows system messages when someone joins or leaves the room.
- Your own messages appear on the right in blue, other people's on the left.
- The room name is shown in the header after you join.

## Why these technologies

- **Python + Flask** for the web server. Same as my other projects, small and
  easy to follow.
- **Flask-SocketIO** for the real time part. Normal HTTP is request and response,
  but chat needs the server to push messages to the browser at any time. SocketIO
  handles that and also falls back to long polling if WebSockets are not available.
- **Socket.IO client (CDN)** on the frontend. The library is loaded from a CDN link
  in the HTML so we do not have to download or bundle it ourselves.
- **Plain HTML, CSS, and JavaScript** again for the frontend, no React or similar.

I use `async_mode="threading"` in the backend so the app runs without installing
eventlet or gevent. That keeps setup simple and easy to run.

## Folder structure

```
ChatWire/
  app.py              the Flask and SocketIO backend
  requirements.txt    the Python packages the project needs
  README.md           this file
  .gitignore          tells git which files to skip
  static/             all the frontend files
    index.html        the page you see in the browser
    style.css         the styling for the page
    app.js            the JavaScript that connects and sends messages
```

## How to run it

You need Python 3 installed. Open a terminal in the project folder.

1. Make a virtual environment:

```bash
python -m venv venv
venv\Scripts\activate       # on Windows
# source venv/bin/activate  # on Mac or Linux
```

2. Install the packages:

```bash
pip install -r requirements.txt
```

3. Start the app:

```bash
python app.py
```

4. Open your browser at http://localhost:5001

To test with more than one person, open a second browser tab or window, use a
different name, and join the same room. You should see messages appear in both tabs.

## Frontend files in detail

**static/index.html**
This has the join form (name and room inputs plus a Join button) and the chat area
(message list and a form at the bottom). The chat area is hidden until you join.
The page loads the Socket.IO client from a CDN, then loads `app.js`.

**static/style.css**
Dark theme styling. The join form is a card in the middle of the page. Messages
are shown as rounded boxes. Your own messages use the class `mine` and sit on the
right. System messages are grey and centered.

**static/app.js**
The main parts are:
- `addLine(text, isSystem, isMine)` adds one line to the message list and scrolls
  to the bottom.
- When you click Join, it connects with `io()`, sends a `join` event to the server,
  and listens for `message` events coming back.
- The form submit handler sends your text with a `message` event.

## Backend file in detail

**app.py** runs both the normal web server and the SocketIO server. The important
parts are:
- `users` is a small dictionary that maps each connection id to a name and room.
  We need it so we can announce when someone disconnects.
- `on_join` puts the user into a SocketIO room and tells everyone they joined.
- `on_message` receives a chat message and sends it to everyone in that room.
- `on_disconnect` removes the user and tells the room they left.

SocketIO "rooms" are not physical rooms. They are just a label so the server knows
which connections should get the same messages.

## About the JSON

SocketIO events carry data as JSON objects. For example a join sends
`{"user": "alice", "room": "lobby"}` and a chat message sends
`{"user": "alice", "room": "lobby", "text": "hi"}`. The server then broadcasts
messages back in a similar shape. JSON is used because it is easy for both Python
and JavaScript to read.

## About node_modules

This project does not use Node packages. `node_modules` is in `.gitignore` anyway
because in Node projects that folder is huge and should never be uploaded. You
commit `requirements.txt` instead and other people run `pip install` themselves.
The `venv` folder is ignored for the same reason.

## Limitations and possible improvements

- Messages are not saved. If you refresh the page you only see new messages.
- There is no login, so anyone can use any name.
- No private messages, only room chat.
- No list of who is currently in the room.
- The server runs on threading mode which is fine for a demo but not for hundreds
  of users at once.

Next steps I would try: store message history in a database, add a user list for
each room, and add basic password protection for rooms.

## Troubleshooting

- **The page loads but Join does nothing.** Check the terminal for errors. Make
  sure `flask-socketio` is installed.
- **Messages do not appear.** Open the browser developer console (F12) and look for
  connection errors. Both tabs need to join the same room name.
- **Port 5001 is already in use.** Change the port in the last line of `app.py`.
- **`ModuleNotFoundError`.** Activate the virtual environment and run
  `pip install -r requirements.txt` again.
- **CDN blocked.** The Socket.IO client loads from the internet. If you are offline,
  download the client file and serve it from the static folder instead.
