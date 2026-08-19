// This file connects to the chat server and shows messages on the page.

var socket = null;
var user = '';
var room = '';

function get(id) {
  return document.getElementById(id);
}

function setStatus(text) {
  get('chat-status').textContent = text;
}

// Add one line to the message list.
// System messages are join and leave messages from the server.
function addLine(text, isSystem, isMine) {
  var log = get('log');
  var li = document.createElement('li');

  if (isSystem) {
    li.className = 'sys';
  } else if (isMine) {
    li.className = 'mine';
  } else {
    li.className = 'msg';
  }

  li.textContent = text;
  log.appendChild(li);

  // Keep the newest message visible.
  log.scrollTop = log.scrollHeight;
}

// Join the room when the user clicks the button.
get('join').onclick = function () {
  user = get('user').value.trim() || 'anon';
  room = get('room').value.trim() || 'lobby';

  if (socket) {
    socket.disconnect();
  }

  socket = io();
  setStatus('Connecting...');

  socket.on('connect', function () {
    socket.emit('join', { user: user, room: room });
    setStatus('Connected as ' + user + '.');
  });

  socket.on('disconnect', function () {
    setStatus('Disconnected. Refresh the page to join again.');
  });

  socket.on('message', function (msg) {
    if (msg.system) {
      addLine(msg.user + ' ' + msg.text, true, false);
      return;
    }

    var isMine = msg.user === user;
    var line = isMine ? msg.text : msg.user + ': ' + msg.text;
    addLine(line, false, isMine);
  });

  get('chat-title').textContent = '#' + room;
  get('room-label').textContent = 'Room: ' + room;
  get('setup').classList.add('hidden');
  get('chat').classList.remove('hidden');
  get('leave').classList.remove('hidden');
  get('text').focus();
};

// Leave the room and go back to the join screen.
get('leave').onclick = function () {
  if (socket) {
    socket.disconnect();
    socket = null;
  }

  get('log').innerHTML = '';
  get('chat').classList.add('hidden');
  get('leave').classList.add('hidden');
  get('setup').classList.remove('hidden');
  get('room-label').textContent = 'Not connected';
};

// Send a message to the room.
get('form').onsubmit = function (e) {
  e.preventDefault();

  var input = get('text');
  var text = input.value.trim();

  if (!text || !socket) {
    return;
  }

  socket.emit('message', { user: user, room: room, text: text });
  input.value = '';
};
