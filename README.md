# LAN Chat

A real-time, multi-user text chat app for your local network. One person runs
the server; everyone else on the same Wi-Fi/LAN opens a link in their browser
— no installs required for the other users.

**Stack:** Node.js + Express (serves the web page) + `ws` (WebSocket server
for real-time messaging).

## Features

- Real-time messaging over WebSockets (instant delivery, no polling)
- Multiple concurrent users, each with a chosen handle
- Live "who's online" list
- Join/leave system notifications
- Typing indicator
- Replays the last 50 messages to anyone who joins mid-conversation
- Auto-reconnect with backoff if a client's connection drops
- Duplicate-username protection
- Works on desktop and mobile browsers (responsive layout)

## Requirements

- Node.js 18+ installed on the machine that will act as the **server**.
- All devices connected to the **same local network** (same Wi-Fi/LAN, same
  subnet — a guest Wi-Fi network with "client isolation" enabled will block
  this even though everyone shows the same SSID; see Troubleshooting).

## 1. Install and start the server

```bash
cd lan-chat
npm install     # pulls in express and ws, defined in package.json
npm start       # runs "node server.js"
```

On startup the server prints every usable address it's reachable at:

```
LAN Chat server running
  Local:   http://localhost:3000
  Network: http://192.168.1.42:3000   <- share this with other devices on the LAN
```

`server.js` gets that `192.168.1.42` value itself, at runtime, by calling
Node's `os.networkInterfaces()` and filtering for non-internal IPv4
addresses — so whatever prints on your machine is the real address to use,
even if it differs from the example above (common ranges are `192.168.x.x`
or `10.x.x.x`). If the machine has more than one active network interface
(e.g. Wi-Fi and Ethernet both up), you'll see a line for each — pick the one
on the network your other devices are also connected to.

Keep this terminal window open; closing it (or `Ctrl+C`) stops the server
and disconnects everyone.

## 2. Connect other devices

1. Confirm the other device (phone, laptop, tablet) is on **the same
   Wi-Fi network or LAN segment** as the server machine — not a guest
   network, not a different VLAN, not cellular data.
2. Open a browser and type in the **Network** URL exactly as printed,
   e.g. `http://192.168.1.42:3000` — including `http://` (not `https://`)
   and the `:3000` port.
3. Enter a handle on the join screen and press **Join channel**. That's it —
   messages sent from any device appear on every other connected device
   within a fraction of a second.

The host machine itself can just use the `Local` URL
(`http://localhost:3000`), or the Network URL — both work.

### Finding the server's LAN IP manually

The printed address should be all you need, but if you ever need to find it
yourself:

- **macOS**: `ipconfig getifaddr en0` (Wi-Fi) or check System
  Settings → Wi-Fi → Details.
- **Windows**: `ipconfig`, then look at "IPv4 Address" under your active
  adapter.
- **Linux**: `ip addr show` or `hostname -I`.

## Configuration

- Change the port: `PORT=8080 npm start`

## Troubleshooting

**Other devices can't load the page at all**
- Double-check they're on the same network/subnet as the server — phones in
  particular sometimes silently fall back to cellular data.
- Some routers (common on public/guest Wi-Fi) enable **client isolation** /
  **AP isolation**, which blocks devices on the same Wi-Fi from reaching
  each other even though they share an SSID. There's no client-side fix —
  it has to be disabled on the router, or you use a different network.
- A firewall on the server machine may be blocking inbound connections on
  the port (default `3000`). Allow inbound TCP on that port for Node.js, or
  temporarily disable the firewall to confirm that's the cause.

**Page loads but the sidebar says "disconnected — retrying…"**
- The initial HTTP page load and the WebSocket connection use the same host
  and port, so if the page loaded, the WebSocket upgrade almost always will
  too. If it doesn't, a proxy, VPN, or corporate network policy between the
  two devices may be stripping the `Upgrade` header — try a different
  network path (e.g. direct Wi-Fi instead of through a VPN).
- The client automatically retries with increasing backoff (see
  "Reconnection" below), so transient Wi-Fi drops recover on their own.

## Project structure

```
lan-chat/
├── server.js          # Express + WebSocket server (all chat logic)
├── package.json
└── public/            # Static web client
    ├── index.html
    ├── style.css
    └── client.js
```

## How it works, under the hood

### One port, two protocols

`server.js` creates a single `http.Server` and attaches two things to it:

```js
const server = http.createServer(app);       // Express handles plain HTTP
const wss = new WebSocketServer({ server }); // ws piggybacks on the same server
```

Express handles ordinary HTTP requests — anything that isn't a WebSocket
handshake — and serves the static files in `public/` (the HTML/CSS/JS the
browser loads first).

A WebSocket connection begins life as a normal HTTP request with an
`Upgrade: websocket` header. Because `wss` is attached to the same `server`
instance, Node routes that specific kind of request to the `ws` library
instead of to Express, which performs the WebSocket handshake (HTTP 101
Switching Protocols) and hands back a persistent, full-duplex TCP socket.
This is why the server only needs to listen on one port (`3000` by
default) for both the web page and the live chat traffic.

### Tracking connected sockets

Every browser tab that connects gets its own raw WebSocket object from
`wss.on('connection', (ws) => { ... })`. The server assigns it a random
UUID and, once the client successfully joins with a username, stores it in
an in-memory `Map`:

```js
const clients = new Map(); // clientId -> { ws, username }
```

This map is the entire "address book" of who's currently connected — there's
no database. It's populated on join, updated on disconnect, and read
whenever the server needs to broadcast a message or list who's online.

### Message routing (the JSON protocol)

Every WebSocket frame — in both directions — is a JSON string with a `type`
field, e.g. `{"type":"message","text":"hi"}` or
`{"type":"userlist","users":[...]}`. `server.js` documents the full
protocol in its header comment. Routing works like this:

1. **Client → server:** the browser's `ws.send(JSON.stringify({ type: ... }))`
   sends one frame per WebSocket. On the server, `ws.on('message', raw => ...)`
   parses it with `JSON.parse` and switches on `msg.type` (`join`,
   `message`, or `typing`) to decide what to do.
2. **Server → clients (fan-out):** a `broadcast(payload, exceptId)` helper
   iterates the `clients` Map and calls `client.ws.send(...)` on every open
   socket (skipping the sender when appropriate, e.g. so you don't get a
   "so-and-so is typing" notice about yourself). This is the routing core —
   there are no chat "rooms" or targeted delivery in this version, so a
   message from any one client fans out to literally every other connected
   socket, each over its own independent TCP connection.
3. Before writing to a socket, the server checks
   `client.ws.readyState === client.ws.OPEN` — a client that's in the
   process of closing (but hasn't been removed from the Map yet) is
   silently skipped rather than causing a send error.

### Connection lifecycle

- **Join:** a fresh socket has 15 seconds (`joinTimeout`) to send a valid
  `join` message before the server closes it — this stops idle/incomplete
  connections from lingering.
- **Duplicate names:** on join, the server checks existing entries in
  `clients` for a case-insensitive username match and rejects the join with
  an `error` message if it's taken.
- **History replay:** a rolling array (`history`, capped at the last 50
  entries) is appended to on every chat/system message and sent whole to
  each newly joined client in its `welcome` payload, so latecomers see
  recent context instead of a blank screen.
- **Disconnect:** `ws.on('close', ...)` fires whether the browser tab was
  closed, the network dropped, or the user navigated away. The server
  deletes that client from the `Map`, broadcasts a "left the channel"
  system message, and pushes a fresh user list to everyone still connected.

### Reconnection (client side)

`public/client.js` wraps the WebSocket in its own small state machine. If
`ws.on('close')` fires unexpectedly (network blip, server restart), the
client schedules a reconnect with exponential backoff
(`1s, 2s, 4s, 8s, capped at 10s`) and automatically re-sends the same `join`
message once the socket reopens — so a brief Wi-Fi drop recovers without
the user having to do anything, and the sidebar's status dot reflects
`connecting… / connected / disconnected — retrying…` throughout.

### Why in-memory state is enough here

Everything — connected clients, usernames, and message history — lives in
plain JavaScript objects in the server process's memory rather than a
database. For a LAN chat room, this is a deliberate simplicity trade-off:
it means zero setup (no DB to install or configure) and it works great for
the lifetime of one server run, but it also means **restarting the server
clears all history and disconnects everyone**, and the app is scoped to a
single process (it wouldn't survive being load-balanced across multiple
server instances without adding shared storage).
