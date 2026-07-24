(() => {
  const joinScreen = document.getElementById('join-screen');
  const chatScreen = document.getElementById('chat-screen');
  const joinForm = document.getElementById('join-form');
  const usernameInput = document.getElementById('username-input');
  const joinError = document.getElementById('join-error');

  const messageForm = document.getElementById('message-form');
  const messageInput = document.getElementById('message-input');
  const messagesEl = document.getElementById('messages');
  const userListEl = document.getElementById('user-list');
  const userCountEl = document.getElementById('user-count');
  const meUsernameEl = document.getElementById('me-username');
  const typingEl = document.getElementById('typing-indicator');
  const connDot = document.getElementById('conn-dot');
  const connLabel = document.getElementById('conn-label');

  let ws = null;
  let myId = null;
  let myUsername = null;
  let pendingUsername = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let typingTimeout = null;
  let lastTypingSent = 0;

  const wsUrl = () => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}`;
  };

  function setConnStatus(state) {
    connDot.className = 'status-dot ' + state;
    connLabel.textContent =
      state === 'live' ? 'connected' : state === 'down' ? 'disconnected — retrying…' : 'connecting…';
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatTime(iso) {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function appendMessage({ type, username, text, ts }) {
    const wasAtBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;

    const row = document.createElement('div');

    if (type === 'system') {
      row.className = 'msg system';
      row.innerHTML = `<span class="ts">${formatTime(ts)}</span><span class="text">· ${escapeHtml(text)}</span>`;
    } else {
      const mine = username === myUsername;
      row.className = 'msg' + (mine ? ' mine' : '');
      row.innerHTML =
        `<span class="ts">${formatTime(ts)}</span>` +
        `<span class="author">${escapeHtml(username)}</span>` +
        `<span class="text">${escapeHtml(text)}</span>`;
    }

    messagesEl.appendChild(row);
    if (wasAtBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function renderUserList(users) {
    userCountEl.textContent = users.length;
    userListEl.innerHTML = '';
    for (const u of users) {
      const li = document.createElement('li');
      const isMe = u.id === myId;
      if (isMe) li.classList.add('is-me');
      li.innerHTML = `<span class="dot"></span>${escapeHtml(u.username)}${isMe ? ' (you)' : ''}`;
      userListEl.appendChild(li);
    }
  }

  function connect(username) {
    pendingUsername = username;
    setConnStatus('connecting');
    ws = new WebSocket(wsUrl());

    ws.addEventListener('open', () => {
      reconnectAttempts = 0;
      ws.send(JSON.stringify({ type: 'join', username: pendingUsername }));
    });

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case 'welcome': {
          myId = msg.id;
          myUsername = msg.username;
          meUsernameEl.textContent = myUsername;
          joinScreen.hidden = true;
          chatScreen.hidden = false;
          setConnStatus('live');
          messagesEl.innerHTML = '';
          for (const entry of msg.history) appendMessage(entry);
          messagesEl.scrollTop = messagesEl.scrollHeight;
          messageInput.focus();
          break;
        }
        case 'message':
          appendMessage(msg);
          break;
        case 'system':
          appendMessage(msg);
          break;
        case 'userlist':
          renderUserList(msg.users);
          break;
        case 'typing':
          typingEl.textContent = `${msg.username} is typing…`;
          clearTimeout(typingTimeout);
          typingTimeout = setTimeout(() => (typingEl.textContent = ''), 2000);
          break;
        case 'error':
          if (joinScreen.hidden === false) {
            joinError.textContent = msg.text;
            joinError.hidden = false;
          }
          break;
      }
    });

    ws.addEventListener('close', () => {
      setConnStatus('down');
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      ws.close();
    });
  }

  function scheduleReconnect() {
    if (!pendingUsername) return;
    clearTimeout(reconnectTimer);
    const delay = Math.min(1000 * 2 ** reconnectAttempts, 10000);
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => connect(pendingUsername), delay);
  }

  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    joinError.hidden = true;
    const name = usernameInput.value.trim();
    if (!name) return;
    connect(name);
  });

  messageForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = messageInput.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'message', text }));
    messageInput.value = '';
  });

  messageInput.addEventListener('input', () => {
    const nowMs = Date.now();
    if (ws && ws.readyState === WebSocket.OPEN && nowMs - lastTypingSent > 1200) {
      lastTypingSent = nowMs;
      ws.send(JSON.stringify({ type: 'typing' }));
    }
  });
})();
