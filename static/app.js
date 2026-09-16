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
var iceReady = null;
var feedHasMore = false;
var feedOldestId = null;
var feedMode = false;
var discoverMode = false;
var clipsMode = false;
var pulseMode = false;
var youMode = false;
var exploreTab = "foryou";
var discoverHasMore = false;
var discoverOldestId = null;
var exploreAppendNext = false;
var feedTab = "following";
var quoteOfId = null;
var pendingPostMediaKind = "image";
var pendingCreateUrl = "";
var pendingCreateKind = "image";
var clipsHasMore = false;
var clipsOldestId = null;
var clipObserver = null;
var activeClipId = null;
var pulseUnread = 0;
var roomsSort = "hot";
var pendingSavePostId = null;
var youTab = "posts";
var youProfileUsername = null;
var myAvatarUrl = "";
var profileCache = null;
var channelPinsOpen = false;
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
var screenStream = null;
var sharingScreen = false;
var cameraTrackBackup = null;
var liveSessions = [];
var currentLive = null;
var iAmLiveHost = false;
var followingSet = {};
var boardsCache = [];
var selectedBoardId = null;
var friendRequestsIncoming = [];
var hasSocialExt = false;

var AVATAR_COLORS = ["#0a84ff", "#5e5ce6", "#64d2ff", "#30d158", "#ff9f0a", "#ff453a", "#bf5af2"];
var QUICK_EMOJIS = ["👍", "🔥", "😂", "❤️", "🎉", "👀", "✅", "🚀"];

function $(id) { return document.getElementById(id); }
function onClick(id, handler) { var el = $(id); if (!el) return null; el.onclick = handler; return el; }
function onSubmit(id, handler) { var el = $(id); if (!el) return null; el.onsubmit = handler; return el; }

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

function paintAvatar(el, name, avatarUrl) {
  if (!el) return;
  var url = (avatarUrl || "").trim();
  var label = name || "?";
  if (url) {
    el.style.backgroundImage = 'url("' + url.replace(/"/g, "") + '")';
    el.style.backgroundColor = "transparent";
    el.classList.add("has-photo");
    el.textContent = "";
  } else {
    el.style.backgroundImage = "";
    el.style.background = colorForName(label);
    el.classList.remove("has-photo");
    el.textContent = initials(label);
  }
}

function syncMyAvatars() {
  var label = user || username || "?";
  paintAvatar(document.getElementById("my-avatar"), label, myAvatarUrl);
  paintAvatar(document.getElementById("feed-avatar"), label, myAvatarUrl);
  if (isOwnYouProfile()) {
    paintAvatar(document.getElementById("you-avatar"), label, myAvatarUrl);
  }
}

function pickYouAvatar() {
  if (!isOwnYouProfile()) return;
  var input = document.getElementById("you-avatar-file");
  if (input) input.click();
}

function uploadYouAvatar(file) {
  if (!file || !socket) return;
  if (!String(file.type || "").startsWith("image/")) {
    toast("Choose a photo", true);
    return;
  }
  toast("Uploading…");
  uploadDeviceImage(file)
    .then(function (url) {
      socket.emit("avatar_update", { avatar_url: url });
    })
    .catch(function (err) {
      toast((err && err.message) || "Upload failed", true);
    });
}

function escapeHtml(text) {
  var div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}

var ACTION_ICONS = {
  comment:
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.75h11a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H11l-3.75 3v-3H6.5a2 2 0 0 1-2-2v-6.5a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/></svg>',
  like:
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19.25s-6.5-3.9-6.5-8.1A3.65 3.65 0 0 1 12 8.2a3.65 3.65 0 0 1 6.5 2.95c0 4.2-6.5 8.1-6.5 8.1Z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/></svg>',
  quote:
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 16.5c-1.8 0-3.25-1.5-3.25-3.4 0-2.2 1.7-4.1 4.1-5.35L10.5 9.5C9.15 10.2 8.35 11.15 8.35 12.3c.35-.15.75-.25 1.15-.25 1.35 0 2.4 1 2.4 2.35 0 1.35-1.1 2.1-2.4 2.1Zm7.5 0c-1.8 0-3.25-1.5-3.25-3.4 0-2.2 1.7-4.1 4.1-5.35L18 9.5c-1.35.7-2.15 1.65-2.15 2.8.35-.15.75-.25 1.15-.25 1.35 0 2.4 1 2.4 2.35 0 1.35-1.1 2.1-2.4 2.1Z" fill="currentColor"/></svg>',
  repost:
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 8.25h7.25a3 3 0 0 1 3 3V13.5M16.5 15.75H9.25a3 3 0 0 1-3-3V10.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="m16.25 5.75 2.5 2.5-2.5 2.5M7.75 18.25l-2.5-2.5 2.5-2.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  save:
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.75h8a1.5 1.5 0 0 1 1.5 1.5v11l-5.5-3.25L6.5 18.25v-11A1.5 1.5 0 0 1 8 5.75Z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/></svg>',
  trash:
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 8.5v9.25M12 8.5v9.25M15.5 8.5v9.25M6.5 7h11M9.25 7V5.75A1.25 1.25 0 0 1 10.5 4.5h3a1.25 1.25 0 0 1 1.25 1.25V7" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function makeIconAction(opts) {
  opts = opts || {};
  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "x-action icon-action" + (opts.className ? " " + opts.className : "");
  btn.title = opts.label || "";
  btn.setAttribute("aria-label", opts.ariaLabel || opts.label || "Action");
  var html = ACTION_ICONS[opts.icon] || "";
  if (opts.count != null && opts.count !== "") {
    html += '<span class="x-action-count">' + escapeHtml(String(opts.count)) + "</span>";
  }
  btn.innerHTML = html;
  if (opts.onclick) btn.onclick = opts.onclick;
  return btn;
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
  if (!root) return;
  var el = document.createElement("div");
  el.className = "toast" + (isError ? " error" : "");
  el.textContent = message == null ? "" : String(message);
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
  pendingPostMediaKind = "image";
  var input = document.getElementById("post-file");
  if (input) input.value = "";
  var videoInput = document.getElementById("post-video-file");
  if (videoInput) videoInput.value = "";
  setAttachPreview("post", "");
}

function clearCreateAttach() {
  pendingCreateUrl = "";
  pendingCreateKind = "image";
  var input = document.getElementById("create-file");
  if (input) input.value = "";
  setAttachPreview("create", "");
}

function isVideoUrl(url) {
  if (!url) return false;
  var clean = String(url).split("?")[0].split("#")[0].toLowerCase();
  return /\.(mp4|webm|mov)$/.test(clean);
}

function isVideoPost(post) {
  if (!post) return false;
  if (post.media_kind === "video") return true;
  return isVideoUrl(post.image_url || post.media_url || "");
}

function mediaUrlOf(post) {
  if (!post) return "";
  return post.image_url || post.media_url || "";
}

function closeWaveModes(except) {
  if (except !== "feed" && feedMode) closeFeed();
  if (except !== "discover" && except !== "explore" && discoverMode) closeDiscover();
  if (except !== "clips" && except !== "explore" && clipsMode) closeClips();
  if (except !== "pulse" && pulseMode) closePulse();
  if (except !== "you" && youMode) closeYou();
}

function clearAppModeClasses(app) {
  if (!app) return;
  app.classList.remove(
    "feed-mode",
    "home-mode",
    "discover-mode",
    "clips-mode",
    "explore-mode",
    "pulse-mode",
    "you-mode",
    "chat-mode"
  );
}

function syncPrimaryNav() {
  var home = document.getElementById("nav-home");
  var explore = document.getElementById("nav-explore");
  var chat = document.getElementById("nav-chat");
  var you = document.getElementById("nav-you");
  var onHome = !!feedMode && !discoverMode && !clipsMode;
  var onExplore = !!discoverMode || !!clipsMode;
  var onYou = !!youMode;
  var onChat = !feedMode && !discoverMode && !clipsMode && !pulseMode && !youMode;

  function setActive(el, on) {
    if (!el) return;
    el.classList.toggle("active", !!on);
    if (on) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  }

  setActive(home, onHome);
  setActive(explore, onExplore);
  setActive(chat, onChat);
  setActive(you, onYou);
}

function openChat() {
  closeWaveModes();
  closeYou();
  var app = document.getElementById("app");
  if (app) {
    clearAppModeClasses(app);
    app.classList.add("chat-mode");
  }
  closeMobileDrawers();
  setMobileNav("chat");
  syncPrimaryNav();
}

function openHome() {
  openFeed();
}

function syncExplorePanels() {
  var tab = exploreTab === "clips" ? "clips" : exploreTab === "boards" ? "boards" : "foryou";
  exploreTab = tab;
  ["foryou", "clips", "boards"].forEach(function (name) {
    var panel = document.getElementById("explore-panel-" + name);
    var btn = document.getElementById("explore-tab-" + name);
    var on = name === tab;
    if (panel) {
      panel.classList.toggle("hidden", !on);
      if (on) panel.removeAttribute("hidden");
      else panel.setAttribute("hidden", "");
    }
    if (btn) {
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    }
  });
  var masonry = document.getElementById("explore-masonry");
  if (masonry) {
    var showMasonry = tab === "foryou" || tab === "boards";
    masonry.classList.toggle("hidden", !showMasonry);
  }
  var more = document.getElementById("discover-more");
  if (more && tab !== "foryou") more.classList.add("hidden");
}

function openExplore(tab) {
  tab = tab === "clips" ? "clips" : tab === "boards" ? "boards" : "foryou";
  exploreTab = tab;
  closeWaveModes("explore");
  closeYou();
  youMode = false;

  if (tab === "clips") {
    discoverMode = false;
    clipsMode = true;
  } else {
    if (clipsMode) {
      pauseAllClipVideos();
      if (clipObserver) {
        try {
          clipObserver.disconnect();
        } catch (e) {}
        clipObserver = null;
      }
    }
    clipsMode = false;
    discoverMode = true;
  }

  var app = document.getElementById("app");
  if (app) {
    clearAppModeClasses(app);
    app.classList.add("explore-mode", "discover-mode");
    if (clipsMode) app.classList.add("clips-mode");
  }

  var view = document.getElementById("explore-view");
  if (view) {
    view.classList.remove("hidden");
    view.removeAttribute("hidden");
  }

  syncExplorePanels();
  closeMobileDrawers();
  setMobileNav("explore");
  syncPrimaryNav();

  if (tab === "clips") {
    var stage = document.getElementById("clips-stage");
    if (stage) stage.innerHTML = "";
    clipsOldestId = null;
    if (socket) socket.emit("clips_load", {});
  } else if (tab === "boards") {
    if (socket) socket.emit("boards_list");
    if (selectedBoardId) loadBoardPins(selectedBoardId);
    else {
      var gridB = document.getElementById("boards-grid");
      if (gridB) gridB.innerHTML = "";
      var emptyB = document.getElementById("discover-empty");
      if (emptyB) {
        emptyB.classList.remove("hidden");
        var title = emptyB.querySelector(".empty-title");
        var copy = emptyB.querySelector(".empty-copy");
        if (title) title.textContent = "Pick a board";
        if (copy) copy.textContent = "Saved pins show up here. Create a board or tap one above.";
      }
    }
  } else {
    selectedBoardId = null;
    discoverOldestId = null;
    var gridFy = document.getElementById("boards-grid");
    if (gridFy) gridFy.innerHTML = "";
    if (socket) {
      emitExploreLoad();
      socket.emit("boards_list");
    }
  }
}

function openCreateModal() {
  var modal = document.getElementById("create-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  var text = document.getElementById("create-text");
  if (text) text.focus();
}

function closeCreateModal() {
  var modal = document.getElementById("create-modal");
  if (modal) modal.classList.add("hidden");
  var text = document.getElementById("create-text");
  if (text) text.value = "";
  clearCreateAttach();
}

function submitCreateModal() {
  if (!socket) return;
  var textEl = document.getElementById("create-text");
  var text = textEl ? textEl.value.trim() : "";
  var url = pendingCreateUrl || "";
  var asClip = pendingCreateKind === "video" || isVideoUrl(url);
  if (!text && !url) {
    toast("Write something or add a photo/video", true);
    return;
  }
  if (asClip) {
    socket.emit("clip_create", {
      text: text,
      image_url: url,
      media_url: url,
      media_kind: "video",
    });
    toast("Clip posted");
    closeCreateModal();
    openExplore("clips");
    return;
  }
  socket.emit("post_create", { text: text, image_url: url });
  toast("Posted");
  closeCreateModal();
  if (!feedMode) openHome();
}

function isOwnYouProfile() {
  var target = (youProfileUsername || username || "").trim();
  return !target || target === (username || "");
}

function openYou(tab, targetUsername) {
  closeWaveModes("you");
  youMode = true;
  var target = (targetUsername || "").trim();
  youProfileUsername = target && target !== username ? target : null;
  if (tab) youTab = tab;
  if (!isOwnYouProfile() && youTab === "saved") youTab = "posts";
  var app = document.getElementById("app");
  if (app) {
    clearAppModeClasses(app);
    app.classList.add("you-mode");
  }
  var view = document.getElementById("you-view");
  if (view) {
    view.classList.remove("hidden");
    view.removeAttribute("hidden");
    view.classList.toggle("you-view-other", !isOwnYouProfile());
  }
  syncYouPrivacy();
  syncYouPanel();
  syncYouTabs();
  renderYouHighlights();
  if (socket) {
    var profileUser = youProfileUsername || username;
    socket.emit("profile_load", { username: profileUser });
    socket.emit("stories_load");
    if (isOwnYouProfile()) socket.emit("boards_list");
    else socket.emit("following_list");
  }
  closeMobileDrawers();
  setMobileNav("you");
  syncPrimaryNav();
}

function closeYou() {
  youMode = false;
  youProfileUsername = null;
  var app = document.getElementById("app");
  if (app) app.classList.remove("you-mode");
  var view = document.getElementById("you-view");
  if (view) {
    view.classList.add("hidden");
    view.setAttribute("hidden", "");
    view.classList.remove("you-view-other");
  }
  syncPrimaryNav();
}

function setYouChromeVisible(id, visible) {
  var el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle("hidden", !visible);
  if (visible) el.removeAttribute("hidden");
  else el.setAttribute("hidden", "");
}

function syncYouFollowButton() {
  var btn = document.getElementById("you-follow");
  if (!btn || isOwnYouProfile() || !youProfileUsername) return;
  var on = isFollowing(youProfileUsername);
  btn.textContent = on ? "Following" : "Follow";
  btn.classList.toggle("following", on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
}

function syncYouPrivacy() {
  var own = isOwnYouProfile();
  var savedTab = document.getElementById("you-tab-saved");
  var savedStat = document.getElementById("you-stat-saved");
  var savedPanel = document.getElementById("you-panel-saved");
  var avatarWrap = document.getElementById("you-avatar-wrap");
  var avatarBtn = document.getElementById("you-avatar");
  var statusEl = document.getElementById("you-status");
  [savedTab, savedStat].forEach(function (el) {
    if (!el) return;
    el.classList.toggle("hidden", !own);
    if (own) el.removeAttribute("hidden");
    else el.setAttribute("hidden", "");
  });
  if (savedPanel && !own) {
    savedPanel.classList.add("hidden");
    savedPanel.setAttribute("hidden", "");
  }
  if (avatarWrap) avatarWrap.classList.toggle("editable", own);
  if (avatarBtn) {
    avatarBtn.title = own ? "Change photo" : "";
    avatarBtn.setAttribute("aria-label", own ? "Change profile photo" : "Profile photo");
  }
  ["you-create", "you-edit-profile", "you-settings", "you-stories"].forEach(function (id) {
    setYouChromeVisible(id, own);
  });
  setYouChromeVisible("you-back", !own);
  setYouChromeVisible("you-follow", !own);
  setYouChromeVisible("you-message", !own);
  if (statusEl) {
    statusEl.classList.toggle("readonly", !own);
    statusEl.title = own ? "Change status" : "Status";
  }
  var title = document.querySelector(".you-title");
  if (title) title.textContent = own ? "You" : "Profile";
  syncYouFollowButton();
}

function syncYouPanel() {
  var av = document.getElementById("you-avatar");
  var nameEl = document.getElementById("you-display-name");
  var handleEl = document.getElementById("you-handle");
  var statusEl = document.getElementById("you-status");
  var own = isOwnYouProfile();
  var display =
    (profileCache && profileCache.display_name) ||
    (own ? user || username : youProfileUsername) ||
    "-";
  var handle = (profileCache && profileCache.username) || youProfileUsername || username || "-";
  var avatarUrl = own
    ? myAvatarUrl
    : (profileCache && profileCache.avatar_url) || "";
  paintAvatar(av, display, avatarUrl);
  if (nameEl) nameEl.textContent = display;
  if (handleEl) handleEl.textContent = "@" + handle;
  if (statusEl) {
    var st = own
      ? myStatus
      : (profileCache && profileCache.status) || "";
    var stText = own
      ? myStatusText
      : (profileCache && profileCache.status_text) || "";
    var label = st ? st.charAt(0).toUpperCase() + st.slice(1) : own ? "Available" : "";
    if (stText) label += (label ? " — " : "") + stText;
    if (own) {
      statusEl.textContent = label || "Set status";
      statusEl.classList.remove("hidden");
      statusEl.removeAttribute("hidden");
      statusEl.disabled = false;
    } else if (label) {
      statusEl.textContent = label;
      statusEl.classList.remove("hidden");
      statusEl.removeAttribute("hidden");
      statusEl.disabled = true;
    } else {
      statusEl.textContent = "";
      statusEl.classList.add("hidden");
      statusEl.disabled = true;
    }
  }
  if (profileCache) applyProfileStats(profileCache);
}

function applyProfileStats(data) {
  profileCache = data || profileCache;
  if (!profileCache) return;
  if (youMode && profileCache.username) {
    youProfileUsername = profileCache.is_self ? null : profileCache.username;
  }
  syncYouPrivacy();
  var set = function (id, n) {
    var el = document.getElementById(id);
    if (el) el.textContent = String(n != null ? n : 0);
  };
  set("you-count-posts", profileCache.posts);
  set("you-count-followers", profileCache.followers);
  set("you-count-reposts", profileCache.reposts);
  set("you-count-saved", isOwnYouProfile() ? profileCache.saved : 0);
  var nameEl = document.getElementById("you-display-name");
  var handleEl = document.getElementById("you-handle");
  var av = document.getElementById("you-avatar");
  if (nameEl && profileCache.display_name) nameEl.textContent = profileCache.display_name;
  if (handleEl && profileCache.username) handleEl.textContent = "@" + profileCache.username;
  if (av) {
    var own = isOwnYouProfile();
    if (own && profileCache.avatar_url != null) myAvatarUrl = profileCache.avatar_url || "";
    paintAvatar(
      av,
      profileCache.display_name || user || username,
      own ? myAvatarUrl : profileCache.avatar_url || ""
    );
    if (own) syncMyAvatars();
  }
  if (isOwnYouProfile() && profileCache.board_list) {
    boardsCache = profileCache.board_list;
    renderYouBoards(profileCache.board_list);
  }
}

function syncYouTabs() {
  var own = isOwnYouProfile();
  var tab =
    youTab === "saved" && own
      ? "saved"
      : youTab === "reposts"
        ? "reposts"
        : "posts";
  youTab = tab;
  ["posts", "reposts", "saved"].forEach(function (name) {
    var panel = document.getElementById("you-panel-" + name);
    var btn = document.getElementById("you-tab-" + name);
    var on = name === tab;
    if (name === "saved" && !own) on = false;
    if (panel) {
      panel.classList.toggle("hidden", !on);
      if (on) panel.removeAttribute("hidden");
      else panel.setAttribute("hidden", "");
    }
    if (btn) {
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    }
  });
  var profileUser = youProfileUsername || username;
  if (tab === "posts" && socket) socket.emit("user_posts_load", { username: profileUser });
  if (tab === "reposts" && socket) {
    socket.emit("user_posts_load", { username: profileUser, reposts: true });
  }
  if (tab === "saved" && own && socket) socket.emit("boards_list");
}

function setYouTab(tab) {
  if (tab === "saved" && !isOwnYouProfile()) return;
  youTab = tab;
  syncYouTabs();
}

function openUserProfile(targetUsername) {
  var target = (targetUsername || "").trim();
  if (!target) return;
  if (target === username) {
    openYou("posts");
    return;
  }
  openYou("posts", target);
}

function wireProfileLink(el, targetUsername, opts) {
  opts = opts || {};
  var target = (targetUsername || "").trim();
  if (!el || !target) return el;
  el.classList.add("profile-link");
  el.setAttribute("role", el.getAttribute("role") || "button");
  if (el.tagName === "BUTTON" || el.getAttribute("tabindex") == null) {
    el.tabIndex = 0;
  }
  el.title = opts.title || ("@" + target);
  var go = function (e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    openUserProfile(target);
  };
  el.onclick = go;
  el.onkeydown = function (e) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      go(e);
    }
  };
  return el;
}

function renderYouPosts(posts, opts) {
  opts = opts || {};
  var gridId = opts.reposts ? "you-reposts-grid" : "you-posts-grid";
  var emptyId = opts.reposts ? "you-reposts-empty" : "you-posts-empty";
  var grid = document.getElementById(gridId);
  var empty = document.getElementById(emptyId);
  if (!grid) return;
  grid.innerHTML = "";
  (posts || []).forEach(function (post) {
    if (!post) return;
    var card = document.createElement("article");
    card.className = "you-post-tile";
    if (opts.reposts) card.classList.add("is-repost");
    card.title = post.text || "";
    var quoted = post.quote_of && typeof post.quote_of === "object" ? post.quote_of : null;
    var media = mediaUrlOf(post) || (quoted ? mediaUrlOf(quoted) : "");
    if (opts.reposts) {
      var tag = document.createElement("span");
      tag.className = "you-post-clip";
      tag.textContent = "Repost";
      card.appendChild(tag);
    }
    if (media && !(quoted && isVideoPost(quoted)) && !isVideoPost(post)) {
      var img = document.createElement("img");
      img.src = media;
      img.alt = "";
      img.loading = "lazy";
      card.appendChild(img);
    } else if (media) {
      if (!opts.reposts) {
        var badge = document.createElement("span");
        badge.className = "you-post-clip";
        badge.textContent = "Clip";
        card.appendChild(badge);
      }
      var vid = document.createElement("video");
      vid.src = media;
      vid.muted = true;
      vid.playsInline = true;
      vid.setAttribute("playsinline", "");
      vid.preload = "metadata";
      card.appendChild(vid);
    } else {
      var text = document.createElement("p");
      var body = post.text || (quoted && quoted.text) || "Post";
      text.textContent = String(body).slice(0, 120);
      card.appendChild(text);
    }
    var counts = document.createElement("div");
    counts.className = "you-post-counts";
    var likes = post.like_count != null ? post.like_count : 0;
    var comments = post.comment_count != null ? post.comment_count : (post.comments || []).length;
    if (opts.reposts && quoted) {
      counts.textContent = "@" + (quoted.username || "user");
    } else {
      counts.textContent = likes + " likes · " + comments + " comments";
    }
    card.appendChild(counts);
    card.onclick = function () {
      openPostDetail(post, { openComments: true });
    };
    grid.appendChild(card);
  });
  if (empty) empty.classList.toggle("hidden", !!grid.children.length);
}

function openYouMediaLightbox(url, isVideo) {
  if (!url) return;
  var box = document.getElementById("you-media-lightbox");
  if (!box) {
    box = document.createElement("div");
    box.id = "you-media-lightbox";
    box.className = "you-media-lightbox hidden";
    box.innerHTML =
      '<button type="button" class="btn-header you-media-lightbox-close" id="you-media-lightbox-close">Close</button>' +
      '<div class="you-media-lightbox-body"></div>';
    document.body.appendChild(box);
    box.addEventListener("click", function (e) {
      if (e.target === box || (e.target && e.target.id === "you-media-lightbox-close")) {
        closeYouMediaLightbox();
      }
    });
  }
  var body = box.querySelector(".you-media-lightbox-body");
  body.innerHTML = "";
  if (isVideo) {
    var vid = document.createElement("video");
    vid.src = url;
    vid.controls = true;
    vid.autoplay = true;
    vid.playsInline = true;
    vid.setAttribute("playsinline", "");
    body.appendChild(vid);
  } else {
    var img = document.createElement("img");
    img.src = url;
    img.alt = "";
    body.appendChild(img);
  }
  box.classList.remove("hidden");
}

function closeYouMediaLightbox() {
  var box = document.getElementById("you-media-lightbox");
  if (!box) return;
  var body = box.querySelector(".you-media-lightbox-body");
  if (body) body.innerHTML = "";
  box.classList.add("hidden");
}

function renderYouBoards(boards) {
  var list = document.getElementById("you-boards-list");
  var empty = document.getElementById("you-saved-empty");
  if (!list) return;
  list.innerHTML = "";
  (boards || []).forEach(function (board) {
    var row = document.createElement("button");
    row.type = "button";
    row.className = "you-board-row";
    row.innerHTML =
      "<strong></strong><span class='you-board-count'></span><span class='you-board-go'>Open</span>";
    row.querySelector("strong").textContent = board.name;
    row.querySelector(".you-board-count").textContent =
      (board.pin_count != null ? board.pin_count : 0) + " pins";
    row.onclick = function () {
      selectedBoardId = board.id;
      openExplore("boards");
      loadBoardPins(board.id);
    };
    list.appendChild(row);
  });
  if (empty) empty.classList.toggle("hidden", !!list.children.length);
}

function renderYouPeople(users) {
  /* Following list removed from You — keep helper no-op for old callers. */
  return;
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

function setConnChip(state) {
  var chip = document.getElementById("conn-chip");
  if (!chip) return;
  chip.classList.remove("live", "reconnecting", "offline");
  if (state === "live") {
    chip.classList.add("live");
    chip.textContent = "Live";
  } else if (state === "reconnecting") {
    chip.classList.add("reconnecting");
    chip.textContent = "Reconnecting…";
  } else {
    chip.classList.add("offline");
    chip.textContent = "Offline";
  }
}

function setStatus(online) {
  setConnChip(online ? "live" : "reconnecting");
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
  syncYouPanel();
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
  syncMyAvatars();
  syncYouPanel();
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
  openChat();
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
      btn.className = "channel-btn dm" + (thread.channel === channelId ? " active" : "");
      var label =
        '<span class="channel-btn-label">' +
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
        '<span class="channel-btn-label">' +
        escapeHtml(ch.name) +
        "</span>";
      var n = unreadCount(communityId, ch.id);
      if (n) {
        label +=
          ' <span class="unread-badge">' +
          (n > 99 ? "99+" : String(n)) +
          "</span>";
      }
      if (findLiveForChannel(communityId, ch.id)) {
        label += ' <span class="live-badge" title="Live now">LIVE</span>';
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
  document.getElementById("channel-title").textContent = channelName;
  document.getElementById("channel-topic").textContent = topic;
  document.getElementById("text").placeholder = "Message " + channelName;
  document.getElementById("welcome-title").textContent =
    "Welcome to " + channelName;
  document.getElementById("welcome-copy").textContent = topic;
  renderDms();
  renderLiveBanner();
}

function makeMemberRow(name, isOnline, chan, extra) {
  extra = extra || {};
  var li = document.createElement("li");
  li.className = "member-row" + (isOnline ? " online" : "");
  if (extra.username) li.setAttribute("data-username", extra.username);
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
    sub.textContent = chan;
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
  var isSelf = !!(extra.username && username && extra.username === username);
  if (isSelf) {
    li.classList.add("member-row-self");
    li.setAttribute("role", "button");
    li.tabIndex = 0;
    li.title = "Change your status";
    li.onclick = function () {
      openStatusModal();
    };
    li.onkeydown = function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openStatusModal();
      }
    };
  } else if (extra.username) {
    li.classList.add("member-row-profile");
    wireProfileLink(li, extra.username, { title: "View @" + extra.username });
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
          username: row.username,
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
        username: f.username,
        status: f.status,
        status_text: f.status_text,
      });
      row.classList.add("friend-row");
      if (f.username === username) {
        row.title = "Change your status";
      } else {
        // Profile on row click; DM via dedicated control below
        wireProfileLink(row, f.username, { title: "View @" + f.username });
        var dmBtn = document.createElement("button");
        dmBtn.type = "button";
        dmBtn.className = "btn-icon small friend-dm";
        dmBtn.title = "Message " + f.name;
        dmBtn.setAttribute("aria-label", "Message " + f.name);
        dmBtn.innerHTML =
          '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 7.5h13a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H10l-3.5 2.5V16.5H5.5A1.5 1.5 0 0 1 4 15V9a1.5 1.5 0 0 1 1.5-1.5Z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/></svg>';
        dmBtn.onclick = function (e) {
          e.stopPropagation();
          openDm(f.username);
        };
        row.appendChild(dmBtn);
      }
      var removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "btn-icon small friend-remove";
      removeBtn.title = "Remove friend";
      removeBtn.setAttribute("aria-label", "Remove " + f.name + " from friends");
      removeBtn.innerHTML =
        '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="9.25" r="3.25" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M4.75 18.75c0-2.35 2.35-4.25 5.25-4.25 1.2 0 2.3.33 3.2.88M15.5 15.5h4.25" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>';
      removeBtn.onclick = function (e) {
        e.stopPropagation();
        if (!socket) return;
        if (!window.confirm("Remove " + f.name + " from friends?")) return;
        socket.emit("remove_friend", { username: f.username });
      };
      row.appendChild(removeBtn);

      var blockBtn = document.createElement("button");
      blockBtn.type = "button";
      blockBtn.className = "btn-icon small friend-block";
      blockBtn.title = "Block";
      blockBtn.setAttribute("aria-label", "Block " + f.name);
      blockBtn.innerHTML =
        '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7.25" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M7.1 16.9 16.9 7.1" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>';
      blockBtn.onclick = function (e) {
        e.stopPropagation();
        blockUser(f.username);
      };
      row.appendChild(blockBtn);

      var reportBtn = document.createElement("button");
      reportBtn.type = "button";
      reportBtn.className = "btn-icon small friend-report";
      reportBtn.title = "Report";
      reportBtn.setAttribute("aria-label", "Report " + f.name);
      reportBtn.innerHTML =
        '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.25 19.25V5.25h7.1l.9 1.6h3.5v6.9h-4.1l-.9-1.6H6.25" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      reportBtn.onclick = function (e) {
        e.stopPropagation();
        reportUser(f.username);
      };
      row.appendChild(reportBtn);

      friendsList.appendChild(row);
    });
  }

  if (data.call) {
    renderCall(data.call);
  }
}

function liveKey(community, channel) {
  return String(community || "") + ":" + String(channel || "");
}

function findLiveForChannel(community, channel) {
  var key = liveKey(community, channel);
  for (var i = 0; i < liveSessions.length; i++) {
    var live = liveSessions[i];
    if (!live || live.active === false) continue;
    var liveCommunity = live.community_id || live.community || "";
    var liveChannel = live.channel_id || live.channel || "";
    if (liveKey(liveCommunity, liveChannel) === key) return live;
  }
  return null;
}

function ensureIceServers() {
  if (iceReady) return iceReady;
  var qs = "";
  if (sessionToken && username) {
    qs =
      "?username=" +
      encodeURIComponent(username) +
      "&token=" +
      encodeURIComponent(sessionToken);
  }
  iceReady = fetch("/api/webrtc/ice" + qs)
    .then(function (res) {
      return res.json();
    })
    .then(function (data) {
      if (data && data.iceServers && data.iceServers.length) {
        ICE_SERVERS = { iceServers: data.iceServers };
      } else if (data && Array.isArray(data) && data.length) {
        ICE_SERVERS = { iceServers: data };
      }
      return ICE_SERVERS;
    })
    .catch(function () {
      ICE_SERVERS = {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
        ],
      };
      return ICE_SERVERS;
    });
  return iceReady;
}

function updateShareScreenButton() {
  var btn = document.getElementById("call-share-screen");
  if (!btn) return;
  btn.textContent = sharingScreen ? "Stop share" : "Share screen";
  btn.setAttribute("aria-pressed", sharingScreen ? "true" : "false");
  btn.disabled = !inCall;
}

function stopScreenShare(restoreCamera) {
  if (screenStream) {
    screenStream.getTracks().forEach(function (t) {
      try {
        t.stop();
      } catch (e) {}
    });
    screenStream = null;
  }
  sharingScreen = false;
  updateShareScreenButton();
  if (!restoreCamera) {
    if (cameraTrackBackup) {
      try {
        cameraTrackBackup.stop();
      } catch (e) {}
      cameraTrackBackup = null;
    }
    return;
  }
  if (cameraTrackBackup && localStream) {
    var oldVideo = localStream.getVideoTracks()[0];
    if (oldVideo) {
      try {
        localStream.removeTrack(oldVideo);
        oldVideo.stop();
      } catch (e) {}
    }
    localStream.addTrack(cameraTrackBackup);
    Object.keys(peerConnections).forEach(function (peer) {
      var pc = peerConnections[peer];
      if (!pc) return;
      var sender = pc.getSenders().find(function (s) {
        return s.track && s.track.kind === "video";
      });
      if (sender) sender.replaceTrack(cameraTrackBackup);
      else pc.addTrack(cameraTrackBackup, localStream);
    });
    cameraTrackBackup = null;
    if (inCall) renderCallTiles(lastCallParticipants);
  } else if (inCall) {
    renegotiateLocalTracks();
    renderCallTiles(lastCallParticipants);
  }
}

function startScreenShare() {
  if (!inCall) {
    toast("Join a call before sharing your screen", true);
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    toast("Screen share is not supported in this browser", true);
    return;
  }
  navigator.mediaDevices
    .getDisplayMedia({ video: true, audio: false })
    .then(function (stream) {
      var displayTrack = stream.getVideoTracks()[0];
      if (!displayTrack) {
        stream.getTracks().forEach(function (t) {
          t.stop();
        });
        toast("No screen track available", true);
        return;
      }
      if (!localStream) localStream = new MediaStream();
      var existingVideo = localStream.getVideoTracks()[0];
      if (existingVideo && !cameraTrackBackup) {
        cameraTrackBackup = existingVideo;
        try {
          localStream.removeTrack(existingVideo);
        } catch (e) {}
      }
      if (screenStream) {
        screenStream.getTracks().forEach(function (t) {
          t.stop();
        });
      }
      screenStream = stream;
      localStream.addTrack(displayTrack);
      sharingScreen = true;
      updateShareScreenButton();
      Object.keys(peerConnections).forEach(function (peer) {
        var pc = peerConnections[peer];
        if (!pc) return;
        var sender = pc.getSenders().find(function (s) {
          return s.track && s.track.kind === "video";
        });
        if (sender) sender.replaceTrack(displayTrack);
        else pc.addTrack(displayTrack, localStream);
      });
      displayTrack.onended = function () {
        stopScreenShare(true);
      };
      renderCallTiles(lastCallParticipants);
      toast("Screen sharing");
    })
    .catch(function () {
      toast("Screen share cancelled or blocked", true);
    });
}

function toggleScreenShare() {
  if (sharingScreen) stopScreenShare(true);
  else startScreenShare();
}

function renderLiveBanner() {
  var banner = document.getElementById("live-banner");
  var titleEl = document.getElementById("live-banner-title");
  var endBtn = document.getElementById("end-live");
  var joinBtn = document.getElementById("join-live");
  var goLiveBtn = document.getElementById("go-live");
  if (!banner) return;

  currentLive = findLiveForChannel(communityId, channelId);
  if (!currentLive) {
    banner.classList.add("hidden");
    iAmLiveHost = false;
    if (endBtn) endBtn.classList.add("hidden");
    if (joinBtn) joinBtn.classList.add("hidden");
    if (goLiveBtn) {
      goLiveBtn.classList.remove("hidden");
      goLiveBtn.textContent = "Go live";
    }
    return;
  }

  banner.classList.remove("hidden");
  var host = currentLive.host_username || currentLive.host || "";
  var title =
    currentLive.title ||
    (host ? "@" + host + " is live" : "Live in this channel");
  if (titleEl) titleEl.textContent = title;
  iAmLiveHost = host === username;
  if (endBtn) endBtn.classList.toggle("hidden", !iAmLiveHost);
  if (joinBtn) joinBtn.classList.toggle("hidden", iAmLiveHost || inCall);
  if (goLiveBtn) {
    goLiveBtn.classList.toggle("hidden", !!currentLive);
    goLiveBtn.textContent = iAmLiveHost ? "Live" : "Go live";
  }
}

function applyLiveList(data) {
  var list = [];
  if (Array.isArray(data)) list = data;
  else if (data && Array.isArray(data.lives)) list = data.lives;
  else if (data && Array.isArray(data.sessions)) list = data.sessions;
  liveSessions = list.filter(function (row) {
    return row && row.active !== false;
  });
  renderLiveBanner();
  renderChannels();
}

function handleLiveUpdated(data) {
  if (!data) return;
  var community = data.community_id || data.community || "";
  var channel = data.channel_id || data.channel || "";
  var key = liveKey(community, channel);
  var active = data.active !== false && data.ended !== true;
  liveSessions = liveSessions.filter(function (row) {
    var rowKey = liveKey(row.community_id || row.community, row.channel_id || row.channel);
    return rowKey !== key;
  });
  if (active) liveSessions.push(data);
  renderLiveBanner();
  renderChannels();
}

function startGoLive() {
  if (!socket) return;
  if (communityId === "_dm") {
    toast("Go live from a community channel", true);
    return;
  }
  openPrompt({
    title: "Go live",
    desc: "People in this channel can join your live call.",
    label1: "Title",
    value1: user + " is live",
    onSave: function (title) {
      if (!socket) return;
      socket.emit("live_start", { title: (title || "").trim() || user + " is live" });
    },
  });
}

function endGoLive() {
  if (!socket) return;
  socket.emit("live_end");
}

function joinLiveCall() {
  if (!socket) return;
  ensureLocalMedia()
    .catch(function () {})
    .then(function () {
      socket.emit("call_join");
      toast("Joined live");
    });
}

function renderFriendRequests(list) {
  friendRequestsIncoming = list || [];
  var ul = document.getElementById("friend-requests-list");
  var section = document.getElementById("friend-requests");
  if (!ul) return;
  ul.innerHTML = "";
  if (!friendRequestsIncoming.length) {
    ul.innerHTML = '<li class="member-row"><span class="sub">No pending requests</span></li>';
    if (section) section.classList.remove("has-requests");
    return;
  }
  if (section) section.classList.add("has-requests");
  friendRequestsIncoming.forEach(function (req) {
    var fromUser = req.username || req.from_user || req.from || "";
    var name = req.name || req.display_name || fromUser;
    var li = document.createElement("li");
    li.className = "member-row friend-request-row";
    var label = document.createElement("span");
    label.className = "member-name";
    label.textContent = name;
    if (fromUser) wireProfileLink(label, fromUser);
    var actions = document.createElement("div");
    actions.className = "friend-request-actions";
    var accept = document.createElement("button");
    accept.type = "button";
    accept.className = "btn-secondary compact";
    accept.textContent = "Accept";
    accept.onclick = function () {
      if (socket) socket.emit("friend_request_accept", { username: fromUser });
    };
    var decline = document.createElement("button");
    decline.type = "button";
    decline.className = "btn-secondary compact";
    decline.textContent = "Decline";
    decline.onclick = function () {
      if (socket) socket.emit("friend_request_decline", { username: fromUser });
    };
    actions.appendChild(accept);
    actions.appendChild(decline);
    li.appendChild(label);
    li.appendChild(actions);
    ul.appendChild(li);
  });
}

function sendFriendRequest(targetUsername) {
  if (!socket || !targetUsername) return;
  // Prefer request flow once social extensions are confirmed; otherwise
  // emit both so older deploys still work while request events are ignored.
  socket.emit("friend_request_send", { username: targetUsername });
  if (!hasSocialExt) {
    socket.emit("add_friend", { username: targetUsername });
  }
}

function blockUser(targetUsername) {
  if (!socket || !targetUsername) return;
  if (!window.confirm("Block @" + targetUsername + "?")) return;
  socket.emit("block_user", { username: targetUsername });
}

function reportUser(targetUsername) {
  if (!socket || !targetUsername) return;
  var reason = window.prompt("Why are you reporting @" + targetUsername + "?", "");
  if (reason === null) return;
  socket.emit("report_user", { username: targetUsername, reason: (reason || "").trim() });
}

function setFollowingFromList(data) {
  followingSet = {};
  var rows = [];
  if (Array.isArray(data)) rows = data;
  else if (data && Array.isArray(data.following)) rows = data.following;
  else if (data && Array.isArray(data.users)) rows = data.users;
  rows.forEach(function (row) {
    var u = typeof row === "string" ? row : row && (row.username || row.following);
    if (u) followingSet[u] = true;
  });
}

function isFollowing(userName) {
  return !!followingSet[userName];
}

function toggleFollow(userName) {
  if (!socket || !userName || userName === username) return;
  if (isFollowing(userName)) socket.emit("unfollow", { username: userName });
  else socket.emit("follow", { username: userName });
}

function openDiscover() {
  openExplore("foryou");
}

function closeDiscover() {
  discoverMode = false;
  var app = document.getElementById("app");
  if (app && !clipsMode) {
    app.classList.remove("discover-mode", "explore-mode");
  }
  var view = document.getElementById("explore-view");
  if (view && !clipsMode) {
    view.classList.add("hidden");
    view.setAttribute("hidden", "");
  }
  syncPrimaryNav();
}

function openClips() {
  openExplore("clips");
}

function closeClips() {
  clipsMode = false;
  pauseAllClipVideos();
  if (clipObserver) {
    try {
      clipObserver.disconnect();
    } catch (e) {}
    clipObserver = null;
  }
  var app = document.getElementById("app");
  if (app && !discoverMode) {
    app.classList.remove("clips-mode", "explore-mode", "discover-mode");
  } else if (app) {
    app.classList.remove("clips-mode");
  }
  var view = document.getElementById("explore-view");
  if (view && !discoverMode) {
    view.classList.add("hidden");
    view.setAttribute("hidden", "");
  }
  syncPrimaryNav();
}

function openPulse() {
  closeWaveModes("pulse");
  closeYou();
  pulseMode = true;
  var app = document.getElementById("app");
  if (app) {
    clearAppModeClasses(app);
    app.classList.add("pulse-mode");
  }
  var openBtn = document.getElementById("open-pulse");
  if (openBtn) openBtn.classList.add("active");
  closeMobileDrawers();
  setMobileNav("chat");
  syncPrimaryNav();
  var viewer = document.getElementById("pulse-viewer");
  if (viewer) viewer.classList.add("hidden");
  if (socket) socket.emit("snaps_inbox");
}

function closePulse() {
  pulseMode = false;
  var app = document.getElementById("app");
  if (app) app.classList.remove("pulse-mode");
  var btn = document.getElementById("open-pulse");
  if (btn) btn.classList.remove("active");
  var viewer = document.getElementById("pulse-viewer");
  if (viewer) viewer.classList.add("hidden");
  syncPrimaryNav();
}

function emitRoomsLoad(opts) {
  if (!socket) return;
  opts = opts || {};
  var payload = {
    community_id: communityId || "",
    sort: roomsSort || "hot",
  };
  if (opts.before_id) payload.before_id = opts.before_id;
  socket.emit("rooms_load", payload);
}

function emitExploreLoad(opts) {
  if (!socket) return;
  opts = opts || {};
  var payload = {};
  if (opts.before_id) {
    payload.before_id = opts.before_id;
    exploreAppendNext = true;
  } else {
    exploreAppendNext = false;
  }
  socket.emit("discover_feed_load", payload);
}

function explorePinPosts(posts) {
  var list = posts || [];
  var media = list.filter(function (p) {
    return !!(p && mediaUrlOf(p));
  });
  return media.length ? media : list.slice(0, 12);
}

function syncPinBoardSelect() {
  var select = document.getElementById("pin-board-id");
  if (!select || select.tagName !== "SELECT") return;
  select.innerHTML = '<option value="">Choose a board</option>';
  boardsCache.forEach(function (board) {
    var opt = document.createElement("option");
    opt.value = String(board.id);
    opt.textContent = board.name;
    select.appendChild(opt);
  });
  if (selectedBoardId) select.value = String(selectedBoardId);
}

function renderBoards(boards) {
  boardsCache = boards || [];
  syncPinBoardSelect();
  var chips = document.getElementById("boards-chips");
  if (!chips) return;
  chips.innerHTML = "";

  function addChip(label, boardId, active) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "board-chip" + (active ? " active" : "");
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", active ? "true" : "false");
    btn.textContent = label;
    btn.onclick = function () {
      selectedBoardId = boardId;
      syncPinBoardSelect();
      renderBoards(boardsCache);
      if (boardId) loadBoardPins(boardId);
      else {
        var grid = document.getElementById("boards-grid");
        if (grid) grid.innerHTML = "";
        var empty = document.getElementById("discover-empty");
        if (empty) {
          empty.classList.remove("hidden");
          var title = empty.querySelector(".empty-title");
          var copy = empty.querySelector(".empty-copy");
          if (title) title.textContent = "Pick a board";
          if (copy) copy.textContent = "Saved pins show up here. Create a board or tap one above.";
        }
      }
    };
    chips.appendChild(btn);
  }

  addChip("All", null, !selectedBoardId);
  boardsCache.forEach(function (board) {
    var label = board.name;
    if (board.pin_count != null) label += " · " + board.pin_count;
    addChip(label, board.id, String(board.id) === String(selectedBoardId));
  });
}

function loadBoardPins(boardId) {
  if (!socket || !boardId) return;
  socket.emit("board_pins_enriched", { board_id: boardId });
}

function currentSaveBoardId() {
  if (selectedBoardId) return selectedBoardId;
  if (boardsCache.length === 1) return boardsCache[0].id;
  return (document.getElementById("pin-board-id") || {}).value || null;
}

function openSaveModal(postId) {
  pendingSavePostId = postId;
  var modal = document.getElementById("save-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  renderSaveBoardList();
  if (socket) socket.emit("boards_list");
}

function closeSaveModal() {
  pendingSavePostId = null;
  var modal = document.getElementById("save-modal");
  if (modal) modal.classList.add("hidden");
}

function renderSaveBoardList() {
  var list = document.getElementById("save-board-list");
  if (!list) return;
  list.innerHTML = "";
  if (!boardsCache.length) {
    var empty = document.createElement("p");
    empty.className = "modal-desc";
    empty.textContent = "No boards yet — create one below.";
    list.appendChild(empty);
    return;
  }
  boardsCache.forEach(function (board) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "save-board-option";
    btn.innerHTML = "<strong></strong><span></span>";
    btn.querySelector("strong").textContent = board.name;
    btn.querySelector("span").textContent =
      (board.pin_count != null ? board.pin_count : 0) + " pins";
    btn.onclick = function () {
      confirmSaveToBoard(board.id, board.name);
    };
    list.appendChild(btn);
  });
}

function confirmSaveToBoard(boardId, boardName) {
  if (!socket || !pendingSavePostId || !boardId) return;
  socket.emit("board_pin", {
    board_id: Number(boardId),
    post_id: Number(pendingSavePostId),
  });
  selectedBoardId = boardId;
  toast("Saved to " + (boardName || "board"));
  closeSaveModal();
}

function savePostToBoard(postId) {
  if (!postId) return;
  if (boardsCache.length === 1) {
    pendingSavePostId = postId;
    confirmSaveToBoard(boardsCache[0].id, boardsCache[0].name);
    return;
  }
  openSaveModal(postId);
}

function removePinFromBoard(postId, boardId) {
  var bid = boardId || selectedBoardId;
  if (!socket || !postId || !bid) {
    toast("Pick a board first", true);
    return;
  }
  socket.emit("board_unpin", { board_id: Number(bid), post_id: Number(postId) });
  toast("Removed from board");
}

function renderBoardPins(data) {
  var pins = [];
  var boardId = data && data.board_id != null ? data.board_id : selectedBoardId;
  if (Array.isArray(data)) pins = data;
  else if (data && Array.isArray(data.pins)) pins = data.pins;
  else if (data && Array.isArray(data.posts)) pins = data.posts;
  var posts = pins.map(function (pin) {
    var post = pin.post || pin;
    if (post && boardId) post._board_id = boardId;
    return post;
  });
  renderRoomsMasonry(posts, false, { savedMode: true, boardId: boardId });
}

function buildRoomPinCard(post, opts) {
  opts = opts || {};
  var card = document.createElement("article");
  card.className = "board-pin-card room-pin";
  card.id = "room-pin-" + (post.id || "");

  var media = mediaUrlOf(post);
  var mediaWrap = document.createElement("div");
  mediaWrap.className = "room-pin-media";
  if (media) {
    if (isVideoPost(post)) {
      var vid = document.createElement("video");
      vid.src = media;
      vid.muted = true;
      vid.playsInline = true;
      vid.setAttribute("playsinline", "");
      vid.preload = "metadata";
      mediaWrap.appendChild(vid);
    } else {
      var img = document.createElement("img");
      img.src = media;
      img.alt = "";
      img.loading = "lazy";
      mediaWrap.appendChild(img);
    }
  } else {
    mediaWrap.classList.add("text-only");
    var blob = document.createElement("p");
    blob.className = "room-pin-blob";
    blob.textContent = (post.text || "").slice(0, 160) || "Post";
    mediaWrap.appendChild(blob);
  }
  card.appendChild(mediaWrap);

  var overlay = document.createElement("div");
  overlay.className = "room-pin-overlay";
  var action = document.createElement("button");
  action.type = "button";
  action.className = "room-pin-save";
  if (opts.savedMode) {
    action.textContent = "Remove";
    action.classList.add("room-pin-remove");
    action.onclick = function (e) {
      e.stopPropagation();
      if (post.id) removePinFromBoard(post.id, opts.boardId || post._board_id);
    };
  } else {
    action.textContent = "Save";
    action.onclick = function (e) {
      e.stopPropagation();
      if (post.id) savePostToBoard(post.id);
    };
  }
  overlay.appendChild(action);
  card.appendChild(overlay);

  if (post.text && media) {
    var caption = document.createElement("p");
    caption.className = "board-pin-text";
    caption.textContent = post.text.slice(0, 100);
    card.appendChild(caption);
  }

  var who = document.createElement("button");
  who.type = "button";
  who.className = "room-pin-meta profile-link";
  who.textContent = post.user || post.username || "";
  if (post.username) wireProfileLink(who, post.username);
  card.appendChild(who);

  if (!opts.savedMode) {
    var bar = document.createElement("div");
    bar.className = "pin-engage";
    var likeCount = post.like_count || 0;
    var commentCount =
      post.comment_count != null ? post.comment_count : (post.comments || []).length;
    function addEngage(icon, label, count, className, handler) {
      var btn = makeIconAction({
        icon: icon,
        label: label,
        count: count,
        className: className || "",
        onclick: function (e) {
          if (e && e.stopPropagation) e.stopPropagation();
          handler();
        },
      });
      btn.classList.add("pin-engage-btn");
      bar.appendChild(btn);
    }
    addEngage(
      "like",
      post.liked_by_me ? "Unlike" : "Like",
      likeCount,
      post.liked_by_me ? "liked" : "",
      function () {
        if (socket && post.id) socket.emit("post_like", { id: post.id });
      }
    );
    addEngage("comment", "Comment", commentCount, "", function () {
      openPostDetail(post, { openComments: true });
    });
    addEngage("repost", "Repost", null, "", function () {
      if (socket && post.id) {
        socket.emit("repost_post", { post_id: post.id });
        toast("Reposted");
      }
    });
    card.appendChild(bar);
  }

  card.addEventListener("click", function (e) {
    if (e.target.closest("button")) return;
    openPostDetail(post, { openComments: true });
  });
  return card;
}

function renderRoomsMasonry(posts, append, opts) {
  opts = opts || {};
  var grid = document.getElementById("boards-grid");
  var empty = document.getElementById("discover-empty");
  if (!grid) return;
  if (!append) grid.innerHTML = "";
  var pins =
    opts.savedMode || exploreTab === "boards"
      ? posts || []
      : explorePinPosts(posts);
  pins.forEach(function (post) {
    if (!post) return;
    var existing = document.getElementById("room-pin-" + post.id);
    var card = buildRoomPinCard(post, opts);
    if (existing) existing.replaceWith(card);
    else grid.appendChild(card);
  });
  if (!grid.children.length) {
    if (empty) {
      empty.classList.remove("hidden");
      var title = empty.querySelector(".empty-title");
      var copy = empty.querySelector(".empty-copy");
      if (exploreTab === "boards") {
        if (title) title.textContent = "No saved pins";
        if (copy) copy.textContent = "Save pins from For you. Tap Remove here to unsaved.";
      } else {
        if (title) title.textContent = "No pins yet";
        if (copy) {
          copy.textContent =
            "Photos and videos from people you know show up here. Save any pin to a board.";
        }
      }
    }
  } else if (empty) {
    empty.classList.add("hidden");
  }
  if (posts && posts.length) {
    discoverOldestId = posts[posts.length - 1].id;
  }
}

function renderBoardsGrid(pins) {
  var posts = (pins || []).map(function (pin) {
    return pin.post || pin;
  });
  renderRoomsMasonry(posts, false);
}

function buildDiscoverCard(post) {
  var card = document.createElement("article");
  card.className = "discover-card";
  card.id = "discover-post-" + post.id;

  var head = document.createElement("div");
  head.className = "discover-card-head";
  var av = document.createElement("button");
  av.type = "button";
  av.className = "avatar xs profile-link";
  av.style.background = colorForName(post.user || post.username);
  av.textContent = initials(post.user || post.username || "?");
  var meta = document.createElement("div");
  meta.className = "discover-card-meta";
  var name = document.createElement("button");
  name.type = "button";
  name.className = "profile-link discover-card-name";
  name.textContent = post.user || post.username || "user";
  var handle = document.createElement("button");
  handle.type = "button";
  handle.className = "sub profile-link";
  handle.textContent = "@" + (post.username || "user") + " · " + formatRelative(post.at);
  if (post.username) {
    wireProfileLink(av, post.username);
    wireProfileLink(name, post.username);
    wireProfileLink(handle, post.username);
  }
  meta.appendChild(name);
  meta.appendChild(handle);
  head.appendChild(av);
  head.appendChild(meta);

  if (post.username && post.username !== username) {
    var followBtn = document.createElement("button");
    followBtn.type = "button";
    followBtn.className = "btn-secondary compact follow-btn";
    followBtn.textContent = isFollowing(post.username) ? "Following" : "Follow";
    followBtn.onclick = function () {
      toggleFollow(post.username);
    };
    head.appendChild(followBtn);
  }
  card.appendChild(head);

  if (post.text) {
    var textEl = document.createElement("p");
    textEl.className = "discover-card-text";
    textEl.textContent = post.text;
    card.appendChild(textEl);
  }
  var discoverMedia = mediaUrlOf(post);
  if (discoverMedia) {
    if (isVideoPost(post)) {
      var video = document.createElement("video");
      video.className = "discover-card-image";
      video.src = discoverMedia;
      video.controls = true;
      video.setAttribute("playsinline", "");
      video.playsInline = true;
      card.appendChild(video);
    } else {
      var img = document.createElement("img");
      img.className = "discover-card-image";
      img.src = discoverMedia;
      img.alt = "";
      img.loading = "lazy";
      card.appendChild(img);
    }
  }

  var score = post.score != null ? post.score : post.vote_score != null ? post.vote_score : 0;
  var myVote = post.my_vote != null ? post.my_vote : post.voted || 0;
  var votes = document.createElement("div");
  votes.className = "vote-row";
  var up = document.createElement("button");
  up.type = "button";
  up.className = "vote-btn" + (myVote === 1 ? " active up" : "");
  up.textContent = "▲";
  up.title = "Upvote";
  up.onclick = function () {
    if (!socket) return;
    socket.emit("vote_post", { id: post.id, value: myVote === 1 ? 0 : 1 });
  };
  var scoreEl = document.createElement("span");
  scoreEl.className = "vote-score";
  scoreEl.textContent = String(score);
  var down = document.createElement("button");
  down.type = "button";
  down.className = "vote-btn" + (myVote === -1 ? " active down" : "");
  down.textContent = "▼";
  down.title = "Downvote";
  down.onclick = function () {
    if (!socket) return;
    socket.emit("vote_post", { id: post.id, value: myVote === -1 ? 0 : -1 });
  };
  var pinBtn = document.createElement("button");
  pinBtn.type = "button";
  pinBtn.className = "btn-secondary compact";
  pinBtn.textContent = "Pin";
  pinBtn.onclick = function () {
    savePostToBoard(post.id);
  };
  votes.appendChild(up);
  votes.appendChild(scoreEl);
  votes.appendChild(down);
  votes.appendChild(pinBtn);
  card.appendChild(votes);
  return card;
}

function renderDiscoverPosts(posts, append) {
  var list = document.getElementById("discover-list");
  var empty = document.getElementById("discover-empty");
  if (!list) return;
  if (!append) list.innerHTML = "";
  (posts || []).forEach(function (post) {
    var existing = document.getElementById("discover-post-" + post.id);
    if (existing) existing.replaceWith(buildDiscoverCard(post));
    else list.appendChild(buildDiscoverCard(post));
  });
  if (!list.children.length) {
    if (empty) empty.classList.remove("hidden");
  } else if (empty) {
    empty.classList.add("hidden");
  }
  if (posts && posts.length) {
    discoverOldestId = posts[posts.length - 1].id;
  }
}

function signOut() {
  closeSettingsModal();
  if (socket) {
    try {
      socket.disconnect();
    } catch (e) {}
    socket = null;
  }
  sessionToken = "";
  username = "";
  user = "";
  Object.keys(localStorage).forEach(function (key) {
    if (key.indexOf("chatwire_") === 0 && key.toLowerCase().indexOf("token") >= 0) {
      localStorage.removeItem(key);
    }
  });
  stopScreenShare(false);
  teardownCallMedia();
  setConnChip("offline");
  showSetup();
  toast("Signed out");
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

  renderYouHighlights();
}

function highlightLabel(story, index) {
  var raw = ((story && story.text) || "").trim();
  if (raw) return raw.split(/\s+/).slice(0, 2).join(" ").slice(0, 10);
  return "Story " + (index + 1);
}

function renderYouHighlights() {
  var row = document.getElementById("you-highlights");
  if (!row) return;
  var own = isOwnYouProfile();
  var addBtn = document.getElementById("you-stories");
  row.innerHTML = "";
  if (own) {
    if (addBtn) {
      addBtn.className = "you-highlight you-highlight-new";
      addBtn.id = "you-stories";
      addBtn.title = "New story";
      addBtn.innerHTML =
        '<span class="you-highlight-ring"><span class="you-highlight-plus">+</span></span>' +
        '<span class="you-highlight-label">New</span>';
      addBtn.onclick = function () {
        openStoryModal();
      };
      row.appendChild(addBtn);
    } else {
      var neu = document.createElement("button");
      neu.type = "button";
      neu.id = "you-stories";
      neu.className = "you-highlight you-highlight-new";
      neu.title = "New story";
      neu.innerHTML =
        '<span class="you-highlight-ring"><span class="you-highlight-plus">+</span></span>' +
        '<span class="you-highlight-label">New</span>';
      neu.onclick = function () {
        openStoryModal();
      };
      row.appendChild(neu);
    }
  }

  var target = (youProfileUsername || username || "").trim();
  var group = null;
  for (var i = 0; i < storyGroups.length; i++) {
    var g = storyGroups[i];
    if (own && g.is_me) {
      group = g;
      break;
    }
    if (!own && g.username === target) {
      group = g;
      break;
    }
  }
  var stories = (group && group.stories) || [];
  stories.forEach(function (story, idx) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "you-highlight";
    btn.title = story.text || "Story";
    var coverStyle = story.image_url
      ? 'background-image:url("' + String(story.image_url).replace(/"/g, "%22") + '")'
      : "background:" + (story.bg_color || colorForName(target || user || username));
    var coverInner = story.image_url
      ? ""
      : escapeHtml(initials((story.text || "S").slice(0, 2)));
    btn.innerHTML =
      '<span class="you-highlight-ring"><span class="you-highlight-cover" style="' +
      coverStyle +
      '">' +
      coverInner +
      "</span></span>" +
      '<span class="you-highlight-label">' +
      escapeHtml(highlightLabel(story, idx)) +
      "</span>";
    btn.onclick = function () {
      if (!group) return;
      openStoryViewer(group, idx);
    };
    row.appendChild(btn);
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

function openStoryViewer(group, startIndex) {
  storyViewerGroup = group;
  storyViewerIndex = startIndex != null ? Number(startIndex) || 0 : 0;
  document.getElementById("story-viewer").classList.remove("hidden");
  showStorySlide();
}

function deleteCurrentStory() {
  if (!socket || !storyViewerGroup || !storyViewerGroup.is_me) return;
  var stories = storyViewerGroup.stories || [];
  var story = stories[storyViewerIndex];
  if (!story || story.id == null) return;
  if (!window.confirm("Delete this highlight?")) return;
  clearTimeout(storyTimer);
  socket.emit("story_delete", { id: story.id });
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

  var delBtn = document.getElementById("story-viewer-delete");
  var canDelete = !!(storyViewerGroup && storyViewerGroup.is_me);
  if (delBtn) {
    delBtn.classList.toggle("hidden", !canDelete);
    if (canDelete) delBtn.removeAttribute("hidden");
    else delBtn.setAttribute("hidden", "");
  }

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
  closeWaveModes("feed");
  closeYou();
  feedMode = true;
  var app = document.getElementById("app");
  if (app) {
    clearAppModeClasses(app);
    app.classList.add("feed-mode", "home-mode");
  }
  var view = document.getElementById("feed-view");
  if (view) view.classList.remove("hidden");
  closeMobileDrawers();
  setMobileNav("home");
  syncPrimaryNav();
  bindWireTabs();
  var list = document.getElementById("feed-list");
  if (list) list.innerHTML = "";
  feedOldestId = null;
  syncFeedTabs();
  if (socket) {
    if (feedTab === "foryou") socket.emit("foryou_load", {});
    else socket.emit("feed_load", {});
    socket.emit("trends_load");
  }
}

function closeFeed() {
  feedMode = false;
  var app = document.getElementById("app");
  if (app) app.classList.remove("feed-mode", "home-mode");
  var view = document.getElementById("feed-view");
  if (view) view.classList.add("hidden");
  syncPrimaryNav();
}

function syncFeedTabs() {
  var following = document.getElementById("tab-following");
  var foryou = document.getElementById("tab-foryou");
  if (following) {
    following.classList.toggle("active", feedTab === "following");
    following.setAttribute("aria-selected", feedTab === "following" ? "true" : "false");
  }
  if (foryou) {
    foryou.disabled = false;
    foryou.removeAttribute("disabled");
    foryou.title = "For you";
    foryou.setAttribute("aria-disabled", "false");
    foryou.classList.toggle("active", feedTab === "foryou");
    foryou.setAttribute("aria-selected", feedTab === "foryou" ? "true" : "false");
  }
}

function setFeedTab(tab) {
  feedTab = tab === "foryou" ? "foryou" : "following";
  syncFeedTabs();
  var list = document.getElementById("feed-list");
  if (list) list.innerHTML = "";
  feedOldestId = null;
  var empty = document.getElementById("feed-empty");
  if (empty) {
    var title = empty.querySelector(".empty-title");
    var copy = empty.querySelector(".empty-copy");
    if (feedTab === "foryou") {
      if (title) title.textContent = "For you is quiet";
      if (copy) copy.textContent = "Follow people, post clips, or hang out in Rooms — ranked posts show up here.";
    } else {
      if (title) title.textContent = "Your timeline is empty";
      if (copy) copy.textContent = "Post something, or add friends to see what they share.";
    }
    empty.classList.remove("hidden");
  }
  if (!socket) {
    toast("Still connecting — try For you again in a moment", true);
    return;
  }
  if (feedTab === "foryou") socket.emit("foryou_load", {});
  else socket.emit("feed_load", {});
}

function bindWireTabs() {
  var tabs = document.querySelector(".feed-tabs");
  if (!tabs || tabs.dataset.wireTabsBound === "1") return;
  tabs.dataset.wireTabsBound = "1";
  tabs.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest(".feed-tab") : null;
    if (!btn || !tabs.contains(btn)) return;
    e.preventDefault();
    if (btn.id === "tab-foryou") setFeedTab("foryou");
    else if (btn.id === "tab-following") setFeedTab("following");
  });
  var foryou = document.getElementById("tab-foryou");
  if (foryou) {
    foryou.disabled = false;
    foryou.removeAttribute("disabled");
    foryou.title = "For you";
    foryou.setAttribute("aria-disabled", "false");
  }
}

function setQuotePost(post) {
  if (!post || post.id == null) return;
  quoteOfId = post.id;
  var clearBtn = document.getElementById("post-quote-clear");
  if (clearBtn) {
    clearBtn.classList.remove("hidden");
    clearBtn.textContent = "Quoting @" + (post.username || post.user || "post") + " ×";
  }
  var composer = document.getElementById("post-form");
  if (composer) composer.setAttribute("data-quote-of", String(post.id));
  var text = document.getElementById("post-text");
  if (text) {
    text.focus();
    text.placeholder = "Add a quote";
  }
  toast("Quoting @" + (post.username || post.user || "post"));
}

function clearQuotePost() {
  quoteOfId = null;
  var clearBtn = document.getElementById("post-quote-clear");
  if (clearBtn) {
    clearBtn.classList.add("hidden");
    clearBtn.textContent = "Clear quote";
  }
  var composer = document.getElementById("post-form");
  if (composer) composer.removeAttribute("data-quote-of");
  var text = document.getElementById("post-text");
  if (text) text.placeholder = "What's happening?";
}

function renderTrends(tags) {
  var row = document.getElementById("trends-row");
  if (!row) return;
  row.innerHTML = "";
  (tags || []).forEach(function (item) {
    var tag = typeof item === "string" ? item : item && item.tag;
    if (!tag) return;
    var count = typeof item === "object" && item && item.count != null ? item.count : null;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "trend-chip";
    btn.textContent = String(tag).replace(/^#/, "") + (count != null ? " · " + count : "");
    btn.onclick = function () {
      var needle = String(tag).replace(/^#/, "").toLowerCase();
      var list = document.getElementById("feed-list");
      if (!list) {
        toast(needle);
        return;
      }
      var cards = Array.prototype.slice.call(list.querySelectorAll(".feed-card"));
      var shown = 0;
      cards.forEach(function (card) {
        var text = (card.getAttribute("data-text") || card.textContent || "").toLowerCase();
        var match = text.indexOf("#" + needle) >= 0 || text.indexOf(needle) >= 0;
        card.classList.toggle("hidden", !match);
        if (match) shown += 1;
      });
      if (!shown) toast("No posts with " + needle + " in this view");
    };
    row.appendChild(btn);
  });
}

function pauseAllClipVideos() {
  var stage = document.getElementById("clips-stage");
  if (!stage) return;
  Array.prototype.slice.call(stage.querySelectorAll("video")).forEach(function (v) {
    try {
      v.pause();
    } catch (e) {}
  });
}

function observeClipSlides() {
  var stage = document.getElementById("clips-stage");
  if (!stage || typeof IntersectionObserver !== "function") return;
  if (clipObserver) {
    try {
      clipObserver.disconnect();
    } catch (e) {}
  }
  clipObserver = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        var video = entry.target.querySelector("video");
        if (!video) return;
        if (entry.isIntersecting && entry.intersectionRatio >= 0.55) {
          activeClipId = entry.target.getAttribute("data-clip-id");
          syncClipOverlayActions(entry.target);
          Array.prototype.slice.call(stage.querySelectorAll("video")).forEach(function (v) {
            if (v !== video) {
              try {
                v.pause();
              } catch (e) {}
            }
          });
          video.play().catch(function () {});
        } else {
          try {
            video.pause();
          } catch (e) {}
        }
      });
    },
    { root: stage, threshold: [0.55, 0.75] }
  );
  Array.prototype.slice.call(stage.querySelectorAll(".clip-slide")).forEach(function (slide) {
    clipObserver.observe(slide);
  });
}

function syncClipOverlayActions(slide) {
  if (!slide) return;
  var postId = slide.getAttribute("data-clip-id");
  var userName = slide.getAttribute("data-username") || "";
  var like = document.getElementById("clip-like");
  var up = document.getElementById("clip-vote-up");
  var down = document.getElementById("clip-vote-down");
  var follow = document.getElementById("clip-follow");
  var score = document.getElementById("clip-score");
  var save = document.getElementById("clip-save-board");
  if (score) score.textContent = slide.getAttribute("data-score") || "0";
  if (like) {
    like.onclick = function () {
      if (socket && postId) socket.emit("post_like", { id: Number(postId) });
    };
  }
  if (up) {
    up.onclick = function () {
      if (socket && postId) socket.emit("vote_post", { id: Number(postId), value: 1 });
    };
  }
  if (down) {
    down.onclick = function () {
      if (socket && postId) socket.emit("vote_post", { id: Number(postId), value: -1 });
    };
  }
  if (follow) {
    follow.textContent = isFollowing(userName) ? "Following" : "Follow";
    follow.onclick = function () {
      if (userName) toggleFollow(userName);
    };
  }
  if (save) {
    save.onclick = function () {
      if (postId) savePostToBoard(postId);
    };
  }
}

function buildClipSlide(post) {
  var slide = document.createElement("article");
  slide.className = "clip-slide";
  slide.setAttribute("data-clip-id", String(post.id));
  slide.setAttribute("data-username", post.username || "");
  var score = post.score != null ? post.score : post.vote_score != null ? post.vote_score : post.like_count || 0;
  slide.setAttribute("data-score", String(score));

  var media = mediaUrlOf(post);
  if (media) {
    var video = document.createElement("video");
    video.src = media;
    video.controls = true;
    video.loop = true;
    video.setAttribute("playsinline", "");
    video.playsInline = true;
    video.setAttribute("preload", "metadata");
    slide.appendChild(video);
  }

  var meta = document.createElement("div");
  meta.className = "clip-meta";

  if (post.text) {
    var cap = document.createElement("p");
    cap.className = "clip-caption";
    cap.textContent = post.text;
    meta.appendChild(cap);
  }

  var authorRow = document.createElement("div");
  authorRow.className = "clip-author-row";
  var author = document.createElement("button");
  author.type = "button";
  author.className = "clip-author profile-link";
  author.textContent = "@" + (post.username || "user");
  if (post.username) wireProfileLink(author, post.username);
  authorRow.appendChild(author);
  if (post.user && post.user !== post.username) {
    var display = document.createElement("button");
    display.type = "button";
    display.className = "clip-display profile-link";
    display.textContent = post.user;
    if (post.username) wireProfileLink(display, post.username);
    authorRow.appendChild(display);
  }
  meta.appendChild(authorRow);
  slide.appendChild(meta);

  var actions = document.createElement("div");
  actions.className = "clip-actions";
  var likeBtn = document.createElement("button");
  likeBtn.type = "button";
  likeBtn.className = "clip-action-btn";
  likeBtn.textContent = post.liked_by_me ? "Liked" : "Like";
  likeBtn.onclick = function () {
    if (socket) socket.emit("post_like", { id: post.id });
  };
  var upBtn = document.createElement("button");
  upBtn.type = "button";
  upBtn.className = "clip-action-btn";
  upBtn.textContent = "▲";
  upBtn.onclick = function () {
    if (socket) socket.emit("vote_post", { id: post.id, value: 1 });
  };
  var downBtn = document.createElement("button");
  downBtn.type = "button";
  downBtn.className = "clip-action-btn";
  downBtn.textContent = "▼";
  downBtn.onclick = function () {
    if (socket) socket.emit("vote_post", { id: post.id, value: -1 });
  };
  actions.appendChild(likeBtn);
  actions.appendChild(upBtn);
  actions.appendChild(downBtn);
  if (post.username && post.username !== username) {
    var followBtn = document.createElement("button");
    followBtn.type = "button";
    followBtn.className = "clip-action-btn";
    followBtn.textContent = isFollowing(post.username) ? "Following" : "Follow";
    followBtn.onclick = function () {
      toggleFollow(post.username);
    };
    actions.appendChild(followBtn);
  }
  slide.appendChild(actions);
  return slide;
}

function renderClipsFeed(posts, append) {
  var stage = document.getElementById("clips-stage");
  var empty = document.getElementById("clips-empty");
  if (!stage) return;
  if (!append) stage.innerHTML = "";
  (posts || []).forEach(function (post) {
    var existing = stage.querySelector('[data-clip-id="' + post.id + '"]');
    if (existing) existing.replaceWith(buildClipSlide(post));
    else stage.appendChild(buildClipSlide(post));
  });
  if (!stage.children.length) {
    if (empty) empty.classList.remove("hidden");
  } else if (empty) {
    empty.classList.add("hidden");
  }
  if (posts && posts.length) {
    clipsOldestId = posts[posts.length - 1].id;
  }
  observeClipSlides();
}

function renderPulseInbox(snaps) {
  var inbox = document.getElementById("pulse-inbox");
  if (!inbox) return;
  inbox.innerHTML = "";
  var rows = snaps || [];
  if (!rows.length) {
    inbox.innerHTML = '<p class="discover-sub">No snaps yet</p>';
    updatePulseBadge();
    return;
  }
  rows.forEach(function (snap) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pulse-snap-row" + (snap.opened_at ? " opened" : "");
    btn.innerHTML =
      "<strong>" +
      escapeHtml(snap.from_user || snap.from || "someone") +
      "</strong><span>" +
      escapeHtml((snap.text || "Snap").slice(0, 60)) +
      "</span>";
    btn.onclick = function () {
      if (socket) socket.emit("snap_open", { snap_id: snap.id });
    };
    inbox.appendChild(btn);
  });
  pulseUnread = rows.filter(function (s) {
    return !s.opened_at;
  }).length;
  updatePulseBadge();
}

function updatePulseBadge() {
  var btn = document.getElementById("open-pulse");
  if (btn) {
    btn.setAttribute("data-badge", pulseUnread > 0 ? String(pulseUnread) : "");
    btn.title =
      pulseUnread > 0 ? "Pulse — " + pulseUnread + " new snaps" : "Pulse — snaps";
  }
  var mobile = document.querySelector('.mobile-nav-btn[data-mobile="pulse"]');
  if (mobile) mobile.classList.toggle("has-badge", pulseUnread > 0);
}

function showPulseViewer(snap) {
  var viewer = document.getElementById("pulse-viewer");
  if (!viewer || !snap) return;
  viewer.innerHTML = "";
  viewer.classList.remove("hidden");
  var head = document.createElement("div");
  head.className = "pulse-viewer-head";
  head.textContent = "From @" + (snap.from_user || snap.from || "someone");
  viewer.appendChild(head);
  if (snap.media_url || snap.image_url) {
    var url = snap.media_url || snap.image_url;
    if (isVideoUrl(url)) {
      var video = document.createElement("video");
      video.src = url;
      video.controls = true;
      video.setAttribute("playsinline", "");
      video.playsInline = true;
      video.autoplay = true;
      viewer.appendChild(video);
    } else {
      var img = document.createElement("img");
      img.src = url;
      img.alt = "";
      viewer.appendChild(img);
    }
  }
  if (snap.text) {
    var text = document.createElement("p");
    text.textContent = snap.text;
    viewer.appendChild(text);
  }
  var close = document.createElement("button");
  close.type = "button";
  close.className = "btn-header";
  close.textContent = "Close";
  close.onclick = function () {
    viewer.classList.add("hidden");
    viewer.innerHTML = "";
  };
  viewer.appendChild(close);
}

function renderChannelPins(pins) {
  var panel = document.getElementById("channel-pins-panel");
  if (!panel) return;
  panel.innerHTML = "";
  var rows = [];
  if (Array.isArray(pins)) rows = pins;
  else if (pins && Array.isArray(pins.pins)) rows = pins.pins;
  else if (pins && Array.isArray(pins.messages)) rows = pins.messages;
  if (!rows.length) {
    panel.innerHTML = '<p class="sub">No pins in this channel</p>';
    return;
  }
  rows.forEach(function (pin) {
    var msg = pin.message || pin;
    var row = document.createElement("div");
    row.className = "channel-pin-row";
    row.innerHTML =
      "<strong>" +
      escapeHtml(msg.user || msg.username || "user") +
      "</strong> " +
      escapeHtml((msg.text || "").slice(0, 120) || "Pinned message");
    var unpin = document.createElement("button");
    unpin.type = "button";
    unpin.className = "btn-secondary compact";
    unpin.textContent = "Unpin";
    unpin.onclick = function () {
      if (socket) socket.emit("channel_unpin", { message_id: msg.id || pin.message_id });
    };
    row.appendChild(unpin);
    panel.appendChild(row);
  });
}

function toggleChannelPinsPanel() {
  var panel = document.getElementById("channel-pins-panel");
  var btn = document.getElementById("channel-pins-btn");
  if (!panel) return;
  channelPinsOpen = !channelPinsOpen;
  panel.classList.toggle("hidden", !channelPinsOpen);
  if (btn) btn.setAttribute("aria-expanded", channelPinsOpen ? "true" : "false");
  if (channelPinsOpen && socket) socket.emit("channel_pins_list", {});
}

function attachPostVideo(file) {
  if (!file) return;
  uploadDeviceImage(file)
    .then(function (url) {
      pendingPostImageUrl = url;
      pendingPostMediaKind = "video";
      var imageField = document.getElementById("post-image");
      if (imageField) imageField.value = "";
      setAttachPreview("post", url, file.name || "Video");
      toast("Video attached");
    })
    .catch(function (err) {
      toast((err && err.message) || "Video upload not available — paste a URL", true);
      var imageField = document.getElementById("post-image");
      if (imageField) imageField.focus();
    });
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
  openChat();
  closeMobileDrawers();
  document.querySelector(".sidebar").classList.add("open");
  var backdrop = document.getElementById("mobile-backdrop");
  backdrop.classList.remove("hidden");
  backdrop.classList.add("show");
  setMobileNav("chat");
}

function openMobilePeople() {
  openChat();
  closeMobileDrawers();
  document.getElementById("members-panel").classList.add("open");
  var backdrop = document.getElementById("mobile-backdrop");
  backdrop.classList.remove("hidden");
  backdrop.classList.add("show");
  setMobileNav("chat");
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

function buildFeedCard(post, opts) {
  opts = opts || {};
  // X/Twitter style row: avatar | name @handle · time + body + actions
  var card = document.createElement("article");
  card.className = "feed-card x-post";
  card.id = "feed-post-" + post.id;
  card.setAttribute("data-text", post.text || "");

  var av = document.createElement("button");
  av.type = "button";
  av.className = "x-post-avatar";
  av.style.background = colorForName(post.user);
  av.textContent = initials(post.user);
  av.title = "@" + (post.username || "user");
  av.setAttribute("aria-label", "Open @" + (post.username || "user"));
  if (post.username) {
    av.onclick = function (e) {
      e.stopPropagation();
      openUserProfile(post.username);
    };
  }

  var body = document.createElement("div");
  body.className = "x-post-body";

  var line = document.createElement("div");
  line.className = "x-post-line";
  var name = document.createElement("button");
  name.type = "button";
  name.className = "x-post-name";
  name.textContent = post.user;
  var handle = document.createElement("button");
  handle.type = "button";
  handle.className = "x-post-handle";
  handle.textContent = "@" + (post.username || "user");
  if (post.username) {
    name.onclick = function (e) {
      e.stopPropagation();
      openUserProfile(post.username);
    };
    handle.onclick = function (e) {
      e.stopPropagation();
      openUserProfile(post.username);
    };
  }
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

  var quoted = post.quoted || post.quote_of_post || null;
  if (!quoted && post.quote_of && typeof post.quote_of === "object") quoted = post.quote_of;
  if (quoted && (quoted.text || quoted.user || quoted.username || mediaUrlOf(quoted))) {
    var embed = document.createElement("div");
    embed.className = "quote-embed";
    var qHead = document.createElement("button");
    qHead.type = "button";
    qHead.className = "quote-embed-head profile-link";
    qHead.textContent =
      "@" + (quoted.username || "user") + (quoted.user ? " · " + quoted.user : "");
    if (quoted.username) wireProfileLink(qHead, quoted.username);
    embed.appendChild(qHead);
    if (quoted.text) {
      var qText = document.createElement("p");
      qText.textContent = quoted.text;
      embed.appendChild(qText);
    }
    var qMedia = mediaUrlOf(quoted);
    if (qMedia) {
      if (isVideoPost(quoted)) {
        var qVid = document.createElement("video");
        qVid.className = "x-post-image";
        qVid.src = qMedia;
        qVid.controls = true;
        qVid.setAttribute("playsinline", "");
        qVid.playsInline = true;
        embed.appendChild(qVid);
      } else {
        var qImg = document.createElement("img");
        qImg.className = "x-post-image";
        qImg.src = qMedia;
        qImg.alt = "";
        qImg.loading = "lazy";
        embed.appendChild(qImg);
      }
    }
    body.appendChild(embed);
  }

  var media = mediaUrlOf(post);
  if (media) {
    if (isVideoPost(post)) {
      var video = document.createElement("video");
      video.className = "x-post-image x-post-video";
      video.src = media;
      video.controls = true;
      video.setAttribute("playsinline", "");
      video.playsInline = true;
      video.onerror = function () {
        video.remove();
      };
      body.appendChild(video);
    } else {
      var img = document.createElement("img");
      img.className = "x-post-image";
      img.src = media;
      img.alt = "Post image";
      img.loading = "lazy";
      img.onerror = function () {
        img.remove();
      };
      body.appendChild(img);
    }
  }

  var actions = document.createElement("div");
  actions.className = "x-post-actions";

  var commentCount =
    post.comment_count != null ? post.comment_count : (post.comments || []).length;
  var replyBtn = makeIconAction({
    icon: "comment",
    label: "Comment",
    count: commentCount,
    onclick: null,
  });
  actions.appendChild(replyBtn);

  var likeBtn = makeIconAction({
    icon: "like",
    label: post.liked_by_me ? "Unlike" : "Like",
    count: post.like_count || 0,
    className: post.liked_by_me ? "liked" : "",
    onclick: function () {
      if (socket) socket.emit("post_like", { id: post.id });
    },
  });
  actions.appendChild(likeBtn);

  var quoteBtn = makeIconAction({
    icon: "quote",
    label: "Quote",
    className: "quote-btn",
    onclick: function () {
      closePostDetail();
      if (!feedMode) openFeed();
      setQuotePost(post);
    },
  });
  actions.appendChild(quoteBtn);

  var repostBtn = makeIconAction({
    icon: "repost",
    label: "Repost",
    className: "repost-btn",
    onclick: function () {
      if (!socket || !post.id) return;
      socket.emit("repost_post", { post_id: post.id });
      toast("Reposted");
    },
  });
  actions.appendChild(repostBtn);

  var saveBtn = makeIconAction({
    icon: "save",
    label: "Save",
    onclick: function () {
      if (post.id) savePostToBoard(post.id);
    },
  });
  actions.appendChild(saveBtn);

  if (post.username === username) {
    var del = makeIconAction({
      icon: "trash",
      label: "Delete",
      className: "danger",
      onclick: function () {
        if (socket) socket.emit("post_delete", { id: post.id });
      },
    });
    actions.appendChild(del);
  }

  body.appendChild(actions);

  var commentsWrap = document.createElement("div");
  commentsWrap.className = "x-comments";
  if (!opts.openComments) commentsWrap.classList.add("collapsed");
  (post.comments || []).forEach(function (c) {
    var row = document.createElement("div");
    row.className = "feed-comment";
    if (c.parent_id) row.classList.add("feed-comment-reply");
    var who = document.createElement("button");
    who.type = "button";
    who.className = "feed-comment-who profile-link";
    who.textContent = c.user;
    if (c.username) wireProfileLink(who, c.username);
    row.appendChild(who);
    row.appendChild(document.createTextNode(" " + (c.text || "")));
    if (c.id != null) {
      var cReply = document.createElement("button");
      cReply.type = "button";
      cReply.className = "comment-reply-btn";
      cReply.textContent = "Reply";
      cReply.onclick = function () {
        commentsWrap.classList.remove("collapsed");
        input.placeholder = "Reply to " + (c.user || "comment");
        input.dataset.parentId = String(c.id);
        input.focus();
      };
      row.appendChild(cReply);
    }
    commentsWrap.appendChild(row);
  });

  var form = document.createElement("form");
  form.className = "feed-comment-form";
  var input = document.createElement("input");
  input.type = "text";
  input.maxLength = 500;
  input.placeholder = "Write a comment…";
  var send = document.createElement("button");
  send.type = "submit";
  send.className = "btn-media-icon feed-comment-send";
  send.title = "Post";
  send.setAttribute("aria-label", "Post comment");
  send.innerHTML =
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 12h13M12.5 6.5 18.5 12l-6 5.5" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  form.appendChild(input);
  form.appendChild(send);
  form.onsubmit = function (e) {
    e.preventDefault();
    var value = input.value.trim();
    if (!value || !socket) return;
    var parentId = input.dataset.parentId ? Number(input.dataset.parentId) : null;
    if (parentId) {
      socket.emit("comment_reply", { post_id: post.id, text: value, parent_id: parentId });
    } else {
      socket.emit("post_comment", { id: post.id, text: value });
    }
    input.value = "";
    delete input.dataset.parentId;
    input.placeholder = "Write a comment…";
  };
  commentsWrap.appendChild(form);
  body.appendChild(commentsWrap);

  replyBtn.onclick = function () {
    commentsWrap.classList.toggle("collapsed");
    if (!commentsWrap.classList.contains("collapsed")) input.focus();
  };

  card.appendChild(av);
  card.appendChild(body);
  return card;
}

function openPostDetail(post, opts) {
  opts = opts || {};
  var modal = document.getElementById("post-detail-modal");
  var body = document.getElementById("post-detail-body");
  if (!modal || !body || !post) return;
  body.innerHTML = "";
  var card = buildFeedCard(post, { openComments: opts.openComments !== false });
  card.id = "post-detail-" + post.id;
  body.appendChild(card);
  modal.classList.remove("hidden");
}

function closePostDetail() {
  var modal = document.getElementById("post-detail-modal");
  var body = document.getElementById("post-detail-body");
  if (body) body.innerHTML = "";
  if (modal) modal.classList.add("hidden");
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
    updateShareScreenButton();
    renderCallTiles(people);
  } else if (wasInCall) {
    teardownCallMedia();
  } else {
    hideCallStage();
  }
  renderLiveBanner();
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
  stopScreenShare(false);
  if (!localStream) return;
  localStream.getTracks().forEach(function (track) {
    track.stop();
  });
  localStream = null;
}

function teardownCallMedia() {
  stopScreenShare(false);
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
  updateShareScreenButton();
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
  ensureIceServers().then(function () {
    syncCallPeersReady(people);
  });
}

function syncCallPeersReady(people) {
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

  var avatar = document.createElement(msg.username ? "button" : "div");
  if (msg.username) avatar.type = "button";
  avatar.className = "avatar xs" + (msg.username ? " profile-link" : "");
  avatar.style.background = colorForName(msg.user);
  avatar.textContent = initials(msg.user);
  if (msg.username && !msg.system) {
    wireProfileLink(avatar, msg.username, { title: "View @" + msg.username });
  }

  var body = document.createElement("div");
  body.className = "msg-body";

  var head = document.createElement("div");
  head.className = "msg-head";
  var name = document.createElement(msg.username && !msg.system ? "button" : "span");
  if (msg.username && !msg.system) name.type = "button";
  name.className = "msg-name" + (msg.username && !msg.system ? " profile-link" : "");
  name.textContent = msg.user;
  if (msg.username && !msg.system) {
    wireProfileLink(name, msg.username, { title: "View @" + msg.username });
  }
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
  var pinMsgBtn = document.createElement("button");
  pinMsgBtn.type = "button";
  pinMsgBtn.className = "msg-action-btn pin-msg-btn";
  pinMsgBtn.textContent = "Pin";
  pinMsgBtn.title = "Pin message";
  pinMsgBtn.onclick = function () {
    if (socket) socket.emit("channel_pin", { message_id: msg.id });
  };
  actions.appendChild(pinMsgBtn);
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
  // Land on Home immediately (data refresh happens on session_ready)
  feedMode = true;
  youMode = false;
  discoverMode = false;
  clipsMode = false;
  pulseMode = false;
  var app = document.getElementById("app");
  if (app) {
    clearAppModeClasses(app);
    app.classList.add("feed-mode", "home-mode");
  }
  var view = document.getElementById("feed-view");
  if (view) view.classList.remove("hidden");
  setMobileNav("home");
  syncPrimaryNav();
}

function showSetup() {
  document.getElementById("setup").classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");
  closeWaveModes();
  clearLog();
  setStatus(false);
  setConnChip("offline");
}

function switchCommunity(id) {
  openChat();
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
  openChat();
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
  if (themeBtn) {
    themeBtn.textContent = label;
    themeBtn.setAttribute("aria-pressed", isLight ? "true" : "false");
  }
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute("content", isLight ? "#f2f3f7" : "#050507");
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

function openEditProfileModal() {
  if (!isOwnYouProfile()) return;
  var nameInput = document.getElementById("edit-profile-name");
  if (nameInput) nameInput.value = user || "";
  paintAvatar(
    document.getElementById("edit-profile-avatar-face"),
    user || username || "?",
    myAvatarUrl
  );
  var modal = document.getElementById("edit-profile-modal");
  if (modal) modal.classList.remove("hidden");
  if (nameInput) nameInput.focus();
}

function closeEditProfileModal() {
  var modal = document.getElementById("edit-profile-modal");
  if (modal) modal.classList.add("hidden");
}

function saveEditProfile() {
  var nameInput = document.getElementById("edit-profile-name");
  var next = nameInput ? (nameInput.value || "").trim().slice(0, 32) : "";
  if (next && socket && next !== user) {
    socket.emit("update_display_name", { user: next });
  }
  closeEditProfileModal();
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
      "<strong>" +
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
    setConnChip("live");
    socket.emit("session_start", {
      username: username,
      token: sessionToken,
      community: communityId,
      channel: channelId,
    });
  });

  socket.on("disconnect", function () {
    setStatus(false);
    setConnChip("reconnecting");
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
    myAvatarUrl = (data && data.avatar_url) || "";
    unreadState = data.unreads || { channels: [], dms: [] };
    dmThreads = (data.dms && data.dms.threads) || [];
    updateMyName(data.user || user);
    renderServerRail();
    renderChannels();
    renderEvents(data.events || []);
    renderCall(data.call || { room: communityId + ":" + channelId, participants: [] });
    socket.emit("stories_load");
    socket.emit("list_dms");
    socket.emit("friend_requests_list");
    socket.emit("live_list");
    socket.emit("following_list");
    document.getElementById("text").focus();
    openHome();
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
    if (socket) {
      socket.emit("list_dms");
      socket.emit("friend_requests_list");
    }
  });
  socket.on("friend_removed", function (data) {
    toast("Removed @" + ((data && data.username) || "friend"));
  });
  socket.on("friend_error", function (data) {
    toast((data && data.error) || "Could not update friends", true);
  });
  socket.on("friend_requests", function (data) {
    hasSocialExt = true;
    var incoming = [];
    if (Array.isArray(data)) incoming = data;
    else if (data && Array.isArray(data.incoming)) incoming = data.incoming;
    else if (data && Array.isArray(data.requests)) incoming = data.requests;
    renderFriendRequests(incoming);
  });
  socket.on("friend_request", function (data) {
    hasSocialExt = true;
    toast("Friend request from @" + ((data && (data.username || data.from_user)) || "someone"));
    if (socket) socket.emit("friend_requests_list");
  });
  socket.on("blocked", function (data) {
    toast("Blocked @" + ((data && data.username) || "user"));
  });
  socket.on("unblocked", function (data) {
    toast("Unblocked @" + ((data && data.username) || "user"));
  });
  socket.on("report_ok", function () {
    toast("Report submitted");
  });
  socket.on("following", function (data) {
    setFollowingFromList(data);
    var users = [];
    if (Array.isArray(data)) users = data;
    else if (data && Array.isArray(data.users)) users = data.users;
    else if (data && Array.isArray(data.following)) users = data.following;
    if (youMode) {
      renderYouPeople(users);
      syncYouFollowButton();
    }
    if (discoverMode) {
      if (socket) socket.emit("discover_feed_load", {});
    }
  });
  socket.on("followers", function (data) {
    var users = [];
    if (Array.isArray(data)) users = data;
    else if (data && Array.isArray(data.users)) users = data.users;
    if (profileCache) {
      profileCache.followers = users.length;
      applyProfileStats(profileCache);
    }
  });
  socket.on("profile", function (data) {
    applyProfileStats(data || {});
    if (youMode) syncYouPanel();
  });
  socket.on("user_posts", function (data) {
    var reposts = !!(data && (data.quotes_only || data.reposts));
    renderYouPosts((data && data.posts) || [], { reposts: reposts });
  });
  socket.on("repost_created", function () {
    if (youMode && youTab === "reposts" && socket) {
      socket.emit("user_posts_load", {
        username: youProfileUsername || username,
        reposts: true,
      });
    }
    if (socket && isOwnYouProfile()) socket.emit("profile_load", {});
  });
  socket.on("discover_feed", function (data) {
    hasSocialExt = true;
    discoverHasMore = !!(data && data.has_more);
    var more = document.getElementById("discover-more");
    if (more) {
      more.classList.toggle(
        "hidden",
        !discoverHasMore || !!selectedBoardId || exploreTab !== "foryou"
      );
    }
    if (discoverMode && exploreTab === "foryou" && !selectedBoardId) {
      var append = exploreAppendNext;
      exploreAppendNext = false;
      renderRoomsMasonry((data && data.posts) || [], append);
      return;
    }
    if (discoverMode) return;
    renderDiscoverPosts((data && data.posts) || [], !!(data && data.append));
  });
  socket.on("post_voted", function (post) {
    if (!post || post.id == null) return;
    var el = document.getElementById("discover-post-" + post.id);
    if (el) el.replaceWith(buildDiscoverCard(post));
  });
  socket.on("boards", function (data) {
    hasSocialExt = true;
    var boards = [];
    if (Array.isArray(data)) boards = data;
    else if (data && Array.isArray(data.boards)) boards = data.boards;
    renderBoards(boards);
    renderYouBoards(boards);
    renderSaveBoardList();
    if (data && data.created && pendingSavePostId) {
      confirmSaveToBoard(data.created.id, data.created.name);
    }
  });
  socket.on("board_pins", function (data) {
    if (data && data.board_id != null) selectedBoardId = data.board_id;
    renderBoardPins(data);
  });
  socket.on("live_list", function (data) {
    hasSocialExt = true;
    applyLiveList(data);
  });
  socket.on("live_updated", function (data) {
    hasSocialExt = true;
    handleLiveUpdated(data);
  });
  socket.on("discover_error", function (data) {
    toast((data && data.error) || "Discover action failed", true);
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
  socket.on("avatar_updated", function (data) {
    if (!data) return;
    if (data.username && data.username !== username) return;
    myAvatarUrl = data.avatar_url || "";
    syncMyAvatars();
    paintAvatar(
      document.getElementById("edit-profile-avatar-face"),
      user || username || "?",
      myAvatarUrl
    );
    if (profileCache && profileCache.is_self) {
      profileCache.avatar_url = myAvatarUrl;
    }
    toast(myAvatarUrl ? "Photo updated" : "Photo removed");
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
    if (!post || post.id == null) return;
    var el = document.getElementById("feed-post-" + post.id);
    if (el) el.replaceWith(buildFeedCard(post));
    var detail = document.getElementById("post-detail-" + post.id);
    if (detail) {
      var open = !detail.querySelector(".x-comments.collapsed");
      var next = buildFeedCard(post, { openComments: open });
      next.id = "post-detail-" + post.id;
      detail.replaceWith(next);
    }
    var pin = document.getElementById("room-pin-" + post.id);
    if (pin && discoverMode && exploreTab === "foryou") {
      pin.replaceWith(buildRoomPinCard(post, {}));
    }
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

  socket.on("foryou_feed", function (data) {
    feedHasMore = !!(data && data.has_more);
    var more = document.getElementById("feed-more");
    if (more) more.classList.toggle("hidden", !feedHasMore);
    renderFeedPosts((data && data.posts) || [], !!(data && data.append));
  });
  socket.on("trends", function (data) {
    var tags = [];
    if (Array.isArray(data)) tags = data;
    else if (data && Array.isArray(data.tags)) tags = data.tags;
    renderTrends(tags);
  });
  socket.on("clips_feed", function (data) {
    clipsHasMore = !!(data && data.has_more);
    renderClipsFeed((data && data.posts) || (data && data.clips) || [], !!(data && data.append));
  });
  socket.on("clip_created", function (post) {
    toast("Clip posted");
    if (clipsMode && post) renderClipsFeed([post], true);
    else if (clipsMode && socket) socket.emit("clips_load", {});
    closeClipComposer();
  });
  socket.on("rooms_feed", function (data) {
    /* Community room threads are not Explore pins — Explore uses discover_feed. */
    return;
  });
  socket.on("snaps", function (data) {
    var rows = [];
    if (Array.isArray(data)) rows = data;
    else if (data && Array.isArray(data.snaps)) rows = data.snaps;
    renderPulseInbox(rows);
  });
  socket.on("snap_received", function (data) {
    pulseUnread += 1;
    updatePulseBadge();
    toast("New snap from @" + ((data && (data.from_user || data.from)) || "someone"));
    if (pulseMode && socket) socket.emit("snaps_inbox");
  });
  socket.on("snap_opened", function (data) {
    var snap = data && (data.snap || data);
    if (snap) showPulseViewer(snap);
    if (socket) socket.emit("snaps_inbox");
  });
  socket.on("snap_sent", function () {
    toast("Snap sent");
    var form = document.getElementById("pulse-form");
    if (form) form.reset();
  });
  socket.on("channel_pins", function (data) {
    renderChannelPins(data);
  });
  socket.on("wave_error", function (data) {
    var msg = (data && data.error) || "Wave action failed";
    toast(msg, true);
    console.warn("wave_error", data);
  });

  socket.on("stories", function (data) {
    renderStories((data && data.groups) || []);
    if (youMode) renderYouHighlights();
  });
  socket.on("story_created", function () {
    toast("Story shared");
    closeStoryModal();
  });
  socket.on("story_deleted", function (data) {
    var id = data && data.id;
    toast("Highlight deleted");
    if (storyViewerGroup && storyViewerGroup.is_me) {
      var stories = storyViewerGroup.stories || [];
      storyViewerGroup.stories = stories.filter(function (s) {
        return String(s.id) !== String(id);
      });
      if (!storyViewerGroup.stories.length) {
        closeStoryViewer();
      } else {
        if (storyViewerIndex >= storyViewerGroup.stories.length) {
          storyViewerIndex = storyViewerGroup.stories.length - 1;
        }
        showStorySlide();
      }
    }
    renderYouHighlights();
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
  ensureIceServers()
    .catch(function () {})
    .then(function () {
      return fetch("/api/layout").then(function (r) {
        return r.json();
      });
    })
    .then(function (data) {
      layout = data;
      if (!communityId) communityId = data.communities[0].id;
      if (!channelId) channelId = data.communities[0].channels[0].id;
      if (socket) socket.disconnect();
      socket = io();
      bindSocket();
      showApp();
      setConnChip("reconnecting");
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
onClick("tab-login", function () {
  document.getElementById("tab-login").classList.add("active");
  document.getElementById("tab-register").classList.remove("active");
  document.getElementById("login-form").classList.remove("hidden");
  document.getElementById("register-form").classList.add("hidden");
  setAuthMsg("");
});

onClick("tab-register", function () {
  document.getElementById("tab-register").classList.add("active");
  document.getElementById("tab-login").classList.remove("active");
  document.getElementById("register-form").classList.remove("hidden");
  document.getElementById("login-form").classList.add("hidden");
  setAuthMsg("");
});

onSubmit("login-form", function (e) {
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
});

onSubmit("register-form", function (e) {
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
});

onClick("rename-channel", promptRenameChannel);
onClick("rename-community", function () {
  document.getElementById("community-menu").classList.add("hidden");
  promptRenameCommunity();
});
onClick("open-settings", openSettingsModal);
onClick("settings-close", closeSettingsModal);
document.getElementById("settings-modal").addEventListener("click", function (e) {
  if (e.target.id === "settings-modal") closeSettingsModal();
});
onClick("settings-theme", toggleTheme);
onClick("settings-edit-name", function () {
  closeSettingsModal();
  promptDisplayName();
});
onClick("settings-password", function () {
  closeSettingsModal();
  openPasswordModal();
});
onClick("settings-status", function () {
  closeSettingsModal();
  openStatusModal();
});
onClick("settings-sound", function () {
  setSoundEnabled(!soundEnabled);
  toast(soundEnabled ? "Sounds on" : "Sounds muted");
});
onClick("settings-mic", function () {
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
});
onClick("settings-cam", function () {
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
});
onClick("pw-cancel", closePasswordModal);
onClick("pw-save", savePassword);
onClick("prompt-cancel", closePrompt);
onClick("prompt-save", function () {
  if (promptCallback) {
    promptCallback(
      document.getElementById("prompt-input-1").value,
      document.getElementById("prompt-input-2").value
    );
  }
  closePrompt();
});

onClick("community-menu-btn", function (e) {
  e.stopPropagation();
  var menu = document.getElementById("community-menu");
  var rect = e.currentTarget.getBoundingClientRect();
  menu.style.left = rect.left + "px";
  menu.style.top = rect.bottom + 6 + "px";
  menu.classList.toggle("hidden");
});

onClick("open-switcher", openSwitcher);
document.getElementById("switcher-input").addEventListener("input", function (e) {
  renderSwitcherResults(e.target.value);
});
document.getElementById("switcher-modal").addEventListener("click", function (e) {
  if (e.target.id === "switcher-modal") closeSwitcher();
});

onClick("toggle-members", function () {
  if (isMobileLayout()) {
    openMobilePeople();
    return;
  }
  var body = document.querySelector(".chat-body");
  var btn = document.getElementById("toggle-members");
  var collapsed = body.classList.toggle("members-collapsed");
  btn.setAttribute("aria-pressed", collapsed ? "false" : "true");
});

onClick("meet-now", function () {
  if (!socket) return;
  if (inCall) {
    teardownCallMedia();
    socket.emit("call_leave");
    return;
  }
  ensureIceServers()
    .then(function () {
      return ensureLocalMedia();
    })
    .catch(function () {
      toast("Mic/camera unavailable — joining without media. Use Settings to allow access.", true);
    })
    .then(function () {
      socket.emit("call_join");
    });
});

onClick("meet-now-mobile", function () {
  var btn = $("meet-now");
  if (btn) btn.click();
});

onClick("status-mobile", function () {
  closeMobileDrawers();
  openStatusModal();
});

onClick("nav-chat", openChat);
onClick("nav-home", openHome);
onClick("nav-explore", function () {
  openExplore(exploreTab === "clips" ? "clips" : exploreTab === "boards" ? "boards" : "foryou");
});
onClick("nav-create", openCreateModal);
onClick("nav-you", function () {
  openYou();
});
onClick("home-create", openCreateModal);
onClick("header-feed", openHome);

onClick("explore-tab-foryou", function () {
  openExplore("foryou");
});
onClick("explore-tab-clips", function () {
  openExplore("clips");
});
onClick("explore-tab-boards", function () {
  openExplore("boards");
});

onClick("create-cancel", closeCreateModal);
onClick("create-submit", submitCreateModal);
onClick("create-pick-photo", function () {
  pendingCreateKind = "image";
  var input = document.getElementById("create-file");
  if (input) {
    input.accept = "image/jpeg,image/png,image/gif,image/webp";
    input.click();
  }
});
onClick("create-pick-video", function () {
  pendingCreateKind = "video";
  var input = document.getElementById("create-file");
  if (input) {
    input.accept = "video/mp4,video/webm,video/quicktime";
    input.click();
  }
});
onClick("create-attach-clear", clearCreateAttach);
var createFile = document.getElementById("create-file");
if (createFile) {
  createFile.onchange = function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var isVid = (file.type && file.type.indexOf("video/") === 0) || pendingCreateKind === "video";
    uploadDeviceImage(file)
      .then(function (url) {
        pendingCreateUrl = url;
        pendingCreateKind = isVid ? "video" : "image";
        setAttachPreview("create", url, file.name || (isVid ? "Video" : "Photo"));
        toast(isVid ? "Video attached" : "Photo attached");
      })
      .catch(function (err) {
        toast((err && err.message) || "Upload failed", true);
      });
  };
}

onClick("you-stories", openStoryModal);
onClick("you-avatar", pickYouAvatar);

var youAvatarFile = document.getElementById("you-avatar-file");
if (youAvatarFile) {
  youAvatarFile.onchange = function (e) {
    var file = e.target.files && e.target.files[0];
    if (file) uploadYouAvatar(file);
    e.target.value = "";
  };
}

onClick("you-create", openCreateModal);
onClick("you-edit-profile", openEditProfileModal);
onClick("you-status", function () {
  if (!isOwnYouProfile()) return;
  openStatusModal();
});
onClick("you-settings", openSettingsModal);
onClick("you-back", function () {
  openYou("posts");
});
onClick("you-follow", function () {
  if (!youProfileUsername) return;
  toggleFollow(youProfileUsername);
});
onClick("you-message", function () {
  if (!youProfileUsername) return;
  openDm(youProfileUsername);
});
onClick("edit-profile-cancel", closeEditProfileModal);
onClick("edit-profile-save", saveEditProfile);
onClick("edit-profile-avatar", pickYouAvatar);
document.getElementById("edit-profile-modal") &&
  document.getElementById("edit-profile-modal").addEventListener("click", function (e) {
    if (e.target && e.target.id === "edit-profile-modal") closeEditProfileModal();
  });
onClick("you-tab-posts", function () {
  setYouTab("posts");
});
onClick("you-tab-reposts", function () {
  setYouTab("reposts");
});
onClick("you-tab-saved", function () {
  if (!isOwnYouProfile()) return;
  setYouTab("saved");
});
onClick("you-stat-posts", function () {
  setYouTab("posts");
});
onClick("you-stat-reposts", function () {
  setYouTab("reposts");
});
onClick("you-stat-saved", function () {
  if (!isOwnYouProfile()) return;
  setYouTab("saved");
});
onClick("you-stat-followers", function () {
  if (!isOwnYouProfile()) {
    toast("Followers are private");
    return;
  }
  var users = (profileCache && profileCache.followers_users) || [];
  if (!users.length) {
    toast("No followers yet");
    return;
  }
  var names = users
    .map(function (u) {
      return typeof u === "string" ? u : u.username || u.name || "";
    })
    .filter(Boolean)
    .slice(0, 12);
  toast(names.join(", ") + (users.length > 12 ? "…" : ""));
});
onClick("save-cancel", closeSaveModal);
onClick("post-detail-close", closePostDetail);
document.getElementById("post-detail-modal") &&
  document.getElementById("post-detail-modal").addEventListener("click", function (e) {
    if (e.target && e.target.id === "post-detail-modal") closePostDetail();
  });

onSubmit("save-board-create", function (e) {
  e.preventDefault();
  if (!socket) return;
  var input = document.getElementById("save-board-name");
  var name = input && input.value.trim();
  if (!name) {
    toast("Name your board", true);
    return;
  }
  socket.emit("board_create", { name: name });
  if (input) input.value = "";
});

onClick("open-pulse", function () {
  openPulse();
});
onClick("close-pulse", openChat);
onClick("close-discover", openChat);
onClick("close-clips", openChat);

onClick("tab-following", function () {
  setFeedTab("following");
});
var tabForYou = onClick("tab-foryou", function () {
  setFeedTab("foryou");
});
if (tabForYou) {
  tabForYou.disabled = false;
  tabForYou.removeAttribute("disabled");
  tabForYou.title = "For you";
}

bindWireTabs();

onClick("post-quote-clear", clearQuotePost);

onClick("channel-pins-btn", toggleChannelPinsPanel);

function openClipComposer() {
  var form = document.getElementById("clip-form");
  var panel = document.getElementById("explore-panel-clips");
  if (!form) return;
  form.classList.remove("hidden");
  if (panel) panel.classList.add("compose-open");
  var text = document.getElementById("clip-text");
  if (text) text.focus();
}

function closeClipComposer() {
  var form = document.getElementById("clip-form");
  var panel = document.getElementById("explore-panel-clips");
  if (form) {
    form.classList.add("hidden");
    form.reset();
  }
  if (panel) panel.classList.remove("compose-open");
}

onClick("clip-pick-video", function () {
  var input = document.getElementById("clip-file");
  if (input) input.click();
});
onClick("clips-compose-open", openClipComposer);
onClick("clip-form-close", closeClipComposer);
onClick("clip-form-cancel", closeClipComposer);

onSubmit("clip-form", function (e) {
  e.preventDefault();
  if (!socket) return;
  var clipForm = $("clip-form");
  if (!clipForm) return;
  var textEl = clipForm.querySelector("#clip-text, textarea, [name='text']");
  var urlEl = clipForm.querySelector("#clip-url, #clip-media-url, input[type='url']");
  var fileEl = clipForm.querySelector("#clip-file, input[type='file']");
  var text = textEl ? (textEl.value || "").trim() : "";
  var mediaUrl = urlEl ? (urlEl.value || "").trim() : "";
  var file = fileEl && fileEl.files && fileEl.files[0];
  function emitClip(url) {
    if (!text && !url) {
      toast("Add a caption or video", true);
      return;
    }
    socket.emit("clip_create", {
      text: text,
      image_url: url || "",
      media_url: url || "",
      media_kind: "video",
    });
  }
  if (file) {
    uploadDeviceImage(file)
      .then(function (url) {
        emitClip(url);
      })
      .catch(function (err) {
        toast((err && err.message) || "Could not upload clip", true);
      });
  } else {
    emitClip(mediaUrl);
  }
});

onSubmit("pulse-form", function (e) {
  e.preventDefault();
  if (!socket) return;
  var pulseForm = $("pulse-form");
  if (!pulseForm) return;
  var toEl = pulseForm.querySelector("#pulse-to, #snap-to, [name='to_user']");
  var textEl = pulseForm.querySelector("#pulse-text, textarea, [name='text']");
  var urlEl = pulseForm.querySelector("#pulse-url, #pulse-media-url, input[type='url']");
  var fileEl = pulseForm.querySelector("#pulse-file, input[type='file']");
  var toUser = toEl ? (toEl.value || "").trim() : "";
  var text = textEl ? (textEl.value || "").trim() : "";
  var mediaUrl = urlEl ? (urlEl.value || "").trim() : "";
  var file = fileEl && fileEl.files && fileEl.files[0];
  if (!toUser) {
    toast("Pick someone to snap", true);
    return;
  }
  function emitSnap(url) {
    socket.emit("snap_send", {
      to_user: toUser,
      text: text,
      media_url: url || "",
    });
  }
  if (file) {
    uploadDeviceImage(file)
      .then(function (url) {
        emitSnap(url);
      })
      .catch(function (err) {
        toast((err && err.message) || "Could not upload snap media", true);
      });
  } else {
    emitSnap(mediaUrl);
  }
});

onClick("go-live", startGoLive);
onClick("end-live", endGoLive);
onClick("join-live", function () {
  ensureIceServers().then(joinLiveCall);
});
onClick("call-share-screen", toggleScreenShare);
onClick("settings-logout", signOut);

onSubmit("board-create-form", function (e) {
  e.preventDefault();
  if (!socket) return;
  var nameInput = $("board-name");
  var name = nameInput ? (nameInput.value || "").trim() : "";
  if (!name) return;
  socket.emit("board_create", { name: name });
  if (nameInput) nameInput.value = "";
});
onSubmit("board-pin-form", function (e) {
  e.preventDefault();
  if (!socket) return;
  var boardEl = $("pin-board-id");
  var postEl = $("pin-post-id");
  var boardId = Number(boardEl && boardEl.value);
  var postId = Number(postEl && postEl.value);
  if (!boardId || !postId) {
    toast("Need a board id and post id", true);
    return;
  }
  socket.emit("board_pin", { board_id: boardId, post_id: postId });
});
onClick("discover-more", function () {
  if (!socket || !discoverHasMore || selectedBoardId || !discoverOldestId) return;
  if (exploreTab !== "foryou") return;
  emitExploreLoad({ before_id: discoverOldestId });
});

onSubmit("post-form", function (e) {
  e.preventDefault();
  if (!socket) return;
  var text = document.getElementById("post-text").value.trim();
  var imageField = document.getElementById("post-image");
  var image = pendingPostImageUrl || (imageField ? imageField.value.trim() : "");
  if (!text && !image) {
    toast("Write something or add a photo", true);
    return;
  }
  if (quoteOfId) {
    socket.emit("quote_post", { post_id: quoteOfId, text: text });
    clearQuotePost();
  } else {
    var payload = { text: text, image_url: image };
    if (pendingPostMediaKind === "video" || isVideoUrl(image)) {
      payload.media_kind = "video";
      payload.media_url = image;
    }
    socket.emit("post_create", payload);
  }
  document.getElementById("post-text").value = "";
  if (imageField) imageField.value = "";
  clearPostAttach();
});

onClick("post-pick-photo", function () {
  document.getElementById("post-file").click();
});
onClick("post-pick-video", function () {
  pendingPostMediaKind = "video";
  var videoFile = $("post-video-file") || $("post-file");
  if (videoFile) videoFile.click();
});
document.getElementById("post-file").onchange = function (e) {
  var file = e.target.files && e.target.files[0];
  if (!file) return;
  if (file.type && file.type.indexOf("video/") === 0) {
    attachPostVideo(file);
    return;
  }
  uploadDeviceImage(file)
    .then(function (url) {
      pendingPostImageUrl = url;
      pendingPostMediaKind = "image";
      document.getElementById("post-image").value = "";
      setAttachPreview("post", url, file.name);
      toast("Photo attached");
    })
    .catch(function (err) {
      toast((err && err.message) || "Could not upload photo", true);
      clearPostAttach();
    });
};
var postVideoFile = document.getElementById("post-video-file");
if (postVideoFile) {
  postVideoFile.onchange = function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    attachPostVideo(file);
  };
}
onClick("post-attach-clear", clearPostAttach);

onClick("feed-more", function () {
  if (!socket || !feedHasMore || !feedOldestId) return;
  if (feedTab === "foryou") socket.emit("foryou_load", { before_id: feedOldestId });
  else socket.emit("feed_load", { before_id: feedOldestId });
});

onClick("load-older", function () {
  if (!socket || !channelHasMore || !channelOldestId) return;
  socket.emit("load_older_messages", { before_id: channelOldestId });
});

onClick("call-toggle-mic", function () {
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
});

onClick("call-toggle-cam", function () {
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
});

onClick("leave-call", function () {
  if (!socket) return;
  teardownCallMedia();
  socket.emit("call_leave");
});

onSubmit("add-friend-form", function (e) {
  e.preventDefault();
  if (!socket) return;
  var input = document.getElementById("friend-username");
  var value = (input.value || "").trim();
  if (!value) return;
  sendFriendRequest(value);
});

onSubmit("add-event-form", function (e) {
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
});

// status picker
onClick("status-btn", openStatusModal);
onClick("status-cancel", closeStatusModal);
document.querySelectorAll(".status-choice").forEach(function (btn) {
  btn.onclick = function () {
    pendingStatus = btn.getAttribute("data-status");
    document.querySelectorAll(".status-choice").forEach(function (b) {
      b.classList.toggle("active", b === btn);
    });
  };
});
onClick("status-save", function () {
  if (!socket) return;
  socket.emit("set_status", {
    status: pendingStatus,
    status_text: document.getElementById("status-text-input").value.trim(),
  });
});

// stories
onClick("add-story-btn", openStoryModal);
onClick("story-cancel", closeStoryModal);
document.querySelectorAll(".story-bg").forEach(function (btn) {
  btn.onclick = function () {
    pendingStoryBg = btn.getAttribute("data-bg");
    document.querySelectorAll(".story-bg").forEach(function (b) {
      b.classList.toggle("active", b === btn);
    });
  };
});
onClick("story-save", function () {
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
});
onClick("story-pick-photo", function () {
  document.getElementById("story-file").click();
});
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
onClick("story-attach-clear", clearStoryAttach);
onClick("story-viewer-close", closeStoryViewer);
onClick("story-viewer-delete", deleteCurrentStory);
onClick("story-prev", function () {
  if (!storyViewerGroup) return;
  storyViewerIndex -= 1;
  if (storyViewerIndex < 0) storyViewerIndex = 0;
  showStorySlide();
});
onClick("story-next", function () {
  if (!storyViewerGroup) return;
  storyViewerIndex += 1;
  showStorySlide();
});

document.getElementById("message-search").addEventListener("input", applySearchFilter);

onClick("emoji-toggle", function () {
  reactionTargetId = null;
  document.getElementById("emoji-panel").classList.toggle("hidden");
});

onClick("attach-photo", function () {
  document.getElementById("chat-file").click();
});
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
onClick("chat-attach-clear", clearChatAttach);

onClick("emoji-panel", function (e) {
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
});

onSubmit("form", function (e) {
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
});

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
    closeCreateModal();
    if (feedMode || discoverMode || clipsMode || pulseMode || youMode) openChat();
    document.getElementById("emoji-panel").classList.add("hidden");
    document.getElementById("community-menu").classList.add("hidden");
  }
});

document.addEventListener("click", function () {
  document.getElementById("community-menu").classList.add("hidden");
});

onClick("toggle-sidebar", function (e) {
  e.stopPropagation();
  if (isMobileLayout()) {
    openMobileSidebar();
    return;
  }
  document.querySelector(".sidebar").classList.toggle("open");
});

document.getElementById("channel-list").addEventListener("click", function () {
  closeMobileDrawers();
  document.querySelector(".sidebar").classList.remove("open");
});

onClick("mobile-backdrop", function () {
  closeMobileDrawers();
  var nav = "chat";
  if (feedMode) nav = "home";
  else if (discoverMode || clipsMode) nav = "explore";
  else if (youMode) nav = "you";
  setMobileNav(nav);
});

onClick("mobile-nav-chat", function () {
  openChat();
});

onClick("mobile-nav-home", function () {
  openHome();
});

onClick("mobile-nav-explore", function () {
  openExplore(exploreTab || "foryou");
});

onClick("mobile-nav-create", function () {
  openCreateModal();
});

onClick("mobile-nav-you", function () {
  openYou();
});

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

syncFeedTabs();

applyTheme(themeMode);
syncSoundUi();
refreshMediaPermissionState();
