// ChatWire — Discord-style client with login and rename support

var socket = null;
var user = '';
var username = '';
var accountPassword = '';
var layout = null;
var communityId = '';
var channelId = '';
var typingTimer = null;

var AVATAR_COLORS = ['#7c6cff', '#5b8cff', '#3dd6c6', '#ff6b8a', '#ffc857', '#2ee59d', '#c084fc'];

function initials(name) {
  var parts = (name || '?').trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (name || '?').slice(0, 2).toUpperCase();
}

function colorForName(name) {
  var sum = 0;
  for (var i = 0; i < name.length; i++) sum += name.charCodeAt(i);
  return AVATAR_COLORS[sum % AVATAR_COLORS.length];
}

function formatTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return '';
  }
}

function setAuthMsg(text, isError) {
  var el = document.getElementById('auth-msg');
  el.textContent = text || '';
  el.className = 'auth-msg' + (isError ? ' error' : '');
}

function setPwMsg(text, isError) {
  var el = document.getElementById('pw-msg');
  el.textContent = text || '';
  el.className = 'auth-msg' + (isError ? ' error' : '');
}

function setStatus(online) {
  var el = document.getElementById('status');
  el.textContent = online ? 'Online' : 'Offline';
  el.classList.toggle('offline', !online);
}

function updateMyName(name) {
  user = name;
  document.getElementById('my-name').textContent = name;
  var av = document.getElementById('my-avatar');
  av.textContent = initials(name);
  av.style.background = colorForName(name);
}

function communityById(id) {
  if (!layout) return null;
  for (var i = 0; i < layout.communities.length; i++) {
    if (layout.communities[i].id === id) return layout.communities[i];
  }
  return null;
}

function renderServerRail() {
  var rail = document.getElementById('server-rail');
  rail.innerHTML = '';
  layout.communities.forEach(function (c) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'server-icon' + (c.id === communityId ? ' active' : '');
    btn.title = c.name;
    btn.textContent = c.abbr;
    btn.onclick = function () { switchCommunity(c.id); };
    rail.appendChild(btn);
  });
}

function renderChannels() {
  var community = communityById(communityId);
  if (!community) return;

  document.getElementById('community-name').textContent = community.name;

  var list = document.getElementById('channel-list');
  list.innerHTML = '';

  community.channels.forEach(function (ch) {
    if (ch.type !== 'text') return;
    var li = document.createElement('li');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'channel-btn' + (ch.id === channelId ? ' active' : '');
    btn.innerHTML = '<span class="hash">#</span> ' + escapeHtml(ch.name);
    btn.onclick = function () { switchChannel(ch.id); };
    li.appendChild(btn);
    list.appendChild(li);
  });

  var channelName = channelId;
  for (var i = 0; i < community.channels.length; i++) {
    if (community.channels[i].id === channelId) {
      channelName = community.channels[i].name;
      break;
    }
  }
  document.getElementById('channel-title').textContent = channelName;
  document.getElementById('text').placeholder = 'Message #' + channelName;
}

function escapeHtml(text) {
  var div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderPresence(data) {
  var online = data.online || [];
  var friends = data.friends || [];
  document.getElementById('online-count').textContent = String(online.length);

  var onlineList = document.getElementById('online-list');
  onlineList.innerHTML = '';
  if (!online.length) {
    onlineList.innerHTML = '<li class="member-row"><span class="sub">Nobody else online</span></li>';
  } else {
    online.forEach(function (row) {
      onlineList.appendChild(makeMemberRow(row.user, true, row.community, row.channel));
    });
  }

  var friendsList = document.getElementById('friends-list');
  friendsList.innerHTML = '';
  friends.forEach(function (f) {
    friendsList.appendChild(makeMemberRow(f.name, f.online, null, null));
  });
}

function makeMemberRow(name, isOnline, comm, chan) {
  var li = document.createElement('li');
  li.className = 'member-row' + (isOnline ? ' online' : '');
  var dot = document.createElement('span');
  dot.className = 'dot';
  var label = document.createElement('span');
  label.textContent = name;
  li.appendChild(dot);
  li.appendChild(label);
  if (isOnline && comm && chan) {
    var sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = '#' + chan;
    li.appendChild(sub);
  }
  return li;
}

function clearLog() {
  document.getElementById('log').innerHTML = '';
}

function findMessageRow(msgId) {
  return document.querySelector('[data-msg-id="' + msgId + '"]');
}

function applyEditedLabel(head, msg) {
  var old = head.querySelector('.msg-edited');
  if (old) old.remove();
  if (msg.edited_at) {
    var edited = document.createElement('span');
    edited.className = 'msg-edited';
    edited.textContent = '(edited)';
    head.appendChild(edited);
  }
}

function buildMessageRow(msg) {
  var li = document.createElement('li');
  li.className = 'msg-row';
  li.setAttribute('data-msg-id', msg.id);

  var avatar = document.createElement('div');
  avatar.className = 'avatar xs';
  avatar.style.background = colorForName(msg.user);
  avatar.textContent = initials(msg.user);

  var body = document.createElement('div');
  body.className = 'msg-body';
  var head = document.createElement('div');
  head.className = 'msg-head';
  var name = document.createElement('span');
  name.className = 'msg-name';
  name.textContent = msg.user;
  var time = document.createElement('span');
  time.className = 'msg-time';
  time.textContent = formatTime(msg.at);
  var text = document.createElement('p');
  text.className = 'msg-text';
  text.textContent = msg.text;

  head.appendChild(name);
  head.appendChild(time);
  applyEditedLabel(head, msg);
  body.appendChild(head);
  body.appendChild(text);
  li.appendChild(avatar);
  li.appendChild(body);

  if (msg.user === user) {
    var actions = document.createElement('div');
    actions.className = 'msg-actions';
    var editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'msg-action-btn';
    editBtn.textContent = 'Edit';
    editBtn.onclick = function () { startEditMessage(li, msg.id, msg.text); };
    actions.appendChild(editBtn);
    li.appendChild(actions);
  }

  return li;
}

function addMessage(msg) {
  var log = document.getElementById('log');
  if (msg.system) {
    var sys = document.createElement('li');
    sys.className = 'sys';
    sys.textContent = msg.user + ' ' + msg.text;
    log.appendChild(sys);
    log.scrollTop = log.scrollHeight;
    return;
  }
  log.appendChild(buildMessageRow(msg));
  log.scrollTop = log.scrollHeight;
}

function updateMessageEdited(msg) {
  var row = findMessageRow(msg.id);
  if (!row) return;
  var textEl = row.querySelector('.msg-text');
  var nameEl = row.querySelector('.msg-name');
  var head = row.querySelector('.msg-head');
  if (textEl) textEl.textContent = msg.text;
  if (nameEl) nameEl.textContent = msg.user;
  if (head) applyEditedLabel(head, msg);
}

function startEditMessage(row, msgId, currentText) {
  if (row.querySelector('.msg-edit-form')) return;
  var body = row.querySelector('.msg-body');
  var textEl = row.querySelector('.msg-text');
  if (!body || !textEl) return;
  textEl.style.display = 'none';
  var form = document.createElement('div');
  form.className = 'msg-edit-form';
  var input = document.createElement('input');
  input.type = 'text';
  input.value = currentText;
  var save = document.createElement('button');
  save.type = 'button';
  save.textContent = 'Save';
  var cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'cancel';
  cancel.textContent = 'Cancel';
  function closeForm() {
    form.remove();
    textEl.style.display = '';
  }
  save.onclick = function () {
    var next = input.value.trim();
    if (next && socket) socket.emit('edit_message', { id: msgId, text: next });
    closeForm();
  };
  cancel.onclick = closeForm;
  form.appendChild(input);
  form.appendChild(save);
  form.appendChild(cancel);
  body.appendChild(form);
  input.focus();
}

function loadChannelHistory(messages) {
  clearLog();
  (messages || []).forEach(addMessage);
}

function showApp() {
  document.getElementById('setup').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  updateMyName(user);
}

function showSetup() {
  document.getElementById('setup').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  clearLog();
  setStatus(false);
}

function switchCommunity(id) {
  if (!socket || id === communityId) return;
  var community = communityById(id);
  if (!community) return;
  communityId = id;
  var firstText = null;
  for (var i = 0; i < community.channels.length; i++) {
    if (community.channels[i].type === 'text') {
      firstText = community.channels[i];
      break;
    }
  }
  channelId = firstText ? firstText.id : community.channels[0].id;
  renderServerRail();
  renderChannels();
  socket.emit('join_channel', { community: communityId, channel: channelId });
}

function switchChannel(id) {
  if (!socket || id === channelId) return;
  channelId = id;
  renderChannels();
  socket.emit('join_channel', { community: communityId, channel: channelId });
}

function promptDisplayName() {
  var next = window.prompt('New display name:', user);
  if (!next) return;
  next = next.trim().slice(0, 32);
  if (next && socket) socket.emit('update_display_name', { user: next });
}

function promptRenameCommunity() {
  var community = communityById(communityId);
  if (!community || !socket) return;
  var name = window.prompt('Community name:', community.name);
  if (!name) return;
  var abbr = window.prompt('Short icon label (2 letters):', community.abbr);
  socket.emit('rename_community', {
    community_id: communityId,
    name: name.trim(),
    abbr: (abbr || community.abbr).trim(),
  });
}

function promptRenameChannel() {
  var community = communityById(communityId);
  if (!community || !socket) return;
  var current = channelId;
  for (var i = 0; i < community.channels.length; i++) {
    if (community.channels[i].id === channelId) {
      current = community.channels[i].name;
      break;
    }
  }
  var name = window.prompt('Channel name:', current);
  if (!name) return;
  socket.emit('rename_channel', {
    community_id: communityId,
    channel_id: channelId,
    name: name.trim(),
  });
}

function openPasswordModal() {
  document.getElementById('password-modal').classList.remove('hidden');
  document.getElementById('pw-current').value = '';
  document.getElementById('pw-new').value = '';
  document.getElementById('pw-confirm').value = '';
  setPwMsg('');
}

function closePasswordModal() {
  document.getElementById('password-modal').classList.add('hidden');
}

function savePassword() {
  var current = document.getElementById('pw-current').value;
  var next = document.getElementById('pw-new').value;
  var confirm = document.getElementById('pw-confirm').value;
  if (next !== confirm) {
    setPwMsg('New passwords do not match.', true);
    return;
  }
  fetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: username,
      current_password: current,
      new_password: next,
    }),
  })
    .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
    .then(function (res) {
      if (!res.ok) {
        setPwMsg(res.data.error || 'Could not change password.', true);
        return;
      }
      accountPassword = next;
      setPwMsg('Password updated.');
      setTimeout(closePasswordModal, 800);
    })
    .catch(function () {
      setPwMsg('Could not reach the server.', true);
    });
}

function bindSocket() {
  socket.on('connect', function () {
    setStatus(true);
    socket.emit('session_start', {
      username: username,
      password: accountPassword,
      community: communityId,
      channel: channelId,
    });
  });

  socket.on('disconnect', function () { setStatus(false); });

  socket.on('auth_error', function (data) {
    setAuthMsg(data.error || 'Login failed.', true);
    if (socket) socket.disconnect();
    showSetup();
  });

  socket.on('session_ready', function (data) {
    layout = data.layout;
    communityId = data.community;
    channelId = data.channel;
    updateMyName(data.user || user);
    renderServerRail();
    renderChannels();
    document.getElementById('text').focus();
  });

  socket.on('channel_switched', function (data) {
    communityId = data.community;
    channelId = data.channel;
    renderServerRail();
    renderChannels();
  });

  socket.on('channel_history', function (data) { loadChannelHistory(data.messages); });
  socket.on('presence', renderPresence);
  socket.on('message', addMessage);
  socket.on('message_edited', updateMessageEdited);

  socket.on('layout_updated', function (data) {
    layout = data;
    renderServerRail();
    renderChannels();
  });

  socket.on('display_name_updated', function (data) { updateMyName(data.user); });

  socket.on('user_renamed', function (data) {
    document.querySelectorAll('.msg-row').forEach(function (row) {
      var nameEl = row.querySelector('.msg-name');
      if (!nameEl || nameEl.textContent !== data.old_name) return;
      nameEl.textContent = data.new_name;
    });
  });

  socket.on('edit_error', function (data) {
    window.alert(data.error || 'Could not save that change.');
  });

  socket.on('typing', function (data) {
    var el = document.getElementById('typing-indicator');
    el.textContent = data.typing ? data.user + ' is typing…' : '';
  });
}

function connectChat() {
  fetch('/api/layout')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      layout = data;
      if (!communityId) communityId = data.communities[0].id;
      if (!channelId) channelId = data.communities[0].channels[0].id;
      if (socket) socket.disconnect();
      socket = io();
      bindSocket();
      showApp();
    });
}

function login(usernameInput, password) {
  return fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: usernameInput, password: password }),
  }).then(function (r) {
    return r.json().then(function (d) { return { ok: r.ok, data: d }; });
  });
}

function register(usernameInput, password, displayName) {
  return fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: usernameInput,
      password: password,
      display_name: displayName,
    }),
  }).then(function (r) {
    return r.json().then(function (d) { return { ok: r.ok, data: d }; });
  });
}

document.getElementById('tab-login').onclick = function () {
  document.getElementById('tab-login').classList.add('active');
  document.getElementById('tab-register').classList.remove('active');
  document.getElementById('login-form').classList.remove('hidden');
  document.getElementById('register-form').classList.add('hidden');
  setAuthMsg('');
};

document.getElementById('tab-register').onclick = function () {
  document.getElementById('tab-register').classList.add('active');
  document.getElementById('tab-login').classList.remove('active');
  document.getElementById('register-form').classList.remove('hidden');
  document.getElementById('login-form').classList.add('hidden');
  setAuthMsg('');
};

document.getElementById('login-form').onsubmit = function (e) {
  e.preventDefault();
  var u = document.getElementById('login-username').value.trim().toLowerCase();
  var p = document.getElementById('login-password').value;
  login(u, p).then(function (res) {
    if (!res.ok) {
      setAuthMsg(res.data.error || 'Login failed.', true);
      return;
    }
    username = res.data.username;
    accountPassword = p;
    user = res.data.display_name;
    setAuthMsg('');
    connectChat();
  });
};

document.getElementById('register-form').onsubmit = function (e) {
  e.preventDefault();
  var u = document.getElementById('reg-username').value.trim().toLowerCase();
  var p = document.getElementById('reg-password').value;
  var d = document.getElementById('reg-display').value.trim();
  register(u, p, d || u).then(function (res) {
    if (!res.ok) {
      setAuthMsg(res.data.error || 'Registration failed.', true);
      return;
    }
    username = res.data.username;
    accountPassword = p;
    user = res.data.display_name;
    setAuthMsg('Account created — logging you in…');
    connectChat();
  });
};

document.getElementById('edit-name').onclick = promptDisplayName;
document.getElementById('rename-community').onclick = promptRenameCommunity;
document.getElementById('rename-channel').onclick = promptRenameChannel;
document.getElementById('change-password').onclick = openPasswordModal;
document.getElementById('pw-cancel').onclick = closePasswordModal;
document.getElementById('pw-save').onclick = savePassword;

document.getElementById('form').onsubmit = function (e) {
  e.preventDefault();
  var input = document.getElementById('text');
  var text = input.value.trim();
  if (!text || !socket) return;
  socket.emit('message', { text: text });
  socket.emit('typing', { typing: false });
  input.value = '';
};

document.getElementById('text').addEventListener('input', function () {
  if (!socket) return;
  socket.emit('typing', { typing: true });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(function () {
    socket.emit('typing', { typing: false });
  }, 1200);
});
