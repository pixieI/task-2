/**
 * LAN Chat Server
 * ----------------
 * Serves the web client (Express, static files) and runs a WebSocket
 * server on the same HTTP port for real-time messaging between every
 * device on the local network.
 *
 * Protocol (JSON messages over the WebSocket):
 *   Client -> Server
 *     { type: 'join',    username: string }
 *     { type: 'message', text: string }
 *     { type: 'typing' }
 *
 *   Server -> Client
 *     { type: 'welcome',  id, username, history: [...] }
 *     { type: 'message',  id, username, text, ts }
 *     { type: 'system',   text, ts }
 *     { type: 'userlist', users: [{id, username}] }
 *     { type: 'typing',   username }
 *     { type: 'error',    text }
 */

const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_USERNAME_LENGTH = 24;
const HISTORY_LIMIT = 50; // last N messages replayed to newly joined clients

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/** clientId -> { ws, username } */
const clients = new Map();
/** rolling buffer of recent chat messages for late joiners */
const history = [];

function now() {
  return new Date().toISOString();
}

function sanitize(text) {
  // Strip control characters and clamp length; the client also escapes
  // HTML on render, but we never trust input we didn't produce.
  return String(text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, MAX_MESSAGE_LENGTH);
}

function broadcast(payload, exceptId = null) {
  const data = JSON.stringify(payload);
  for (const [id, client] of clients) {
    if (id === exceptId) continue;
    if (client.ws.readyState === client.ws.OPEN) {
      client.ws.send(data);
    }
  }
}

function sendUserList() {
  const users = [...clients.entries()].map(([id, c]) => ({ id, username: c.username }));
  broadcast({ type: 'userlist', users });
}

function pushHistory(entry) {
  history.push(entry);
  if (history.length > HISTORY_LIMIT) history.shift();
}

function usernameTaken(name) {
  return [...clients.values()].some((c) => c.username.toLowerCase() === name.toLowerCase());
}

wss.on('connection', (ws) => {
  const id = crypto.randomUUID();
  let joined = false;

  // Give unauthenticated sockets a grace period to send a valid 'join'
  const joinTimeout = setTimeout(() => {
    if (!joined) ws.close(4001, 'Join timeout');
  }, 15000);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // ignore malformed frames
    }

    if (msg.type === 'join' && !joined) {
      let username = sanitize(msg.username || '').trim().slice(0, MAX_USERNAME_LENGTH);
      if (!username) {
        ws.send(JSON.stringify({ type: 'error', text: 'Username cannot be empty.' }));
        return;
      }
      if (usernameTaken(username)) {
        ws.send(JSON.stringify({ type: 'error', text: 'That name is already in use on this network.' }));
        return;
      }

      joined = true;
      clearTimeout(joinTimeout);
      clients.set(id, { ws, username });

      ws.send(JSON.stringify({ type: 'welcome', id, username, history }));

      const sysText = `${username} joined the channel`;
      const sysMsg = { type: 'system', text: sysText, ts: now() };
      pushHistory(sysMsg);
      broadcast(sysMsg, id);
      sendUserList();
      return;
    }

    if (!joined) return; // ignore everything else until joined

    const client = clients.get(id);

    if (msg.type === 'message') {
      const text = sanitize(msg.text || '').trim();
      if (!text) return;
      const chatMsg = { type: 'message', id: crypto.randomUUID(), username: client.username, text, ts: now() };
      pushHistory(chatMsg);
      broadcast(chatMsg);
      return;
    }

    if (msg.type === 'typing') {
      broadcast({ type: 'typing', username: client.username }, id);
      return;
    }
  });

  ws.on('close', () => {
    clearTimeout(joinTimeout);
    if (joined) {
      const client = clients.get(id);
      clients.delete(id);
      if (client) {
        const sysMsg = { type: 'system', text: `${client.username} left the channel`, ts: now() };
        pushHistory(sysMsg);
        broadcast(sysMsg);
        sendUserList();
      }
    }
  });

  ws.on('error', () => {
    // Let 'close' handle cleanup.
  });
});

function localAddresses() {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  return addrs;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nLAN Chat server running`);
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const addr of localAddresses()) {
    console.log(`  Network: http://${addr}:${PORT}   <- share this with other devices on the LAN`);
  }
  console.log('');
});
