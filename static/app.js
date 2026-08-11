/* ChatWire front-end. Talks to the existing Socket.IO handlers. */

var socket = null;
var user = "";
var username = "";
var sessionToken = "";
var layout = null;
var communityId = "";
var channelId = "";
var typingTimer = null;
var soundEnabled = localStorage.getItem("chatwire_sound") !== "0";
var themeMode = localStorage.getItem("chatwire_theme") === "light" ? "light" : "dark";
var channelMessagesCache = [];
var lastMessageMeta = null;
var promptCallback = null;
var reactionTargetId = null;
var inCall = false;
var currentCallRoom = "";
var localStream = null;
var peerConnections = {};
var remoteStreams = {};
var lastCallParticipants = [];
var wantMic = localStorage.getItem("chatwire_want_mic") !== "0";
var wantCam = localStorage.getItem("chatwire_want_cam") === "1";
var micPermission = "prompt";
var camPermission = "prompt";
var ICE_SERVERS = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
var feedHasMore = false;
var feedOldestId = null;
var feedMode = false;
var channelHasMore = false;
var channelOldestId = null;
var myStatus = "available";
var myStatusText = "";
var pendingStatus = "available";
var pendingStoryBg = "#1c212b";
var pendingChatImageUrl = "";
var pendingPostImageUrl = "";
var pendingStoryImageUrl = "";
var storyGroups = [];
var storyViewerGroup = null;
var storyViewerIndex = 0;
var storyTimer = null;
var isAdmin = false;
var unreadState = { channels: [], dms: [] };
var dmThreads = [];

var AVATAR_COLORS = ["#e08a3c", "#c4784a", "#9caa5a", "#d4a574", "#b56b4e", "#8f9e6b", "#e0a070"];
var QUICK_EMOJIS = ["👍", "🔥", "😂", "❤️", "🎉", "👀", "✅", "🚀"];

function initials(name) {
  var parts = (name || "?").trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (name || "?").slice(0, 2).toUpperCase();
}

function colorForName(name) {
  var sum = 0;
  for (var i = 0; i < (name || "").length; i++) sum += name.charCodeAt(i);
  return AVATAR_COLORS[sum % AVATAR_COLORS.length];
}

function escapeHtml(text) {
  var div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}

function formatTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch (e) {
    return "";
  }
}

function dayKey(iso) {
  try {
    var d = new Date(iso);
    return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
  } catch (e) {
    return "unknown";
  }
}

function dayLabel(iso) {
  try {
    var d = new Date(iso);
    var today = new Date();
    var yday = new Date();
    yday.setDate(today.getDate() - 1);
    if (dayKey(iso) === dayKey(today.toISOString())) return "Today";
    if (dayKey(iso) === dayKey(yday.toISOString())) return "Yesterday";
    return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  } catch (e) {
    return "";
  }
}

function renderMarkdown(raw) {
  var text = escapeHtml(raw || "");
  text = text.replace(/```([\s\S]*?)```/g, function (_, code) {
    return "<pre><code>" + code.trim() + "</code></pre>";
  });
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  text = text.replace(
    /(https?:\/\/[^\s<]+)/g,
    function (_, url) {
      // only allow http(s) links, and escape the href text we already escaped
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + "</a>";
    }
  );
  return text;
}

function toast(message, isError) {
  var root = document.getElementById("toast-root");
  var el = document.createElement("div");
  el.className = "toast" + (isError ? " error" : "");
  el.textContent = message;
  root.appendChild(el);
  setTimeout(function () {
    el.remove();
  }, 2800);
}

function uploadDeviceImage(file) {
  if (!file) return Promise.reject(new Error("No file"));
  if (!username || !sessionToken) {
    return Promise.reject(new Error("Login required"));
  }
  var fd = new FormData();
  fd.append("file", file);
  fd.append("username", username);
  fd.append("token", sessionToken);
  return fetch("/api/upload", { method: "POST", body: fd }).then(function (res) {
    return res.json().then(function (data) {
      if (!res.ok) throw new Error((data && data.error) || "Upload failed");
      return data.url;
    });
  });
}

function setAttachPreview(prefix, url, fileName) {
  var box = document.getElementById(prefix + "-attach-preview");
  var thumb = document.getElementById(prefix + "-attach-thumb");
  var name = document.getElementById(prefix + "-attach-name");
  if (!box || !thumb) return;
  if (!url) {
    box.classList.add("hidden");
    thumb.removeAttribute("src");
    if (name) name.textContent = "Photo";
    return;
  }
  thumb.src = url;
  if (name) name.textContent = fileName || "Photo ready";
  box.classList.remove("hidden");
}

function clearChatAttach() {
  pendingChatImageUrl = "";
  var input = document.getElementById("chat-file");
  if (input) input.value = "";
  setAttachPreview("chat", "");
}

function clearPostAttach() {
  pendingPostImageUrl = "";
  var input = document.getElementById("post-file");
  if (input) input.value = "";
  setAttachPreview("post", "");
}

function clearStoryAttach() {
  pendingStoryImageUrl = "";
  var input = document.getElementById("story-file");
  if (input) input.value = "";
  setAttachPreview("story", "");
}

function setAuthMsg(text, isError) {
  var el = document.getElementById("auth-msg");
  el.textContent = text || "";
  el.className = "auth-msg" + (isError ? " error" : "");
}

function setPwMsg(text, isError) {
  var el = document.getElementById("pw-msg");
  el.textContent = text || "";
  el.className = "auth-msg" + (isError ? " error" : "");
}

function setStatus(online) {
  // connection indicator only - presence status is separate
  var el = document.getElementById("status-btn");
  if (!el) return;
  if (!online) {
    el.textContent = "Offline";
    el.classList.add("offline");
    return;
  }
  el.classList.remove("offline");
  renderMyStatusLabel();
}

function renderMyStatusLabel() {
  var el = document.getElementById("status-btn");
  if (!el) return;
  var label = myStatus.charAt(0).toUpperCase() + myStatus.slice(1);
  if (myStatusText) label += " - " + myStatusText;
  el.textContent = label;
}

function playPing() {
  if (!soundEnabled) return;
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    var o = ctx.createOscillator();
    var g = ctx.createGain();
    o.connect(g);
    g.connect(ctx.destination);
    o.frequency.value = 660;
    g.gain.value = 0.03;
    o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
    o.stop(ctx.currentTime + 0.2);
  } catch (e) {}
}

function updateMyName(name) {
  user = name;
  document.getElementById("my-name").textContent = name;
  var av = document.getElementById("my-avatar");
  av.textContent = initials(name);
  av.style.background = colorForName(name);
  var feedAv = document.getElementById("feed-avatar");
  if (feedAv) {
    feedAv.textContent = initials(name);
    feedAv.style.background = colorForName(name);
  }
}

function communityById(id) {
  if (!layout) return null;
  for (var i = 0; i < layout.communities.length; i++) {
    if (layout.communities[i].id === id) return layout.communities[i];
  }
  return null;
}

function channelMeta(community, id) {
  if (!community) return null;
  for (var i = 0; i < community.channels.length; i++) {
    if (community.channels[i].id === id) return community.channels[i];
  }
  return null;
}

function currentChannel() {
  if (communityId === "_dm") {
    for (var i = 0; i < dmThreads.length; i++) {
      if (dmThreads[i].channel === channelId) {
        return {
          id: dmThreads[i].channel,
          name: dmThreads[i].name,
          topic: "Direct message with @" + dmThreads[i].peer,
          type: "dm",
        };
      }
    }
    return { id: channelId, name: "Direct message", topic: "", type: "dm" };
  }
  return channelMeta(communityById(communityId), channelId);
}

function unreadCount(community, channel) {
  var list = community === "_dm" ? unreadState.dms : unreadState.channels;
  for (var i = 0; i < list.length; i++) {
    if (list[i].community === community && list[i].channel === channel) {
      return list[i].unread || 0;
    }
  }
  return 0;
}

function applyAdminUi() {
  var renameCh = document.getElementById("rename-channel");
  var renameCo = document.getElementById("rename-community");
  if (renameCh) renameCh.classList.toggle("hidden", !isAdmin || communityId === "_dm");
  if (renameCo) renameCo.classList.toggle("hidden", !isAdmin);
}

function openDm(peerUsername) {
  if (!socket || !peerUsername) return;
  if (feedMode) closeFeed();
  socket.emit("open_dm", { username: peerUsername });
}

function renderDms() {
  var list = document.getElementById("dms-list");
  if (!list) return;
  list.innerHTML = "";
  if (!dmThreads.length) {
    list.innerHTML = '<li class="member-row"><span class="sub">Open a chat from Friends</span></li>';
    return;
  }
  dmThreads.forEach(function (thread) {
    var li = document.createElement("li");
    li.className =
      "member-row dm-row" +
      (communityId === "_dm" && channelId === thread.channel ? " active" : "");
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dm-open";
    btn.textContent = thread.name;
    btn.onclick = function () {
      openDm(thread.peer);
    };
    li.appendChild(btn);
    var n = unreadCount("_dm", thread.channel);
    if (n) {
      var badge = document.createElement("span");
      badge.className = "unread-badge";
      badge.textContent = n > 99 ? "99+" : String(n);
      li.appendChild(badge);
    }
    list.appendChild(li);
  });
}

function renderServerRail() {
  var rail = document.getElementById("server-rail");
  rail.innerHTML = "";
  layout.communities.forEach(function (c) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "server-icon" + (c.id === communityId ? " active" : "");
    btn.title = c.name;
    btn.textContent = c.abbr;
    btn.onclick = function () {
      switchCommunity(c.id);
    };
    rail.appendChild(btn);
  });

  // phone menu: community chips instead of the left rail
  var mobileList = document.getElementById("mobile-community-list");
  if (mobileList) {
    mobileList.innerHTML = "";
    layout.communities.forEach(function (c) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = c.id === communityId ? "active" : "";
      btn.textContent = c.name;
      btn.onclick = function () {
        switchCommunity(c.id);
        closeMobileDrawers();
        setMobileNav("chat");
      };
      mobileList.appendChild(btn);
    });
  }
}

function renderChannels() {
  applyAdminUi();
  var list = document.getElementById("channel-list");
  list.innerHTML = "";

  if (communityId === "_dm") {
    document.getElementById("community-name").textContent = "Direct messages";
    dmThreads.forEach(function (thread) {
      var li = document.createElement("li");
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "channel-btn" + (thread.channel === channelId ? " active" : "");
      var label =
        '<span class="hash">@</span> <span class="channel-btn-label">' +
        escapeHtml(thread.name) +
        "</span>";
      var n = unreadCount("_dm", thread.channel);
      if (n) {
        label +=
          ' <span class="unread-badge">' +
          (n > 99 ? "99+" : String(n)) +
          "</span>";
      }
      btn.innerHTML = label;
      btn.onclick = function () {
        openDm(thread.peer);
      };
      li.appendChild(btn);
      list.appendChild(li);
    });
  } else {
    var community = communityById(communityId);
    if (!community) return;
    document.getElementById("community-name").textContent = community.name;
    community.channels.forEach(function (ch) {
      if (ch.type !== "text") return;
      var li = document.createElement("li");
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "channel-btn" + (ch.id === channelId ? " active" : "");
      var label =
        '<span class="hash">#</span> <span class="channel-btn-label">' +
        escapeHtml(ch.name) +
        "</span>";
      var n = unreadCount(communityId, ch.id);
      if (n) {
        label +=
          ' <span class="unread-badge">' +
          (n > 99 ? "99+" : String(n)) +
          "</span>";
      }
      btn.innerHTML = label;
      btn.onclick = function () {
        switchChannel(ch.id);
      };
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  var ch = currentChannel();
  var channelName = ch ? ch.name : channelId;
  var topic = (ch && ch.topic) || "No topic set";
  var prefix = communityId === "_dm" ? "@" : "#";
  document.getElementById("channel-title").textContent = channelName;
  document.getElementById("channel-topic").textContent = topic;
  document.getElementById("text").placeholder = "Message " + prefix + channelName;
  document.getElementById("welcome-title").textContent =
    "Welcome to " + prefix + channelName;
  document.getElementById("welcome-copy").textContent = topic;
  renderDms();
}

function makeMemberRow(name, isOnline, chan, extra) {
  extra = extra || {};
  var li = document.createElement("li");
  li.className = "member-row" + (isOnline ? " online" : "");
  var dot = document.createElement("span");
  dot.className = "dot";
  var label = document.createElement("span");
  label.className = "member-name";
  label.textContent = name;
  li.appendChild(dot);
  li.appendChild(label);
  if (isOnline && chan) {
    var sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = "#" + chan;
    li.appendChild(sub);
  }
  if (extra.status && extra.status !== "available") {
    var chip = document.createElement("span");
    chip.className = "status-chip " + extra.status;
    chip.textContent = extra.status_text
      ? extra.status + " - " + extra.status_text
      : extra.status;
    li.appendChild(chip);
  } else if (extra.status_text) {
    var note = document.createElement("span");
    note.className = "status-chip";
    note.textContent = extra.status_text;
    li.appendChild(note);
  }
  return li;
}

function renderPresence(data) {
  var online = data.online || [];
  var friends = data.friends || [];
  document.getElementById("online-count").textContent = String(online.length);

  var onlineList = document.getElementById("online-list");
  onlineList.innerHTML = "";
  if (!online.length) {
    onlineList.innerHTML = '<li class="member-row"><span class="sub">Nobody else online</span></li>';
  } else {
    online.forEach(function (row) {
      onlineList.appendChild(
        makeMemberRow(row.user, true, row.channel, {
          status: row.status,
          status_text: row.status_text,
        })
      );
    });
  }

  var friendsList = document.getElementById("friends-list");
  friendsList.innerHTML = "";
  if (!friends.length) {
    friendsList.innerHTML = '<li class="member-row"><span class="sub">Add people by username</span></li>';
  } else {
    friends.forEach(function (f) {
      var row = makeMemberRow(f.name, f.online, null, {
        status: f.status,
        status_text: f.status_text,
      });
      row.classList.add("friend-row");
      row.title = "Open DM with " + f.name;
      row.onclick = function () {
        openDm(f.username);
      };
      var removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "btn-icon small friend-remove";
      removeBtn.title = "Remove friend";
      removeBtn.textContent = "×";
      removeBtn.onclick = function (e) {
        e.stopPropagation();
        if (!socket) return;
        if (!window.confirm("Remove " + f.name + " from friends?")) return;
        socket.emit("remove_friend", { username: f.username });
      };
      row.appendChild(removeBtn);
      friendsList.appendChild(row);
    });
  }

  if (data.call) {
    renderCall(data.call);
  }
}

/* --- stories (24h rings) --- */

function renderStories(groups) {
  storyGroups = groups || [];
  var rail = document.getElementById("stories-rail");
  if (!rail) return;
  rail.innerHTML = "";

  // always show your own ring first (tap + to add if empty)
  var mine = null;
  for (var i = 0; i < storyGroups.length; i++) {
    if (storyGroups[i].is_me) {
      mine = storyGroups[i];
      break;
    }
  }

  var selfBtn = document.createElement("button");
  selfBtn.type = "button";
  selfBtn.className =
    "story-ring" +
    (mine ? " has-story" : "") +
    (mine && !mine.has_unseen ? " seen" : "");
  selfBtn.innerHTML =
    '<div class="story-ring-avatar" style="background:' +
    colorForName(user) +
    '">' +
    escapeHtml(initials(user)) +
    '</div><span class="story-ring-name">Your story</span>';
  selfBtn.onclick = function () {
    if (mine && mine.stories.length) openStoryViewer(mine);
    else openStoryModal();
  };
  rail.appendChild(selfBtn);

  storyGroups.forEach(function (g) {
    if (g.is_me) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "story-ring has-story" + (g.has_unseen ? "" : " seen");
    btn.innerHTML =
      '<div class="story-ring-avatar" style="background:' +
      colorForName(g.user) +
      '">' +
      escapeHtml(initials(g.user)) +
      '</div><span class="story-ring-name">' +
      escapeHtml(g.user.split(" ")[0]) +
      "</span>";
    btn.onclick = function () {
      openStoryViewer(g);
    };
    rail.appendChild(btn);
  });
}

function openStoryModal() {
  document.getElementById("story-text").value = "";
  document.getElementById("story-image").value = "";
  clearStoryAttach();
  pendingStoryBg = "#1c212b";
  document.querySelectorAll(".story-bg").forEach(function (b) {
    b.classList.toggle("active", b.getAttribute("data-bg") === pendingStoryBg);
  });
  document.getElementById("story-modal").classList.remove("hidden");
}

function closeStoryModal() {
  document.getElementById("story-modal").classList.add("hidden");
  clearStoryAttach();
}

function openStatusModal() {
  pendingStatus = myStatus;
  document.getElementById("status-text-input").value = myStatusText;
  document.querySelectorAll(".status-choice").forEach(function (b) {
    b.classList.toggle("active", b.getAttribute("data-status") === pendingStatus);
  });
  document.getElementById("status-modal").classList.remove("hidden");
}

function closeStatusModal() {
  document.getElementById("status-modal").classList.add("hidden");
}

function openStoryViewer(group) {
  storyViewerGroup = group;
  storyViewerIndex = 0;
  document.getElementById("story-viewer").classList.remove("hidden");
  showStorySlide();
}

function closeStoryViewer() {
  clearTimeout(storyTimer);
  storyTimer = null;
  storyViewerGroup = null;
  document.getElementById("story-viewer").classList.add("hidden");
}

function showStorySlide() {
  clearTimeout(storyTimer);
  if (!storyViewerGroup) return;
  var stories = storyViewerGroup.stories || [];
  if (!stories.length) {
    closeStoryViewer();
    return;
  }
  if (storyViewerIndex < 0) storyViewerIndex = 0;
  if (storyViewerIndex >= stories.length) {
    closeStoryViewer();
    return;
  }

  var story = stories[storyViewerIndex];
  document.getElementById("story-viewer-name").textContent = story.user;

  var progress = document.getElementById("story-progress");
  progress.innerHTML = "";
  for (var i = 0; i < stories.length; i++) {
    var bar = document.createElement("span");
    if (i < storyViewerIndex) bar.className = "done";
    if (i === storyViewerIndex) bar.className = "active";
    bar.innerHTML = "<i></i>";
    progress.appendChild(bar);
  }

  var body = document.getElementById("story-viewer-body");
  body.style.backgroundImage = "";
  body.style.backgroundColor = story.bg_color || "#1c212b";
  body.textContent = "";
  if (story.image_url) {
    body.style.backgroundImage = "url('" + story.image_url.replace(/'/g, "%27") + "')";
    if (story.text) {
      var cap = document.createElement("div");
      cap.style.background = "rgba(0,0,0,0.45)";
      cap.style.padding = "0.6rem 0.8rem";
      cap.style.borderRadius = "10px";
      cap.textContent = story.text;
      body.appendChild(cap);
    }
  } else {
    body.textContent = story.text || "";
  }

  if (socket) socket.emit("story_view", { id: story.id });

  storyTimer = setTimeout(function () {
    storyViewerIndex += 1;
    showStorySlide();
  }, 5000);
}

function formatRelative(iso) {
  if (!iso) return "";
  try {
    var t = new Date(iso).getTime();
    var diff = Math.max(0, Date.now() - t);
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m";
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + "h";
    var days = Math.floor(hours / 24);
    if (days < 7) return days + "d";
    return formatTime(iso);
  } catch (e) {
    return "";
  }
}

function openFeed() {
  feedMode = true;
  document.getElementById("app").classList.add("feed-mode");
  document.getElementById("feed-view").classList.remove("hidden");
  document.getElementById("open-feed").classList.add("active");
  closeMobileDrawers();
  setMobileNav("home");
  document.getElementById("feed-list").innerHTML = "";
  feedOldestId = null;
  if (socket) socket.emit("feed_load", {});
}

function closeFeed() {
  feedMode = false;
  document.getElementById("app").classList.remove("feed-mode");
  document.getElementById("feed-view").classList.add("hidden");
  document.getElementById("open-feed").classList.remove("active");
  setMobileNav("chat");
}

function isMobileLayout() {
  return window.matchMedia("(max-width: 900px)").matches;
}

function setMobileNav(which) {
  document.querySelectorAll(".mobile-nav-btn").forEach(function (btn) {
    btn.classList.toggle("active", btn.getAttribute("data-mobile") === which);
  });
}

function closeMobileDrawers() {
  var sidebar = document.querySelector(".sidebar");
  var members = document.getElementById("members-panel");
  var backdrop = document.getElementById("mobile-backdrop");
  if (sidebar) sidebar.classList.remove("open");
  if (members) members.classList.remove("open");
  if (backdrop) {
    backdrop.classList.add("hidden");
    backdrop.classList.remove("show");
  }
}

function openMobileSidebar() {
  if (feedMode) closeFeed();
  closeMobileDrawers();
  document.querySelector(".sidebar").classList.add("open");
  var backdrop = document.getElementById("mobile-backdrop");
  backdrop.classList.remove("hidden");
  backdrop.classList.add("show");
  setMobileNav("menu");
}

function openMobilePeople() {
  if (feedMode) closeFeed();
  closeMobileDrawers();
  document.getElementById("members-panel").classList.add("open");
  var backdrop = document.getElementById("mobile-backdrop");
  backdrop.classList.remove("hidden");
  backdrop.classList.add("show");
  setMobileNav("people");
}

function renderFeedPosts(posts, append) {
  var list = document.getElementById("feed-list");
  var empty = document.getElementById("feed-empty");
  if (!append) list.innerHTML = "";
  (posts || []).forEach(function (post) {
    var existing = document.getElementById("feed-post-" + post.id);
    if (existing) {
      existing.replaceWith(buildFeedCard(post));
    } else {
      list.appendChild(buildFeedCard(post));
    }
  });
  if (!list.children.length) {
    empty.classList.remove("hidden");
  } else {
    empty.classList.add("hidden");
  }
  if (posts && posts.length) {
    feedOldestId = posts[posts.length - 1].id;
  }
}

function prependFeedPost(post) {
  var list = document.getElementById("feed-list");
  document.getElementById("feed-empty").classList.add("hidden");
  var existing = document.getElementById("feed-post-" + post.id);
  if (existing) existing.remove();
  list.insertBefore(buildFeedCard(post), list.firstChild);
}

function buildFeedCard(post) {
  // X/Twitter style row: avatar | name @handle · time + body + actions
  var card = document.createElement("article");
  card.className = "feed-card x-post";
  card.id = "feed-post-" + post.id;

  var av = document.createElement("div");
  av.className = "x-post-avatar";
  av.style.background = colorForName(post.user);
  av.textContent = initials(post.user);

  var body = document.createElement("div");
  body.className = "x-post-body";

  var line = document.createElement("div");
  line.className = "x-post-line";
  var name = document.createElement("span");
  name.className = "x-post-name";
  name.textContent = post.user;
  var handle = document.createElement("span");
  handle.className = "x-post-handle";
  handle.textContent = "@" + (post.username || "user");
  var dot = document.createElement("span");
  dot.className = "x-post-dot";
  dot.textContent = "·";
  var time = document.createElement("span");
  time.className = "x-post-time";
  time.textContent = formatRelative(post.at);
  line.appendChild(name);
  line.appendChild(handle);
  line.appendChild(dot);
  line.appendChild(time);
  body.appendChild(line);

  if (post.text) {
    var textEl = document.createElement("p");
    textEl.className = "x-post-text";
    textEl.textContent = post.text;
    body.appendChild(textEl);
  }

  if (post.image_url) {
    var img = document.createElement("img");
    img.className = "x-post-image";
    img.src = post.image_url;
    img.alt = "Post image";
    img.loading = "lazy";
    img.onerror = function () {
      img.remove();
    };
    body.appendChild(img);
  }

  var actions = document.createElement("div");
  actions.className = "x-post-actions";

  var commentCount = (post.comments || []).length;
  var replyBtn = document.createElement("button");
  replyBtn.type = "button";
  replyBtn.className = "x-action";
  replyBtn.textContent = "Reply " + commentCount;
  actions.appendChild(replyBtn);

  var likeBtn = document.createElement("button");
  likeBtn.type = "button";
  likeBtn.className = "x-action" + (post.liked_by_me ? " liked" : "");
  likeBtn.textContent = (post.liked_by_me ? "Liked" : "Like") + " " + (post.like_count || 0);
  likeBtn.onclick = function () {
    if (socket) socket.emit("post_like", { id: post.id });
  };
  actions.appendChild(likeBtn);

  if (post.username === username) {
    var del = document.createElement("button");
    del.type = "button";
    del.className = "x-action";
    del.textContent = "Delete";
    del.onclick = function () {
      if (socket) socket.emit("post_delete", { id: post.id });
    };
    actions.appendChild(del);
  }

  body.appendChild(actions);

  var commentsWrap = document.createElement("div");
  commentsWrap.className = "x-comments";
  (post.comments || []).forEach(function (c) {
    var row = document.createElement("div");
    row.className = "feed-comment";
    var who = document.createElement("strong");
    who.textContent = c.user;
    row.appendChild(who);
    row.appendChild(document.createTextNode(c.text));
    commentsWrap.appendChild(row);
  });

  var form = document.createElement("form");
  form.className = "feed-comment-form";
  var input = document.createElement("input");
  input.type = "text";
  input.maxLength = 500;
  input.placeholder = "Post your reply";
  var send = document.createElement("button");
  send.type = "submit";
  send.className = "btn-secondary compact";
  send.textContent = "Reply";
  form.appendChild(input);
  form.appendChild(send);
  form.onsubmit = function (e) {
    e.preventDefault();
    var value = input.value.trim();
    if (!value || !socket) return;
    socket.emit("post_comment", { id: post.id, text: value });
    input.value = "";
  };
  commentsWrap.appendChild(form);
  body.appendChild(commentsWrap);

  replyBtn.onclick = function () {
    commentsWrap.classList.toggle("open");
    input.focus();
  };

  card.appendChild(av);
  card.appendChild(body);
  return card;
}

function formatEventWhen(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch (e) {
    return iso;
  }
}

function renderEvents(events) {
  var list = document.getElementById("events-list");
  if (!list) return;
  list.innerHTML = "";
  if (!events || !events.length) {
    list.innerHTML = '<li class="member-row"><span class="sub">No upcoming events</span></li>';
    return;
  }
  events.forEach(function (ev) {
    var li = document.createElement("li");
    li.className = "event-row";
    var title = document.createElement("span");
    title.className = "event-title";
    title.textContent = ev.title;
    var meta = document.createElement("span");
    meta.className = "event-meta";
    var bits = [formatEventWhen(ev.starts_at)];
    if (ev.location) bits.push(ev.location);
    meta.textContent = bits.join(" - ");
    li.appendChild(title);
    li.appendChild(meta);
    list.appendChild(li);
  });
}

function renderCall(data) {
  var banner = document.getElementById("call-banner");
  var peopleEl = document.getElementById("call-people");
  var meetBtn = document.getElementById("meet-now");
  if (!banner || !data) return;

  currentCallRoom = data.room || currentCallRoom;
  var people = data.participants || [];
  lastCallParticipants = people;
  var myRoom = communityId && channelId ? communityId + ":" + channelId : "";
  var isThisChannel = !data.room || data.room === myRoom;

  if (!isThisChannel) return;

  var wasInCall = inCall;
  inCall = people.some(function (p) {
    return p.username === username;
  });

  if (!people.length) {
    banner.classList.add("hidden");
    if (meetBtn) meetBtn.textContent = "Meet now";
    var meetMobileClear = document.getElementById("meet-now-mobile");
    if (meetMobileClear) meetMobileClear.textContent = "Meet now";
    if (wasInCall) teardownCallMedia();
    else hideCallStage();
    return;
  }

  banner.classList.remove("hidden");
  peopleEl.textContent = people
    .map(function (p) {
      return p.name;
    })
    .join(", ");
  if (meetBtn) meetBtn.textContent = inCall ? "In call" : "Join call";
  var meetMobileBtn = document.getElementById("meet-now-mobile");
  if (meetMobileBtn) meetMobileBtn.textContent = inCall ? "Leave call" : "Meet now";

  if (inCall) {
    syncCallPeers(people);
    updateCallMediaButtons();
    renderCallTiles(people);
  } else if (wasInCall) {
    teardownCallMedia();
  } else {
    hideCallStage();
  }
}

function hideCallStage() {
  var stage = document.getElementById("call-stage");
  if (stage) stage.classList.add("hidden");
}

function updateCallMediaButtons() {
  var micBtn = document.getElementById("call-toggle-mic");
  var camBtn = document.getElementById("call-toggle-cam");
  var audioTrack = localStream && localStream.getAudioTracks()[0];
  var videoTrack = localStream && localStream.getVideoTracks()[0];
  var micLive = !!(audioTrack && audioTrack.enabled);
  var camLive = !!(videoTrack && videoTrack.enabled);
  if (micBtn) {
    micBtn.textContent = micLive ? "Mic on" : "Mic off";
    micBtn.setAttribute("aria-pressed", micLive ? "true" : "false");
    micBtn.disabled = !audioTrack;
  }
  if (camBtn) {
    camBtn.textContent = camLive ? "Cam on" : "Cam off";
    camBtn.setAttribute("aria-pressed", camLive ? "true" : "false");
    camBtn.disabled = !videoTrack && !wantCam;
  }
}

function renderCallTiles(people) {
  var stage = document.getElementById("call-stage");
  var tiles = document.getElementById("call-tiles");
  if (!stage || !tiles) return;
  if (!inCall) {
    stage.classList.add("hidden");
    return;
  }
  stage.classList.remove("hidden");

  var keep = { local: true };
  people.forEach(function (p) {
    if (p.username !== username) keep[p.username] = true;
  });

  Array.prototype.slice.call(tiles.children).forEach(function (el) {
    var key = el.getAttribute("data-peer");
    if (!keep[key]) el.remove();
  });

  ensureCallTile("local", "You", true);
  people.forEach(function (p) {
    if (p.username === username) return;
    ensureCallTile(p.username, p.name || p.username, false);
  });

  var localTile = tiles.querySelector('[data-peer="local"]');
  if (localTile) {
    var localVideo = localTile.querySelector("video");
    if (localVideo && localStream && localVideo.srcObject !== localStream) {
      localVideo.srcObject = localStream;
    }
    var hasVideo = !!(localStream && localStream.getVideoTracks().some(function (t) {
      return t.enabled && t.readyState === "live";
    }));
    localTile.classList.toggle("audio-only", !hasVideo);
  }

  people.forEach(function (p) {
    if (p.username === username) return;
    var tile = tiles.querySelector('[data-peer="' + p.username + '"]');
    if (!tile) return;
    var video = tile.querySelector("video");
    var stream = remoteStreams[p.username];
    if (video && stream && video.srcObject !== stream) {
      video.srcObject = stream;
    }
    var hasVideo = !!(stream && stream.getVideoTracks().some(function (t) {
      return t.readyState === "live";
    }));
    tile.classList.toggle("audio-only", !hasVideo);
  });
}

function ensureCallTile(peerKey, label, muted) {
  var tiles = document.getElementById("call-tiles");
  if (!tiles) return;
  var existing = tiles.querySelector('[data-peer="' + peerKey + '"]');
  if (existing) {
    var nameEl = existing.querySelector(".call-tile-label");
    if (nameEl) nameEl.textContent = label;
    return;
  }
  var tile = document.createElement("div");
  tile.className = "call-tile audio-only";
  tile.setAttribute("data-peer", peerKey);
  var video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = !!muted;
  var avatar = document.createElement("div");
  avatar.className = "call-tile-avatar";
  avatar.textContent = (label || "?").charAt(0).toUpperCase();
  var name = document.createElement("span");
  name.className = "call-tile-label";
  name.textContent = label;
  tile.appendChild(video);
  tile.appendChild(avatar);
  tile.appendChild(name);
  tiles.appendChild(tile);
}

function syncMediaPermissionUi() {
  var micBtn = document.getElementById("settings-mic");
  var camBtn = document.getElementById("settings-cam");
  var micHint = document.getElementById("settings-mic-hint");
  var camHint = document.getElementById("settings-cam-hint");
  if (micBtn) {
    if (micPermission === "denied") {
      micBtn.textContent = "Blocked";
      micBtn.setAttribute("aria-pressed", "false");
    } else if (wantMic && micPermission === "granted") {
      micBtn.textContent = "On";
      micBtn.setAttribute("aria-pressed", "true");
    } else if (wantMic) {
      micBtn.textContent = "Allow";
      micBtn.setAttribute("aria-pressed", "false");
    } else {
      micBtn.textContent = "Off";
      micBtn.setAttribute("aria-pressed", "false");
    }
  }
  if (camBtn) {
    if (camPermission === "denied") {
      camBtn.textContent = "Blocked";
      camBtn.setAttribute("aria-pressed", "false");
    } else if (wantCam && camPermission === "granted") {
      camBtn.textContent = "On";
      camBtn.setAttribute("aria-pressed", "true");
    } else if (wantCam) {
      camBtn.textContent = "Allow";
      camBtn.setAttribute("aria-pressed", "false");
    } else {
      camBtn.textContent = "Off";
      camBtn.setAttribute("aria-pressed", "false");
    }
  }
  if (micHint) {
    micHint.textContent =
      micPermission === "denied"
        ? "Blocked in the browser — reset site permissions, then Allow"
        : "Use mic in Meet now (browser will ask once)";
  }
  if (camHint) {
    camHint.textContent =
      camPermission === "denied"
        ? "Blocked in the browser — reset site permissions, then Allow"
        : "Use camera in Meet now (browser will ask once)";
  }
}

function refreshMediaPermissionState() {
  if (!navigator.permissions || !navigator.permissions.query) {
    syncMediaPermissionUi();
    return Promise.resolve();
  }
  return Promise.all([
    navigator.permissions.query({ name: "microphone" }).then(function (status) {
      micPermission = status.state;
      status.onchange = function () {
        micPermission = status.state;
        syncMediaPermissionUi();
      };
    }).catch(function () {}),
    navigator.permissions.query({ name: "camera" }).then(function (status) {
      camPermission = status.state;
      status.onchange = function () {
        camPermission = status.state;
        syncMediaPermissionUi();
      };
    }).catch(function () {}),
  ]).then(syncMediaPermissionUi);
}

function stopLocalStream() {
  if (!localStream) return;
  localStream.getTracks().forEach(function (track) {
    track.stop();
  });
  localStream = null;
}

function teardownCallMedia() {
  Object.keys(peerConnections).forEach(function (peer) {
    try {
      peerConnections[peer].close();
    } catch (e) {}
  });
  peerConnections = {};
  remoteStreams = {};
  stopLocalStream();
  hideCallStage();
  var tiles = document.getElementById("call-tiles");
  if (tiles) tiles.innerHTML = "";
  updateCallMediaButtons();
}

function ensureLocalMedia() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return Promise.reject(new Error("Media devices unavailable"));
  }
  var needAudio = wantMic;
  var needVideo = wantCam;
  if (!needAudio && !needVideo) {
    stopLocalStream();
    return Promise.resolve(null);
  }
  if (localStream) {
    var hasAudio = localStream.getAudioTracks().length > 0;
    var hasVideo = localStream.getVideoTracks().length > 0;
    if ((!!needAudio === hasAudio) && (!!needVideo === hasVideo || !needVideo)) {
      localStream.getAudioTracks().forEach(function (t) {
        t.enabled = needAudio;
      });
      localStream.getVideoTracks().forEach(function (t) {
        t.enabled = needVideo;
      });
      return Promise.resolve(localStream);
    }
    stopLocalStream();
  }
  return navigator.mediaDevices
    .getUserMedia({ audio: needAudio, video: needVideo })
    .then(function (stream) {
      localStream = stream;
      if (needAudio) micPermission = "granted";
      if (needVideo) camPermission = "granted";
      syncMediaPermissionUi();
      updateCallMediaButtons();
      return stream;
    })
    .catch(function (err) {
      if (needAudio) micPermission = "denied";
      if (needVideo) camPermission = "denied";
      syncMediaPermissionUi();
      throw err;
    });
}

function requestMediaPermission(kind) {
  var constraints =
    kind === "camera" ? { audio: false, video: true } : { audio: true, video: false };
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast("This browser cannot access mic or camera", true);
    return Promise.resolve();
  }
  return navigator.mediaDevices
    .getUserMedia(constraints)
    .then(function (stream) {
      stream.getTracks().forEach(function (t) {
        t.stop();
      });
      if (kind === "camera") {
        wantCam = true;
        camPermission = "granted";
        localStorage.setItem("chatwire_want_cam", "1");
        toast("Camera allowed");
      } else {
        wantMic = true;
        micPermission = "granted";
        localStorage.setItem("chatwire_want_mic", "1");
        toast("Microphone allowed");
      }
      syncMediaPermissionUi();
      if (inCall) {
        return ensureLocalMedia().then(function () {
          renegotiateLocalTracks();
          renderCallTiles(lastCallParticipants);
        });
      }
    })
    .catch(function () {
      if (kind === "camera") camPermission = "denied";
      else micPermission = "denied";
      syncMediaPermissionUi();
      toast(
        kind === "camera"
          ? "Camera blocked — check the browser site settings"
          : "Microphone blocked — check the browser site settings",
        true
      );
    });
}

function renegotiateLocalTracks() {
  Object.keys(peerConnections).forEach(function (peer) {
    var pc = peerConnections[peer];
    if (!pc || !localStream) return;
    var senders = pc.getSenders();
    localStream.getTracks().forEach(function (track) {
      var sender = senders.find(function (s) {
        return s.track && s.track.kind === track.kind;
      });
      if (sender) sender.replaceTrack(track);
      else pc.addTrack(track, localStream);
    });
  });
}

function syncCallPeers(people) {
  if (!inCall || !socket) return;
  var others = people
    .map(function (p) {
      return p.username;
    })
    .filter(function (name) {
      return name && name !== username;
    });

  Object.keys(peerConnections).forEach(function (peer) {
    if (others.indexOf(peer) === -1) {
      try {
        peerConnections[peer].close();
      } catch (e) {}
      delete peerConnections[peer];
      delete remoteStreams[peer];
    }
  });

  others.forEach(function (peer) {
    if (peerConnections[peer]) return;
    // Only the lexicographically smaller username offers, to avoid glare.
    if (username < peer) {
      createPeerConnection(peer, true);
    }
  });
}

function createPeerConnection(peerUsername, isOfferer) {
  if (peerConnections[peerUsername]) return peerConnections[peerUsername];
  var pc = new RTCPeerConnection(ICE_SERVERS);
  peerConnections[peerUsername] = pc;

  if (localStream) {
    localStream.getTracks().forEach(function (track) {
      pc.addTrack(track, localStream);
    });
  } else {
    try {
      pc.addTransceiver("audio", { direction: "recvonly" });
      pc.addTransceiver("video", { direction: "recvonly" });
    } catch (e) {}
  }

  pc.onicecandidate = function (event) {
    if (!event.candidate || !socket) return;
    socket.emit("webrtc_signal", {
      to: peerUsername,
      type: "ice",
      candidate: event.candidate,
    });
  };

  pc.ontrack = function (event) {
    var stream = event.streams && event.streams[0];
    if (!stream) {
      stream = new MediaStream([event.track]);
    }
    remoteStreams[peerUsername] = stream;
    if (inCall) renderCallTiles(lastCallParticipants);
  };

  pc.onconnectionstatechange = function () {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      try {
        pc.close();
      } catch (e) {}
      delete peerConnections[peerUsername];
    }
  };

  if (isOfferer) {
    pc
      .createOffer()
      .then(function (offer) {
        return pc.setLocalDescription(offer);
      })
      .then(function () {
        if (!socket) return;
        socket.emit("webrtc_signal", {
          to: peerUsername,
          type: "offer",
          sdp: pc.localDescription,
        });
      })
      .catch(function () {
        toast("Could not start media with " + peerUsername, true);
      });
  }

  return pc;
}

function handleWebRtcSignal(data) {
  if (!data || !data.from || !inCall) return;
  var peer = data.from;
  var pc = peerConnections[peer];
  if (data.type === "offer") {
    pc = createPeerConnection(peer, false);
    pc
      .setRemoteDescription(data.sdp)
      .then(function () {
        return pc.createAnswer();
      })
      .then(function (answer) {
        return pc.setLocalDescription(answer);
      })
      .then(function () {
        if (!socket) return;
        socket.emit("webrtc_signal", {
          to: peer,
          type: "answer",
          sdp: pc.localDescription,
        });
      })
      .catch(function () {
        toast("Could not answer media from " + peer, true);
      });
    return;
  }
  if (!pc) return;
  if (data.type === "answer") {
    pc.setRemoteDescription(data.sdp).catch(function () {});
    return;
  }
  if (data.type === "ice" && data.candidate) {
    pc.addIceCandidate(data.candidate).catch(function () {});
  }
}

function clearLog() {
  document.getElementById("log").innerHTML = "";
  lastMessageMeta = null;
  updateEmptyState(true);
}

function updateEmptyState(isEmpty) {
  var empty = document.getElementById("empty-channel");
  var welcome = document.getElementById("welcome-banner");
  if (!empty) return;
  empty.classList.toggle("hidden", !isEmpty);
  if (welcome) welcome.classList.toggle("hidden", !isEmpty);
}

function findMessageRow(msgId) {
  return document.querySelector('[data-msg-id="' + msgId + '"]');
}

function shouldGroup(msg) {
  if (!lastMessageMeta || msg.system) return false;
  if (lastMessageMeta.user !== msg.user) return false;
  try {
    var prev = new Date(lastMessageMeta.at).getTime();
    var next = new Date(msg.at).getTime();
    return next - prev < 5 * 60 * 1000 && dayKey(msg.at) === dayKey(lastMessageMeta.at);
  } catch (e) {
    return false;
  }
}

function appendDaySepIfNeeded(msg) {
  var log = document.getElementById("log");
  var key = dayKey(msg.at);
  if (!lastMessageMeta || dayKey(lastMessageMeta.at) !== key) {
    var sep = document.createElement("li");
    sep.className = "day-sep";
    sep.textContent = dayLabel(msg.at);
    log.appendChild(sep);
  }
}

function renderReactions(container, msg) {
  container.innerHTML = "";
  var reactions = msg.reactions || {};
  Object.keys(reactions).forEach(function (emoji) {
    var users = reactions[emoji] || [];
    if (!users.length) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "reaction-pill" + (users.indexOf(username) >= 0 ? " mine" : "");
    btn.textContent = emoji + " " + users.length;
    btn.title = users.join(", ");
    btn.onclick = function () {
      if (socket) socket.emit("react_message", { id: msg.id, emoji: emoji });
    };
    container.appendChild(btn);
  });
}

function buildMessageRow(msg, grouped) {
  var li = document.createElement("li");
  li.className = "msg-row" + (grouped ? " grouped" : "");
  li.setAttribute("data-msg-id", msg.id);
  li.setAttribute("data-user", msg.user);
  li.setAttribute("data-text", msg.text || "");

  var avatar = document.createElement("div");
  avatar.className = "avatar xs";
  avatar.style.background = colorForName(msg.user);
  avatar.textContent = initials(msg.user);

  var body = document.createElement("div");
  body.className = "msg-body";

  var head = document.createElement("div");
  head.className = "msg-head";
  var name = document.createElement("span");
  name.className = "msg-name";
  name.textContent = msg.user;
  var time = document.createElement("span");
  time.className = "msg-time";
  time.textContent = formatTime(msg.at);
  head.appendChild(name);
  head.appendChild(time);
  if (msg.edited_at) {
    var edited = document.createElement("span");
    edited.className = "msg-edited";
    edited.textContent = "(edited)";
    head.appendChild(edited);
  }

  var text = document.createElement("div");
  text.className = "msg-text";
  if (msg.text) {
    text.innerHTML = renderMarkdown(msg.text);
  } else {
    text.classList.add("hidden");
  }

  var reactions = document.createElement("div");
  reactions.className = "reactions";
  renderReactions(reactions, msg);

  body.appendChild(head);
  body.appendChild(text);
  if (msg.image_url) {
    var img = document.createElement("img");
    img.className = "msg-image";
    img.src = msg.image_url;
    img.alt = "Attached photo";
    img.loading = "lazy";
    body.appendChild(img);
  }
  body.appendChild(reactions);
  li.appendChild(avatar);
  li.appendChild(body);

  var actions = document.createElement("div");
  actions.className = "msg-actions";
  QUICK_EMOJIS.slice(0, 4).forEach(function (emoji) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "msg-action-btn";
    b.textContent = emoji;
    b.title = "React";
    b.onclick = function () {
      if (socket) socket.emit("react_message", { id: msg.id, emoji: emoji });
    };
    actions.appendChild(b);
  });
  if (msg.user === user) {
    var editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "msg-action-btn";
    editBtn.textContent = "Edit";
    editBtn.onclick = function () {
      startEditMessage(li, msg.id, msg.text);
    };
    actions.appendChild(editBtn);
  }
  var more = document.createElement("button");
  more.type = "button";
  more.className = "msg-action-btn";
  more.textContent = "+";
  more.title = "More emoji";
  more.onclick = function () {
    reactionTargetId = msg.id;
    document.getElementById("emoji-panel").classList.remove("hidden");
  };
  actions.appendChild(more);
  li.appendChild(actions);

  return li;
}

function addMessage(msg, opts) {
  opts = opts || {};
  var log = document.getElementById("log");
  updateEmptyState(false);
  if (msg.system) {
    var sys = document.createElement("li");
    sys.className = "sys";
    sys.textContent = msg.user + " " + msg.text;
    log.appendChild(sys);
    log.scrollTop = log.scrollHeight;
    return;
  }

  appendDaySepIfNeeded(msg);
  var grouped = shouldGroup(msg);
  log.appendChild(buildMessageRow(msg, grouped));
  lastMessageMeta = { user: msg.user, at: msg.at };
  channelMessagesCache.push(msg);
  if (!opts.silent) {
    log.scrollTop = log.scrollHeight;
    if (msg.user !== user) playPing();
  }
  applySearchFilter();
}

function updateMessageEdited(msg) {
  var row = findMessageRow(msg.id);
  if (!row) return;
  row.setAttribute("data-text", msg.text || "");
  var textEl = row.querySelector(".msg-text");
  var nameEl = row.querySelector(".msg-name");
  var head = row.querySelector(".msg-head");
  if (textEl) textEl.innerHTML = renderMarkdown(msg.text);
  if (nameEl) nameEl.textContent = msg.user;
  if (head) {
    var old = head.querySelector(".msg-edited");
    if (old) old.remove();
    if (msg.edited_at) {
      var edited = document.createElement("span");
      edited.className = "msg-edited";
      edited.textContent = "(edited)";
      head.appendChild(edited);
    }
  }
  for (var i = 0; i < channelMessagesCache.length; i++) {
    if (channelMessagesCache[i].id === msg.id) channelMessagesCache[i] = msg;
  }
  applySearchFilter();
}

function updateMessageReacted(msg) {
  var row = findMessageRow(msg.id);
  if (!row) return;
  var box = row.querySelector(".reactions");
  if (box) renderReactions(box, msg);
  for (var i = 0; i < channelMessagesCache.length; i++) {
    if (channelMessagesCache[i].id === msg.id) channelMessagesCache[i] = msg;
  }
}

function startEditMessage(row, msgId, currentText) {
  if (row.querySelector(".msg-edit-form")) return;
  var body = row.querySelector(".msg-body");
  var textEl = row.querySelector(".msg-text");
  if (!body || !textEl) return;
  textEl.style.display = "none";
  var form = document.createElement("div");
  form.className = "msg-edit-form";
  var input = document.createElement("textarea");
  input.rows = 2;
  input.value = currentText;
  var actions = document.createElement("div");
  actions.className = "edit-actions";
  var save = document.createElement("button");
  save.type = "button";
  save.className = "btn-primary inline";
  save.textContent = "Save";
  var cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn-secondary";
  cancel.textContent = "Cancel";
  function closeForm() {
    form.remove();
    textEl.style.display = "";
  }
  save.onclick = function () {
    var next = input.value.trim();
    if (next && socket) socket.emit("edit_message", { id: msgId, text: next });
    closeForm();
  };
  cancel.onclick = closeForm;
  input.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeForm();
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      save.click();
    }
  });
  actions.appendChild(cancel);
  actions.appendChild(save);
  form.appendChild(input);
  form.appendChild(actions);
  body.appendChild(form);
  input.focus();
}

function loadChannelHistory(messages, hasMore) {
  clearLog();
  channelMessagesCache = [];
  var list = messages || [];
  channelHasMore = !!hasMore;
  channelOldestId = list.length ? list[0].id : null;
  var olderBtn = document.getElementById("load-older");
  if (olderBtn) olderBtn.classList.toggle("hidden", !channelHasMore);

  if (!list.length) {
    updateEmptyState(true);
  } else {
    list.forEach(function (msg) {
      addMessage(msg, { silent: true });
    });
  }
  var log = document.getElementById("log");
  log.scrollTop = log.scrollHeight;
  applySearchFilter();
}

function prependOlderMessages(messages, hasMore) {
  var log = document.getElementById("log");
  var prevHeight = log.scrollHeight;
  var list = messages || [];
  channelHasMore = !!hasMore;
  var olderBtn = document.getElementById("load-older");
  if (olderBtn) olderBtn.classList.toggle("hidden", !channelHasMore);
  if (!list.length) return;

  // insert oldest-first at the top, then restore scroll so the view doesn't jump
  for (var i = list.length - 1; i >= 0; i--) {
    var msg = list[i];
    if (msg.system) continue;
    log.insertBefore(buildMessageRow(msg, false), log.firstChild);
    channelMessagesCache.unshift(msg);
  }
  channelOldestId = list[0].id;
  log.scrollTop = log.scrollHeight - prevHeight;
  applySearchFilter();
}

function applySearchFilter() {
  var q = (document.getElementById("message-search").value || "").trim().toLowerCase();
  document.querySelectorAll(".msg-row").forEach(function (row) {
    if (!q) {
      row.classList.remove("dimmed");
      return;
    }
    var hay = ((row.getAttribute("data-user") || "") + " " + (row.getAttribute("data-text") || "")).toLowerCase();
    row.classList.toggle("dimmed", hay.indexOf(q) === -1);
  });
}

function showApp() {
  document.getElementById("setup").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  updateMyName(user);
}

function showSetup() {
  document.getElementById("setup").classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");
  clearLog();
  setStatus(false);
}

function switchCommunity(id) {
  if (feedMode) closeFeed();
  if (!socket || id === communityId) return;
  var community = communityById(id);
  if (!community) return;
  communityId = id;
  var firstText = null;
  for (var i = 0; i < community.channels.length; i++) {
    if (community.channels[i].type === "text") {
      firstText = community.channels[i];
      break;
    }
  }
  channelId = firstText ? firstText.id : community.channels[0].id;
  renderServerRail();
  renderChannels();
  socket.emit("join_channel", { community: communityId, channel: channelId });
}

function switchChannel(id) {
  if (feedMode) closeFeed();
  if (!socket) return;
  if (communityId === "_dm") return;
  if (id === channelId) return;
  channelId = id;
  renderChannels();
  socket.emit("join_channel", { community: communityId, channel: channelId });
}

function openPrompt(opts) {
  promptCallback = opts.onSave;
  document.getElementById("prompt-title").textContent = opts.title || "Edit";
  document.getElementById("prompt-desc").textContent = opts.desc || "";
  document.getElementById("prompt-label-1").firstChild.textContent = opts.label1 || "Name ";
  document.getElementById("prompt-input-1").value = opts.value1 || "";
  var label2 = document.getElementById("prompt-label-2");
  if (opts.label2) {
    label2.classList.remove("hidden");
    label2.firstChild.textContent = opts.label2 + " ";
    document.getElementById("prompt-input-2").value = opts.value2 || "";
  } else {
    label2.classList.add("hidden");
  }
  document.getElementById("prompt-modal").classList.remove("hidden");
  document.getElementById("prompt-input-1").focus();
}

function closePrompt() {
  document.getElementById("prompt-modal").classList.add("hidden");
  promptCallback = null;
}

function promptDisplayName() {
  openPrompt({
    title: "Display name",
    desc: "Shown next to your messages in every channel.",
    label1: "Name",
    value1: user,
    onSave: function (name) {
      var next = (name || "").trim().slice(0, 32);
      if (next && socket) socket.emit("update_display_name", { user: next });
    },
  });
}

function promptRenameCommunity() {
  if (!isAdmin) {
    toast("Only admins can rename communities", true);
    return;
  }
  var community = communityById(communityId);
  if (!community || !socket || communityId === "_dm") return;
  openPrompt({
    title: "Rename community",
    desc: "This updates the sidebar label and rail icon for everyone.",
    label1: "Name",
    value1: community.name,
    label2: "Icon (2-4 chars)",
    value2: community.abbr,
    onSave: function (name, abbr) {
      var next = (name || "").trim();
      if (!next) return;
      if (!window.confirm("Rename community to \"" + next + "\"?")) return;
      socket.emit("rename_community", {
        community_id: communityId,
        name: next,
        abbr: (abbr || community.abbr).trim(),
      });
    },
  });
}

function promptRenameChannel() {
  if (!isAdmin) {
    toast("Only admins can rename channels", true);
    return;
  }
  var ch = currentChannel();
  if (!ch || !socket || communityId === "_dm") return;
  openPrompt({
    title: "Rename channel",
    desc: "Keep it short.",
    label1: "Channel name",
    value1: ch.name,
    onSave: function (name) {
      var next = (name || "").trim();
      if (!next) return;
      if (!window.confirm("Rename channel to #" + next + "?")) return;
      socket.emit("rename_channel", {
        community_id: communityId,
        channel_id: channelId,
        name: next,
      });
    },
  });
}

function openPasswordModal() {
  document.getElementById("password-modal").classList.remove("hidden");
  document.getElementById("pw-current").value = "";
  document.getElementById("pw-new").value = "";
  document.getElementById("pw-confirm").value = "";
  setPwMsg("");
}

function closePasswordModal() {
  document.getElementById("password-modal").classList.add("hidden");
}

function applyTheme(mode) {
  themeMode = mode === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", themeMode);
  localStorage.setItem("chatwire_theme", themeMode);
  var isLight = themeMode === "light";
  var label = isLight ? "Dark mode" : "Light mode";
  var themeBtn = document.getElementById("settings-theme");
  var fab = document.getElementById("theme-fab");
  if (themeBtn) {
    themeBtn.textContent = label;
    themeBtn.setAttribute("aria-pressed", isLight ? "true" : "false");
  }
  if (fab) {
    fab.textContent = label;
    fab.setAttribute("aria-pressed", isLight ? "true" : "false");
  }
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute("content", isLight ? "#e8e2d8" : "#14110f");
  }
}

function toggleTheme() {
  applyTheme(themeMode === "light" ? "dark" : "light");
}

function syncSoundUi() {
  var btn = document.getElementById("settings-sound");
  if (!btn) return;
  btn.setAttribute("aria-pressed", soundEnabled ? "true" : "false");
  btn.textContent = soundEnabled ? "On" : "Off";
}

function setSoundEnabled(on) {
  soundEnabled = !!on;
  localStorage.setItem("chatwire_sound", soundEnabled ? "1" : "0");
  syncSoundUi();
}

function openSettingsModal() {
  syncSoundUi();
  applyTheme(themeMode);
  refreshMediaPermissionState();
  document.getElementById("settings-modal").classList.remove("hidden");
}

function closeSettingsModal() {
  document.getElementById("settings-modal").classList.add("hidden");
}

function savePassword() {
  var current = document.getElementById("pw-current").value;
  var next = document.getElementById("pw-new").value;
  var confirm = document.getElementById("pw-confirm").value;
  if (next !== confirm) {
    setPwMsg("New passwords do not match.", true);
    return;
  }
  fetch("/api/auth/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: username,
      current_password: current,
      new_password: next,
    }),
  })
    .then(function (r) {
      return r.json().then(function (d) {
        return { ok: r.ok, data: d };
      });
    })
    .then(function (res) {
      if (!res.ok) {
        setPwMsg(res.data.error || "Could not change password.", true);
        return;
      }
      if (res.data.token) sessionToken = res.data.token;
      setPwMsg("Password updated.");
      toast("Password updated");
      setTimeout(closePasswordModal, 700);
    })
    .catch(function () {
      setPwMsg("Could not reach the server.", true);
    });
}

function allChannelsFlat() {
  var rows = [];
  if (!layout) return rows;
  layout.communities.forEach(function (c) {
    c.channels.forEach(function (ch) {
      if (ch.type !== "text") return;
      rows.push({
        communityId: c.id,
        communityName: c.name,
        channelId: ch.id,
        channelName: ch.name,
        topic: ch.topic || "",
      });
    });
  });
  return rows;
}

function openSwitcher() {
  document.getElementById("switcher-modal").classList.remove("hidden");
  var input = document.getElementById("switcher-input");
  input.value = "";
  renderSwitcherResults("");
  input.focus();
}

function closeSwitcher() {
  document.getElementById("switcher-modal").classList.add("hidden");
}

function renderSwitcherResults(query) {
  var q = (query || "").toLowerCase();
  var list = document.getElementById("switcher-results");
  list.innerHTML = "";
  var matches = allChannelsFlat().filter(function (row) {
    if (!q) return true;
    return (
      row.channelName.toLowerCase().indexOf(q) >= 0 ||
      row.communityName.toLowerCase().indexOf(q) >= 0 ||
      row.topic.toLowerCase().indexOf(q) >= 0
    );
  });
  matches.slice(0, 12).forEach(function (row, idx) {
    var li = document.createElement("li");
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "switcher-item" + (idx === 0 ? " active" : "");
    btn.innerHTML =
      "<strong>#" +
      escapeHtml(row.channelName) +
      "</strong><span>" +
      escapeHtml(row.communityName) +
      "</span>";
    btn.onclick = function () {
      closeSwitcher();
      if (row.communityId !== communityId) {
        communityId = row.communityId;
        channelId = row.channelId;
        renderServerRail();
        renderChannels();
        socket.emit("join_channel", { community: communityId, channel: channelId });
      } else {
        switchChannel(row.channelId);
      }
    };
    li.appendChild(btn);
    list.appendChild(li);
  });
}

function bindSocket() {
  socket.on("connect", function () {
    setStatus(true);
    socket.emit("session_start", {
      username: username,
      token: sessionToken,
      community: communityId,
      channel: channelId,
    });
  });

  socket.on("disconnect", function () {
    setStatus(false);
    teardownCallMedia();
  });

  socket.on("auth_error", function (data) {
    setAuthMsg(data.error || "Login failed.", true);
    if (socket) socket.disconnect();
    showSetup();
  });

  socket.on("session_ready", function (data) {
    layout = data.layout;
    communityId = data.community;
    channelId = data.channel;
    username = data.username || username;
    isAdmin = !!(data && data.is_admin);
    unreadState = data.unreads || { channels: [], dms: [] };
    dmThreads = (data.dms && data.dms.threads) || [];
    updateMyName(data.user || user);
    renderServerRail();
    renderChannels();
    renderEvents(data.events || []);
    renderCall(data.call || { room: communityId + ":" + channelId, participants: [] });
    socket.emit("stories_load");
    socket.emit("list_dms");
    document.getElementById("text").focus();
  });

  socket.on("channel_switched", function (data) {
    communityId = data.community;
    channelId = data.channel;
    inCall = false;
    teardownCallMedia();
    renderServerRail();
    renderChannels();
  });

  socket.on("unreads", function (data) {
    unreadState = data || { channels: [], dms: [] };
    renderChannels();
  });

  socket.on("dms", function (data) {
    dmThreads = (data && data.threads) || [];
    renderDms();
    if (communityId === "_dm") renderChannels();
  });

  socket.on("channel_history", function (data) {
    loadChannelHistory(data.messages, data.has_more);
  });
  socket.on("older_messages", function (data) {
    prependOlderMessages((data && data.messages) || [], !!(data && data.has_more));
  });
  socket.on("presence", renderPresence);
  socket.on("events", function (data) {
    if (!data || (data.community && data.community !== communityId)) return;
    renderEvents(data.events || []);
  });
  socket.on("event_created", function () {
    toast("Event added");
  });
  socket.on("event_error", function (data) {
    toast((data && data.error) || "Could not add event", true);
  });
  socket.on("friend_added", function (data) {
    toast("Added " + ((data && data.name) || "friend"));
    document.getElementById("friend-username").value = "";
    if (socket) socket.emit("list_dms");
  });
  socket.on("friend_removed", function (data) {
    toast("Removed @" + ((data && data.username) || "friend"));
  });
  socket.on("friend_error", function (data) {
    toast((data && data.error) || "Could not update friends", true);
  });
  socket.on("channel_error", function (data) {
    toast((data && data.error) || "Channel action failed", true);
  });
  socket.on("call_updated", renderCall);
  socket.on("webrtc_signal", handleWebRtcSignal);
  socket.on("message", function (msg) {
    addMessage(msg);
  });
  socket.on("message_edited", updateMessageEdited);
  socket.on("message_reacted", updateMessageReacted);

  socket.on("layout_updated", function (data) {
    layout = data;
    renderServerRail();
    renderChannels();
  });

  socket.on("display_name_updated", function (data) {
    updateMyName(data.user);
    toast("Display name updated");
  });

  socket.on("user_renamed", function (data) {
    document.querySelectorAll(".msg-row").forEach(function (row) {
      var nameEl = row.querySelector(".msg-name");
      if (!nameEl || nameEl.textContent !== data.old_name) return;
      nameEl.textContent = data.new_name;
      row.setAttribute("data-user", data.new_name);
    });
  });

  socket.on("edit_error", function (data) {
    toast((data && data.error) || "Could not save that edit", true);
  });
  socket.on("message_error", function (data) {
    toast((data && data.error) || "Could not send that message", true);
  });
  socket.on("profile_error", function (data) {
    toast((data && data.error) || "Could not update profile", true);
  });
  socket.on("channel_error", function (data) {
    toast((data && data.error) || "Could not update channel", true);
  });
  socket.on("react_error", function (data) {
    toast((data && data.error) || "Could not save that reaction", true);
  });

  socket.on("typing", function (data) {
    var el = document.getElementById("typing-indicator");
    el.textContent = data.typing ? data.user + " is typing..." : "";
  });

  socket.on("feed", function (data) {
    feedHasMore = !!(data && data.has_more);
    document.getElementById("feed-more").classList.toggle("hidden", !feedHasMore);
    renderFeedPosts((data && data.posts) || [], !!(data && data.append));
  });
  socket.on("post_created", function (post) {
    if (!feedMode) return;
    prependFeedPost(post);
  });
  socket.on("post_updated", function (post) {
    var el = document.getElementById("feed-post-" + post.id);
    if (el) el.replaceWith(buildFeedCard(post));
  });
  socket.on("post_deleted", function (data) {
    var el = document.getElementById("feed-post-" + data.id);
    if (el) el.remove();
    if (!document.getElementById("feed-list").children.length) {
      document.getElementById("feed-empty").classList.remove("hidden");
    }
  });
  socket.on("feed_error", function (data) {
    toast((data && data.error) || "Could not update feed", true);
  });

  socket.on("stories", function (data) {
    renderStories((data && data.groups) || []);
  });
  socket.on("story_created", function () {
    toast("Story shared");
    closeStoryModal();
  });
  socket.on("story_error", function (data) {
    toast((data && data.error) || "Could not share story", true);
  });
  socket.on("status_updated", function (data) {
    myStatus = (data && data.status) || myStatus;
    myStatusText = (data && data.status_text) || "";
    renderMyStatusLabel();
    closeStatusModal();
    toast("Status updated");
  });
  socket.on("status_error", function (data) {
    toast((data && data.error) || "Could not update status", true);
  });
}

function connectChat() {
  fetch("/api/layout")
    .then(function (r) {
      return r.json();
    })
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
  return fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: usernameInput, password: password }),
  }).then(function (r) {
    return r.json().then(function (d) {
      return { ok: r.ok, data: d };
    });
  });
}

function register(usernameInput, password, displayName) {
  return fetch("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: usernameInput,
      password: password,
      display_name: displayName,
    }),
  }).then(function (r) {
    return r.json().then(function (d) {
      return { ok: r.ok, data: d };
    });
  });
}

function autosizeComposer() {
  var el = document.getElementById("text");
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 140) + "px";
}

/* Event wiring */
document.getElementById("tab-login").onclick = function () {
  document.getElementById("tab-login").classList.add("active");
  document.getElementById("tab-register").classList.remove("active");
  document.getElementById("login-form").classList.remove("hidden");
  document.getElementById("register-form").classList.add("hidden");
  setAuthMsg("");
};

document.getElementById("tab-register").onclick = function () {
  document.getElementById("tab-register").classList.add("active");
  document.getElementById("tab-login").classList.remove("active");
  document.getElementById("register-form").classList.remove("hidden");
  document.getElementById("login-form").classList.add("hidden");
  setAuthMsg("");
};

document.getElementById("login-form").onsubmit = function (e) {
  e.preventDefault();
  var u = document.getElementById("login-username").value.trim().toLowerCase();
  var p = document.getElementById("login-password").value;
  login(u, p).then(function (res) {
    if (!res.ok) {
      setAuthMsg(res.data.error || "Login failed.", true);
      return;
    }
    username = res.data.username;
    sessionToken = res.data.token || "";
    user = res.data.display_name;
    setAuthMsg("");
    connectChat();
  });
};

document.getElementById("register-form").onsubmit = function (e) {
  e.preventDefault();
  var u = document.getElementById("reg-username").value.trim().toLowerCase();
  var p = document.getElementById("reg-password").value;
  var d = document.getElementById("reg-display").value.trim();
  register(u, p, d || u).then(function (res) {
    if (!res.ok) {
      setAuthMsg(res.data.error || "Registration failed.", true);
      return;
    }
    username = res.data.username;
    sessionToken = res.data.token || "";
    user = res.data.display_name;
    setAuthMsg("Account created, joining...");
    connectChat();
  });
};

document.getElementById("rename-channel").onclick = promptRenameChannel;
document.getElementById("rename-community").onclick = function () {
  document.getElementById("community-menu").classList.add("hidden");
  promptRenameCommunity();
};
document.getElementById("open-settings").onclick = openSettingsModal;
document.getElementById("settings-close").onclick = closeSettingsModal;
document.getElementById("settings-modal").addEventListener("click", function (e) {
  if (e.target.id === "settings-modal") closeSettingsModal();
});
document.getElementById("settings-theme").onclick = toggleTheme;
document.getElementById("theme-fab").onclick = toggleTheme;
document.getElementById("settings-edit-name").onclick = function () {
  closeSettingsModal();
  promptDisplayName();
};
document.getElementById("settings-password").onclick = function () {
  closeSettingsModal();
  openPasswordModal();
};
document.getElementById("settings-status").onclick = function () {
  closeSettingsModal();
  openStatusModal();
};
document.getElementById("settings-sound").onclick = function () {
  setSoundEnabled(!soundEnabled);
  toast(soundEnabled ? "Sounds on" : "Sounds muted");
};
document.getElementById("settings-mic").onclick = function () {
  if (micPermission === "denied") {
    toast("Microphone is blocked in the browser site settings", true);
    return;
  }
  if (wantMic && micPermission === "granted") {
    wantMic = false;
    localStorage.setItem("chatwire_want_mic", "0");
    if (localStream) {
      localStream.getAudioTracks().forEach(function (t) {
        t.enabled = false;
      });
    }
    syncMediaPermissionUi();
    updateCallMediaButtons();
    toast("Microphone off for Meet now");
    return;
  }
  requestMediaPermission("mic");
};
document.getElementById("settings-cam").onclick = function () {
  if (camPermission === "denied") {
    toast("Camera is blocked in the browser site settings", true);
    return;
  }
  if (wantCam && camPermission === "granted") {
    wantCam = false;
    localStorage.setItem("chatwire_want_cam", "0");
    if (localStream) {
      localStream.getVideoTracks().forEach(function (t) {
        t.stop();
      });
    }
    syncMediaPermissionUi();
    updateCallMediaButtons();
    if (inCall) renderCallTiles(lastCallParticipants);
    toast("Camera off for Meet now");
    return;
  }
  requestMediaPermission("camera");
};
document.getElementById("pw-cancel").onclick = closePasswordModal;
document.getElementById("pw-save").onclick = savePassword;
document.getElementById("prompt-cancel").onclick = closePrompt;
document.getElementById("prompt-save").onclick = function () {
  if (promptCallback) {
    promptCallback(
      document.getElementById("prompt-input-1").value,
      document.getElementById("prompt-input-2").value
    );
  }
  closePrompt();
};

document.getElementById("community-menu-btn").onclick = function (e) {
  e.stopPropagation();
  var menu = document.getElementById("community-menu");
  var rect = e.currentTarget.getBoundingClientRect();
  menu.style.left = rect.left + "px";
  menu.style.top = rect.bottom + 6 + "px";
  menu.classList.toggle("hidden");
};

document.getElementById("open-switcher").onclick = openSwitcher;
document.getElementById("switcher-input").addEventListener("input", function (e) {
  renderSwitcherResults(e.target.value);
});
document.getElementById("switcher-modal").addEventListener("click", function (e) {
  if (e.target.id === "switcher-modal") closeSwitcher();
});

document.getElementById("toggle-members").onclick = function () {
  if (isMobileLayout()) {
    openMobilePeople();
    return;
  }
  var body = document.querySelector(".chat-body");
  var btn = document.getElementById("toggle-members");
  var collapsed = body.classList.toggle("members-collapsed");
  btn.setAttribute("aria-pressed", collapsed ? "false" : "true");
};

document.getElementById("meet-now").onclick = function () {
  if (!socket) return;
  if (inCall) {
    teardownCallMedia();
    socket.emit("call_leave");
    return;
  }
  ensureLocalMedia()
    .catch(function () {
      toast("Mic/camera unavailable — joining without media. Use Settings to allow access.", true);
    })
    .then(function () {
      socket.emit("call_join");
    });
};

var meetMobile = document.getElementById("meet-now-mobile");
if (meetMobile) {
  meetMobile.onclick = function () {
    document.getElementById("meet-now").click();
  };
}

var statusMobile = document.getElementById("status-mobile");
if (statusMobile) {
  statusMobile.onclick = function () {
    closeMobileDrawers();
    openStatusModal();
  };
}

document.getElementById("open-feed").onclick = function () {
  if (feedMode) closeFeed();
  else openFeed();
};
document.getElementById("header-feed").onclick = function () {
  openFeed();
};
document.getElementById("close-feed").onclick = closeFeed;

document.getElementById("post-form").onsubmit = function (e) {
  e.preventDefault();
  if (!socket) return;
  var text = document.getElementById("post-text").value.trim();
  var image =
    pendingPostImageUrl || document.getElementById("post-image").value.trim();
  if (!text && !image) {
    toast("Write something or add a photo", true);
    return;
  }
  socket.emit("post_create", { text: text, image_url: image });
  document.getElementById("post-text").value = "";
  document.getElementById("post-image").value = "";
  clearPostAttach();
};

document.getElementById("post-pick-photo").onclick = function () {
  document.getElementById("post-file").click();
};
document.getElementById("post-file").onchange = function (e) {
  var file = e.target.files && e.target.files[0];
  if (!file) return;
  uploadDeviceImage(file)
    .then(function (url) {
      pendingPostImageUrl = url;
      document.getElementById("post-image").value = "";
      setAttachPreview("post", url, file.name);
      toast("Photo attached");
    })
    .catch(function (err) {
      toast((err && err.message) || "Could not upload photo", true);
      clearPostAttach();
    });
};
document.getElementById("post-attach-clear").onclick = clearPostAttach;

document.getElementById("feed-more").onclick = function () {
  if (!socket || !feedHasMore || !feedOldestId) return;
  socket.emit("feed_load", { before_id: feedOldestId });
};

document.getElementById("load-older").onclick = function () {
  if (!socket || !channelHasMore || !channelOldestId) return;
  socket.emit("load_older_messages", { before_id: channelOldestId });
};

document.getElementById("call-toggle-mic").onclick = function () {
  if (!localStream || !localStream.getAudioTracks().length) {
    wantMic = true;
    localStorage.setItem("chatwire_want_mic", "1");
    ensureLocalMedia()
      .then(function () {
        renegotiateLocalTracks();
        updateCallMediaButtons();
        renderCallTiles(lastCallParticipants);
      })
      .catch(function () {
        toast("Could not enable microphone", true);
      });
    return;
  }
  var track = localStream.getAudioTracks()[0];
  track.enabled = !track.enabled;
  wantMic = track.enabled;
  localStorage.setItem("chatwire_want_mic", wantMic ? "1" : "0");
  updateCallMediaButtons();
  syncMediaPermissionUi();
};

document.getElementById("call-toggle-cam").onclick = function () {
  var track = localStream && localStream.getVideoTracks()[0];
  if (!track) {
    wantCam = true;
    localStorage.setItem("chatwire_want_cam", "1");
    ensureLocalMedia()
      .then(function () {
        renegotiateLocalTracks();
        updateCallMediaButtons();
        renderCallTiles(lastCallParticipants);
      })
      .catch(function () {
        toast("Could not enable camera", true);
      });
    return;
  }
  track.enabled = !track.enabled;
  wantCam = track.enabled;
  localStorage.setItem("chatwire_want_cam", wantCam ? "1" : "0");
  updateCallMediaButtons();
  syncMediaPermissionUi();
  renderCallTiles(lastCallParticipants);
};

document.getElementById("leave-call").onclick = function () {
  if (!socket) return;
  teardownCallMedia();
  socket.emit("call_leave");
};

document.getElementById("add-friend-form").onsubmit = function (e) {
  e.preventDefault();
  if (!socket) return;
  var input = document.getElementById("friend-username");
  var value = (input.value || "").trim();
  if (!value) return;
  socket.emit("add_friend", { username: value });
};

document.getElementById("add-event-form").onsubmit = function (e) {
  e.preventDefault();
  if (!socket) return;
  var title = document.getElementById("event-title").value.trim();
  var when = document.getElementById("event-when").value;
  var location = document.getElementById("event-location").value.trim();
  if (!title || !when) {
    toast("Add a title and time", true);
    return;
  }
  socket.emit("create_event", {
    title: title,
    starts_at: new Date(when).toISOString(),
    location: location,
  });
  document.getElementById("event-title").value = "";
  document.getElementById("event-location").value = "";
};

// status picker
document.getElementById("status-btn").onclick = openStatusModal;
document.getElementById("status-cancel").onclick = closeStatusModal;
document.querySelectorAll(".status-choice").forEach(function (btn) {
  btn.onclick = function () {
    pendingStatus = btn.getAttribute("data-status");
    document.querySelectorAll(".status-choice").forEach(function (b) {
      b.classList.toggle("active", b === btn);
    });
  };
});
document.getElementById("status-save").onclick = function () {
  if (!socket) return;
  socket.emit("set_status", {
    status: pendingStatus,
    status_text: document.getElementById("status-text-input").value.trim(),
  });
};

// stories
document.getElementById("add-story-btn").onclick = openStoryModal;
document.getElementById("story-cancel").onclick = closeStoryModal;
document.querySelectorAll(".story-bg").forEach(function (btn) {
  btn.onclick = function () {
    pendingStoryBg = btn.getAttribute("data-bg");
    document.querySelectorAll(".story-bg").forEach(function (b) {
      b.classList.toggle("active", b === btn);
    });
  };
});
document.getElementById("story-save").onclick = function () {
  if (!socket) return;
  var text = document.getElementById("story-text").value.trim();
  var image =
    pendingStoryImageUrl || document.getElementById("story-image").value.trim();
  if (!text && !image) {
    toast("Add some text or a photo", true);
    return;
  }
  socket.emit("story_create", {
    text: text,
    image_url: image,
    bg_color: pendingStoryBg,
  });
  clearStoryAttach();
};
document.getElementById("story-pick-photo").onclick = function () {
  document.getElementById("story-file").click();
};
document.getElementById("story-file").onchange = function (e) {
  var file = e.target.files && e.target.files[0];
  if (!file) return;
  uploadDeviceImage(file)
    .then(function (url) {
      pendingStoryImageUrl = url;
      document.getElementById("story-image").value = "";
      setAttachPreview("story", url, file.name);
      toast("Photo attached");
    })
    .catch(function (err) {
      toast((err && err.message) || "Could not upload photo", true);
      clearStoryAttach();
    });
};
document.getElementById("story-attach-clear").onclick = clearStoryAttach;
document.getElementById("story-viewer-close").onclick = closeStoryViewer;
document.getElementById("story-prev").onclick = function () {
  if (!storyViewerGroup) return;
  storyViewerIndex -= 1;
  if (storyViewerIndex < 0) storyViewerIndex = 0;
  showStorySlide();
};
document.getElementById("story-next").onclick = function () {
  if (!storyViewerGroup) return;
  storyViewerIndex += 1;
  showStorySlide();
};

document.getElementById("message-search").addEventListener("input", applySearchFilter);

document.getElementById("emoji-toggle").onclick = function () {
  reactionTargetId = null;
  document.getElementById("emoji-panel").classList.toggle("hidden");
};

document.getElementById("attach-photo").onclick = function () {
  document.getElementById("chat-file").click();
};
document.getElementById("chat-file").onchange = function (e) {
  var file = e.target.files && e.target.files[0];
  if (!file) return;
  uploadDeviceImage(file)
    .then(function (url) {
      pendingChatImageUrl = url;
      setAttachPreview("chat", url, file.name);
      toast("Photo ready to send");
    })
    .catch(function (err) {
      toast((err && err.message) || "Could not upload photo", true);
      clearChatAttach();
    });
};
document.getElementById("chat-attach-clear").onclick = clearChatAttach;

document.getElementById("emoji-panel").onclick = function (e) {
  var btn = e.target.closest("button[data-emoji]");
  if (!btn) return;
  var emoji = btn.getAttribute("data-emoji");
  if (reactionTargetId && socket) {
    socket.emit("react_message", { id: reactionTargetId, emoji: emoji });
  } else {
    var input = document.getElementById("text");
    input.value += emoji;
    autosizeComposer();
    input.focus();
  }
  reactionTargetId = null;
  document.getElementById("emoji-panel").classList.add("hidden");
};

document.getElementById("form").onsubmit = function (e) {
  e.preventDefault();
  var input = document.getElementById("text");
  var text = input.value.trim();
  if (!socket) return;
  if (!text && !pendingChatImageUrl) return;
  socket.emit("message", { text: text, image_url: pendingChatImageUrl || "" });
  socket.emit("typing", { typing: false });
  input.value = "";
  clearChatAttach();
  autosizeComposer();
};

document.getElementById("text").addEventListener("input", function () {
  autosizeComposer();
  if (!socket) return;
  socket.emit("typing", { typing: true });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(function () {
    socket.emit("typing", { typing: false });
  }, 1200);
});

document.getElementById("text").addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    document.getElementById("form").requestSubmit();
  }
});

document.addEventListener("keydown", function (e) {
  var meta = e.metaKey || e.ctrlKey;
  if (meta && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (!document.getElementById("app").classList.contains("hidden")) openSwitcher();
  }
  if (e.key === "Escape") {
    closeSwitcher();
    closePrompt();
    closePasswordModal();
    closeSettingsModal();
    closeStatusModal();
    closeStoryModal();
    closeStoryViewer();
    document.getElementById("emoji-panel").classList.add("hidden");
    document.getElementById("community-menu").classList.add("hidden");
  }
});

document.addEventListener("click", function () {
  document.getElementById("community-menu").classList.add("hidden");
});

document.getElementById("toggle-sidebar").onclick = function (e) {
  e.stopPropagation();
  if (isMobileLayout()) {
    openMobileSidebar();
    return;
  }
  document.querySelector(".sidebar").classList.toggle("open");
};

document.getElementById("channel-list").addEventListener("click", function () {
  closeMobileDrawers();
  document.querySelector(".sidebar").classList.remove("open");
});

document.getElementById("mobile-backdrop").onclick = function () {
  closeMobileDrawers();
  setMobileNav(feedMode ? "home" : "chat");
};

document.getElementById("mobile-nav-chat").onclick = function () {
  closeFeed();
  closeMobileDrawers();
  setMobileNav("chat");
};

document.getElementById("mobile-nav-home").onclick = function () {
  openFeed();
};

document.getElementById("mobile-nav-people").onclick = function () {
  openMobilePeople();
};

document.getElementById("mobile-nav-menu").onclick = function () {
  openMobileSidebar();
};

function updatePostCount() {
  var el = document.getElementById("post-count");
  var input = document.getElementById("post-text");
  if (!el || !input) return;
  var left = 280 - (input.value || "").length;
  el.textContent = String(left);
  el.classList.toggle("warn", left <= 20 && left >= 0);
  el.classList.toggle("over", left < 0);
}

var postText = document.getElementById("post-text");
if (postText) {
  postText.addEventListener("input", updatePostCount);
  updatePostCount();
}

applyTheme(themeMode);
syncSoundUi();
refreshMediaPermissionState();
