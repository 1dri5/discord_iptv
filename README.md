# Discord IPTV

<img width="1353" height="1067" alt="Screenshot 2026-05-13 012216" src="https://github.com/user-attachments/assets/5d96cb0f-ac2a-4621-8d8e-f920a202ceca" />

## Overview

Discord IPTV is a Discord Activity — an app that runs directly inside a Discord voice channel — that lets a group of people watch HLS/M3U8 streams together in sync.

One person in the channel acts as the host. They paste a stream URL and control playback. Everyone else watches the same stream at the same time, with play, pause, and seek automatically synced across all viewers.

Unlike screen sharing, which encodes and transmits the host's screen in real time and can lag or lose quality under network pressure, Discord IPTV works like Discord's own "Watch Together" Activity — each viewer loads the stream directly. Everyone sees it at full quality with no added delay, regardless of the host's connection.

I personally use the app to watch football matches with friends. It also supports direct video file links (MP4, WebM, OGG), so for example if you can find a direct download link to a movie, you can paste it and watch it together.

For a legal source of public IPTV channels, check out [m3u8-player.net/public-iptv-playlist](https://m3u8-player.net/public-iptv-playlist/). Other sources exist but many are illegal, so I can't link them here.

---

## How it works

The app has two parts: a **React frontend** and a **Node.js backend**, connected in real time via Socket.io.

### Discord Activity

The app runs as a Discord Activity using the Discord Embedded App SDK. When a user opens it inside a voice channel, the app authenticates them through Discord's OAuth2 flow — no separate login needed. Discord provides each user's identity and channel ID automatically.

### Room and host system

When users open the Activity in the same voice channel, the server groups them into a room identified by the channel ID. The first person to open it becomes the host. If the host leaves, the next person in the room automatically takes over.

### Playback sync

Only the host can set the stream URL and control playback. When the host plays, pauses, or seeks, the server receives the event and immediately broadcasts the updated state to all other viewers, who apply the change on their end.

### HLS proxy

HLS (HTTP Live Streaming) is the format used by most IPTV streams. Each channel has a `.m3u8` URL that the video player uses to load the stream. Note that this is different from `.m3u` playlist files, which list multiple channels — those don't work here. You need the direct `.m3u8` link for a specific channel.

Most HLS streams can't be loaded directly in the browser — either because of CORS restrictions or CDN bot-detection. The server acts as a proxy: it fetches the stream on behalf of the client and forwards it back, bypassing both issues.

### Cloudflare tunnel

Discord Activities require a publicly accessible HTTPS URL. A Cloudflare tunnel is used to expose the local server to the internet without any deployment or port forwarding.

---

## Setup guide

Since this app hasn't gone through Discord's official approval process, it can't be installed like a normal Discord bot or Activity. Instead, it runs as a developer application — meaning you have to set it up and run it yourself. The process involves a few steps across Discord, your terminal, and your code editor, but follow them in order and it works.

> **Note:** This app currently only runs on **Windows**. The HLS proxy relies on `curl.exe` with Windows' native Schannel TLS stack to bypass CDN restrictions — this is not compatible with Mac or Linux without modifications.

What you'll need:
- [Git](https://git-scm.com/downloads) installed
- [Node.js](https://nodejs.org) installed
- [Cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) installed
- A Discord account with access to the [Discord Developer Portal](https://discord.com/developers/applications)

### Step 1 — Get the code

Clone the repository and install dependencies for both the client and server:

```bash
git clone https://github.com/1dri5/discord_iptv.git
cd discord-iptv

cd server && npm install
cd ../client && npm install
```

### Step 2 — Create a Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**
2. Give it a name and confirm
3. In the left sidebar, go to **OAuth2**, copy your **Client ID** and **Client Secret** — you'll need these later
4. Still in **OAuth2**, add the following redirect URL: `https://YOUR_CLIENT_ID.discordsays.com` (replace with your actual Client ID)
5. In the left sidebar, go to **Activities** and enable it for your application

### Step 3 — Configure environment variables

Create a `.env` file in the `server/` folder:

```
CLIENT_ID=your_client_id
CLIENT_SECRET=your_client_secret
PORT=3000
```

Create a `.env` file in the `client/` folder:

```
VITE_CLIENT_ID=your_client_id
```

### Step 4 — Start the Cloudflare tunnel

In a terminal, run:

```bash
cloudflared tunnel --url localhost:5173
```

Once it starts, it will print a public URL that looks like `https://something-random.trycloudflare.com` — copy it, you'll need it in the next two steps.

### Step 5 — Update the code with your tunnel URL

Paste your tunnel URL (without `https://`) in two places:

**`client/src/App.jsx`** — update both targets in `patchUrlMappings`:
```js
patchUrlMappings([
  { prefix: "/socket", target: "something-random.trycloudflare.com" },
  { prefix: "/proxy", target: "something-random.trycloudflare.com" },
]);
```

**`client/vite.config.js`** — update `allowedHosts`:
```js
allowedHosts: ['something-random.trycloudflare.com'],
```

> The tunnel URL changes every time you restart `cloudflared`, so you'll need to repeat this step each session.

### Step 6 — Configure URL mappings in the Discord Developer Portal

In your application's **Activities** section, scroll down to **URL Mappings**. This tells Discord how to route requests from inside the Activity to your server.

Set up the following mappings (all targets are your tunnel URL without `https://`):

| Prefix | Target |
|--------|--------|
| `/` | `something-random.trycloudflare.com` |
| `/socket` | `something-random.trycloudflare.com` |
| `/proxy` | `something-random.trycloudflare.com` |
| `/token` | `something-random.trycloudflare.com` |

> Like the previous step, these need to be updated every time your tunnel URL changes.

### Step 7 — Start the server and client

Open two terminals and run each command in its own:

**Terminal 1 — Express server**
```bash
cd server
node index.js
```

**Terminal 2 — Vite client**
```bash
cd client
npm run dev
```

### Step 8 — Enable Developer Mode and launch

1. In Discord, go to **User Settings → Advanced** and enable **Developer Mode**
2. Join a voice channel — your Activity should now appear in the Activities menu
3. Launch it and you're good to go

**Important:** Since the app is not publicly approved by Discord, only people added to your application's development team can use it. To add someone, go to your application in the [Discord Developer Portal](https://discord.com/developers/applications), navigate to **App Testers**, and add them by their Discord username.
