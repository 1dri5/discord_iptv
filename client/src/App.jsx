import { useEffect, useRef, useState, useCallback } from "react";
import { DiscordSDK, patchUrlMappings } from "@discord/embedded-app-sdk";
import { io } from "socket.io-client";
import Hls from "hls.js";
import "./App.css";

patchUrlMappings([
  { prefix: "/socket", target: "pickup-proxy-answer-cooler.trycloudflare.com" },
  { prefix: "/proxy", target: "pickup-proxy-answer-cooler.trycloudflare.com" },
]);

const discordSdk = new DiscordSDK(import.meta.env.VITE_CLIENT_ID);
const socket = io({ path: "/socket/socket.io" });

export default function App() {
  const [streamUrl, setStreamUrl] = useState("");
  const [inputUrl, setInputUrl] = useState("");
  const [isReady, setIsReady] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [hostName, setHostName] = useState("");
  const [isLive, setIsLive] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const toastTimer = useRef(null);

  useEffect(() => {
    async function setup() {
      try {
        await discordSdk.ready();

        const { code } = await discordSdk.commands.authorize({
          client_id: import.meta.env.VITE_CLIENT_ID,
          response_type: "code",
          state: "",
          prompt: "none",
          scope: ["identify"],
        });

        const response = await fetch("/.proxy/token/api/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
        const { access_token } = await response.json();

        const auth = await discordSdk.commands.authenticate({ access_token });
        const username = auth.user.username;
        const channelId = discordSdk.channelId;

        socket.emit("join-room", { channelId, username });
        setIsReady(true);
      } catch (err) {
        console.error("Setup failed:", err);
      }
    }
    setup();
  }, []);

  useEffect(() => {
    socket.on("host-assigned", ({ hostName, isYou }) => {
      setHostName(hostName);
      setIsHost(isYou);
    });

    socket.on("stream-updated", ({ url, live }) => {
      setStreamUrl(url);
      setIsLive(live);
      setIsPaused(false);
    });

    socket.on("state-update", ({ playing, timestamp }) => {
      const video = videoRef.current;
      if (!video) return;
      if (!playing && !isLive) {
        video.currentTime = timestamp;
        video.pause();
        setIsPaused(true);
      } else {
        video.play();
        setIsPaused(false);
      }
    });

    return () => {
      socket.off("host-assigned");
      socket.off("stream-updated");
      socket.off("state-update");
    };
  }, [isLive]);

  // Load stream into video element using HLS.js if needed
  useEffect(() => {
    if (!streamUrl || !videoRef.current) return;

    const video = videoRef.current;

    // Destroy previous HLS instance
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const isM3U8 = streamUrl.includes('.m3u8') || streamUrl.includes('/proxy/m3u8');

    if (isM3U8) {
      const proxiedUrl = `/proxy/m3u8?url=${encodeURIComponent(streamUrl)}`;

      if (Hls.isSupported()) {
        function createHls(url, direct = false) {
          const hls = new Hls({
            xhrSetup: direct ? (xhr) => { xhr.referrerPolicy = 'no-referrer'; } : undefined,
          });
          hlsRef.current = hls;
          hls.loadSource(url);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => video.play());
          // Use HLS.js live detection instead of URL pattern — correctly handles VOD .m3u8 files
          hls.on(Hls.Events.LEVEL_UPDATED, (_, data) => {
            setIsLive(data.details.live);
          });
          hls.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal && data.details === 'manifestLoadError' && !direct) {
              // Server proxy blocked (likely CDN TLS fingerprinting) — retry directly from browser
              console.warn('Proxy failed, retrying direct with no-referrer');
              hls.destroy();
              createHls(streamUrl, true);
            } else {
              console.error('HLS error:', data);
            }
          });
        }
        createHls(proxiedUrl);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari native HLS
        video.src = proxiedUrl;
        video.play();
      }
    } else {
      // Direct video file
      video.src = streamUrl;
      video.play();
    }
  }, [streamUrl]);

  function isLiveStream(url) {
    return url.match(/\.(m3u8)$/i) || url.includes("twitch.tv") || url.includes("kick.com");
  }

  function isDirectVideo(url) {
    return url.match(/\.(mp4|webm|ogg|m3u8)$/i);
  }

  function toEmbedUrl(url) {
    const parent = window.location.hostname;

    // Twitch: twitch.tv/channel → player.twitch.tv/?channel=...&parent=...
    const twitchMatch = url.match(/twitch\.tv\/([^/?]+)/);
    if (twitchMatch) {
      return `https://player.twitch.tv/?channel=${twitchMatch[1]}&parent=${parent}&autoplay=true`;
    }

    // YouTube watch: youtube.com/watch?v=ID or youtu.be/ID or youtube.com/live/ID
    const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/live\/)([^&/?]+)/);
    if (ytMatch) {
      return `https://www.youtube.com/embed/${ytMatch[1]}?autoplay=1`;
    }

    // Kick: kick.com/channel → kick.com/channel (supports iframes natively)
    if (url.includes('kick.com')) return url;

    return url;
  }

  function isEmbedUrl(url) {
    return url.includes('twitch.tv') || url.includes('youtube.com') || url.includes('youtu.be') || url.includes('kick.com');
  }

  function handleSubmit() {
    if (!inputUrl.trim()) return;
    const channelId = discordSdk.channelId;
    const live = isLiveStream(inputUrl);
    socket.emit("set-stream", { channelId, url: inputUrl, live });
    setStreamUrl(inputUrl);
    setIsLive(live);
    setInputUrl("");
  }

  function handlePlayPause(playing) {
    if (!isHost) return;
    const video = videoRef.current;
    const channelId = discordSdk.channelId;
    socket.emit("sync-state", {
      channelId,
      playing,
      timestamp: video ? video.currentTime : 0,
    });
    setIsPaused(!playing);
  }

  const snapToLive = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.buffered.length > 0) {
      video.currentTime = video.buffered.end(video.buffered.length - 1);
    }
    video.play();
    setIsPaused(false);
    setShowToast(true);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setShowToast(false), 3000);
  }, []);

  if (!isReady) {
    return <div className="loading">Connecting to Discord...</div>;
  }

  return (
    <div className="app">
      {showToast && (
        <div className="toast">⚡ Jumped back to live</div>
      )}

      <div className="player">
        {streamUrl ? (
          isEmbedUrl(streamUrl) ? (
            <iframe
              src={toEmbedUrl(streamUrl)}
              allowFullScreen
              allow="autoplay; encrypted-media"
            />
          ) : isDirectVideo(streamUrl) ? (
            <video
              ref={videoRef}
              controls={isHost && !isLive}
              autoPlay
              onPlay={() => handlePlayPause(true)}
              onPause={() => handlePlayPause(false)}
            />
          ) : (
            <video
              ref={videoRef}
              controls={isHost && !isLive}
              autoPlay
              onPlay={() => handlePlayPause(true)}
              onPause={() => handlePlayPause(false)}
            />
          )
        ) : (
          <div className="placeholder">
            <p>No stream loaded</p>
            {isHost && <p className="hint">Paste a URL below to get started</p>}
          </div>
        )}

        {isLive && isHost && streamUrl && (
          <button
            className="live-play-btn"
            onClick={() => {
              const v = videoRef.current;
              if (!v) return;
              isPaused ? v.play() : v.pause();
            }}
          >
            {isPaused ? "▶" : "⏸"}
          </button>
        )}

        {isLive && isPaused && (
          <button className="live-pill" onClick={snapToLive}>
            🔴 LIVE
          </button>
        )}
      </div>

      <div className="bottom-bar">
        <div className="host-info">
          <span className="crown">👑</span>
          <span className="host-name">{hostName}</span>
        </div>

        {isHost && (
          <div className="stream-input">
            <input
              type="text"
              placeholder="Paste stream URL (.m3u8, mp4, ...)"
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            />
            <button onClick={handleSubmit}>Stream</button>
          </div>
        )}
      </div>
    </div>
  );
}