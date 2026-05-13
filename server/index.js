require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Readable } = require('stream');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { Server } = require('socket.io');

// curl.exe uses Windows Schannel TLS instead of Node's OpenSSL, giving a different JA3 fingerprint
// that bypasses some CDN bot-detection filters that block Node.js fetch
function curlHeaders(headers) {
  const args = [];
  for (const [k, v] of Object.entries(headers)) {
    args.push('-H', `${k}: ${v}`);
  }
  return args;
}

async function curlGet(url, headers) {
  const args = [
    '-s', '--fail', '-L', '--compressed', '--max-time', '15',
    ...curlHeaders(headers),
    url,
  ];
  const { stdout } = await execFileAsync('curl.exe', args, { maxBuffer: 20 * 1024 * 1024, encoding: 'utf8' });
  return stdout;
}

function curlStream(url, headers, res) {
  const args = [
    '-s', '--fail', '-L', '--max-time', '30',
    ...curlHeaders(headers),
    url,
  ];
  const child = spawn('curl.exe', args);
  child.stdout.pipe(res);
  child.on('error', () => res.status(500).end());
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.json());

// Tracks each channel's state
const rooms = {};
// Tracks which socket belongs to which user
const users = {};

app.post('/api/token', async (req, res) => {
  const { code } = req.body;
  const response = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
    }),
  });
  const data = await response.json();
  res.json({ access_token: data.access_token });
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', ({ channelId, username }) => {
    socket.join(channelId);

    // Remember this user's info
    users[socket.id] = { channelId, username };

    // Initialize room if it doesn't exist
    if (!rooms[channelId]) {
      rooms[channelId] = {
        hostId: null,
        hostName: null,
        members: [],
        streamUrl: null,
        referer: null,
        isLive: false,
      };
    }

    const room = rooms[channelId];
    room.members.push({ id: socket.id, username });

    // First person in the room becomes host
    if (!room.hostId) {
      room.hostId = socket.id;
      room.hostName = username;
    }

    // Tell everyone in the room who the host is
    // Each socket gets told whether they personally are the host
    room.members.forEach(({ id }) => {
      io.to(id).emit('host-assigned', {
        hostName: room.hostName,
        isYou: id === room.hostId,
      });
    });

    // Catch up the new joiner if a stream is already playing
    if (room.streamUrl) {
      socket.emit('stream-updated', {
        url: room.streamUrl,
        live: room.isLive,
        referer: room.referer,
      });
    }

    console.log(`${username} joined room ${channelId}`);
  });

  socket.on('set-stream', ({ channelId, url, live, referer }) => {
    const room = rooms[channelId];
    if (!room || socket.id !== room.hostId) return; // Only host can set stream
    room.streamUrl = url;
    room.referer = referer || null;
    room.isLive = live;
    io.to(channelId).emit('stream-updated', { url, live, referer: room.referer });
  });

  socket.on('sync-state', ({ channelId, playing, timestamp }) => {
    const room = rooms[channelId];
    if (!room || socket.id !== room.hostId) return; // Only host can sync
    socket.to(channelId).emit('state-update', { playing, timestamp });
  });

  socket.on('disconnect', () => {
    const user = users[socket.id];
    if (!user) return;

    const { channelId, username } = user;
    const room = rooms[channelId];
    if (!room) return;

    // Remove user from room
    room.members = room.members.filter((m) => m.id !== socket.id);
    delete users[socket.id];

    console.log(`${username} left room ${channelId}`);

    // If room is empty, clean it up
    if (room.members.length === 0) {
      delete rooms[channelId];
      return;
    }

    // If the host left, assign the next person as host
    if (room.hostId === socket.id) {
      const newHost = room.members[0];
      room.hostId = newHost.id;
      room.hostName = newHost.username;

      // Tell everyone about the new host
      room.members.forEach(({ id }) => {
        io.to(id).emit('host-assigned', {
          hostName: room.hostName,
          isYou: id === room.hostId,
        });
      });

      console.log(`${newHost.username} is the new host of ${channelId}`);
    }
  });
});

// M3U8 Proxy — fetches and rewrites the playlist
app.get('/m3u8', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('No URL provided');

  try {
    const referer = req.query.referer || new URL(url).origin;
    console.log(`M3U8 proxy fetching: ${url}`);
    console.log(`  Referer: ${referer}`);
    const origin = req.query.referer ? new URL(req.query.referer).origin : new URL(url).origin;

    const text = await curlGet(url, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer': referer,
      'Origin': origin,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
    });
    const base = url.substring(0, url.lastIndexOf('/') + 1);
    const encodedReferer = req.query.referer ? `&referer=${encodeURIComponent(req.query.referer)}` : '';

    // Sub-playlists (.m3u8) go through the M3U8 proxy so their chunks get rewritten too.
    // Actual segments go through the chunk proxy.
    const rewritten = text.split('\n').map(line => {
      if (line.startsWith('#') || line.trim() === '') return line;
      const segmentUrl = line.trim().startsWith('http') ? line.trim() : base + line.trim();
      if (segmentUrl.includes('.m3u8')) {
        return `/m3u8?url=${encodeURIComponent(segmentUrl)}${encodedReferer}`;
      }
      return `/chunk?url=${encodeURIComponent(segmentUrl)}`;
    }).join('\n');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(rewritten);
  } catch (err) {
    console.error('M3U8 proxy error:', err.message);
    res.status(502).send(`Upstream blocked or unreachable: ${err.message}`);
  }
});

// Chunk Proxy — fetches individual .ts segments via curl (Schannel TLS)
app.get('/chunk', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('No URL provided');

  res.setHeader('Content-Type', 'video/MP2T');
  res.setHeader('Access-Control-Allow-Origin', '*');

  curlStream(url, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': new URL(url).origin,
    'Accept': '*/*',
  }, res);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));