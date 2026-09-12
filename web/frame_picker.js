// The frame picker: a modal over a <video> that lets the user find a scene
// and capture the frame being shown, at the video's native size. The video
// is a session-only helper (see multi_stitch.js); every capture is handed to
// `hooks.onCapture(canvas, time)`, which uploads it as an ordinary image.
import { api } from "../../scripts/api.js";
import { imageUrl } from "./shared.js";

const DEFAULT_FRAME_DURATION = 1 / 30;
// Server mode: frames come from PyAV on the ComfyUI server instead of the
// browser's decoder — the way in for a codec the browser cannot play, and
// an option for a decoder-exact frame when it can.
const SERVER_INFO_ROUTE = "/multi_stitch/video/info";
const SERVER_FRAME_ROUTE = "/multi_stitch/video/frame";
const SERVER_CAPTURE_ROUTE = "/multi_stitch/video/capture";
const SERVER_PREVIEW_SIDE = 720;
const SERVER_PREVIEW_DELAY_MS = 120;

let styleInstalled = false;

function installStyles() {
    if (styleInstalled) return;
    styleInstalled = true;
    const style = document.createElement("style");
    style.textContent = `
.ms-video-overlay{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.ms-video-panel{width:min(1140px,96vw);max-height:94vh;background:#202124;border:1px solid #555;border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.55);display:flex;flex-direction:column;overflow:hidden;color:#eee}
.ms-video-head{display:flex;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid #3d3d3d;font-weight:650}
.ms-video-head .info{font-size:12px;color:#aaa;font-weight:400}
.ms-video-stage{min-height:240px;display:flex;align-items:center;justify-content:center;padding:12px;background:#111}
.ms-video-stage video{max-width:100%;max-height:60vh;background:#000}
.ms-video-stage .server-frame{max-width:100%;max-height:56vh;background:#000;display:none}
.ms-video-stage .server-box{display:none;flex-direction:column;align-items:center;gap:8px;width:100%}
.ms-video-stage .server-scrub{width:min(900px,90%)}
.ms-video-controls label.server-toggle{font-size:12px;color:#cfcfcf;display:flex;gap:6px;align-items:center}
.ms-video-controls{display:flex;flex-wrap:wrap;gap:9px;align-items:center;padding:12px 16px;border-top:1px solid #3d3d3d}
.ms-video-controls button,.ms-video-controls input{background:#303134;color:#eee;border:1px solid #5f6368;border-radius:7px;padding:7px 11px;font-size:13px}
.ms-video-controls button{cursor:pointer}.ms-video-controls button:hover{background:#3c4043}
.ms-video-controls button:disabled{opacity:.45;cursor:default}
.ms-video-controls .primary{background:#1a73e8;border-color:#1a73e8}.ms-video-controls .danger{border-color:#a55}
.ms-video-controls input.fps{width:64px}
.ms-video-time{font-variant-numeric:tabular-nums;min-width:150px;font-size:13px;color:#cfcfcf}
.ms-video-spacer{flex:1}.ms-video-hint{font-size:12px;color:#aaa}
.ms-video-status{font-size:12px;color:#8ab4f8;min-height:16px;padding:0 16px 8px}
.ms-video-status.error{color:#f08a8a}
.ms-video-captures{display:flex;gap:8px;padding:0 16px 12px;overflow-x:auto;min-height:0}
.ms-video-captures .shot{display:flex;flex-direction:column;align-items:center;gap:3px;font-size:11px;color:#bbb}
.ms-video-captures canvas{height:64px;border:1px solid #444;background:#000}
`;
    document.head?.appendChild?.(style);
}

export function formatTime(seconds) {
    const value = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    const minutes = Math.floor(value / 60);
    const rest = value - minutes * 60;
    return `${String(minutes).padStart(2, "0")}:${rest.toFixed(3).padStart(6, "0")}`;
}

// The frame a <video> is showing, copied at its native size.
export function captureVideoFrame(video) {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw new Error("The video has no frame to capture yet.");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(video, 0, 0, width, height);
    return canvas;
}

export function canvasToPngFile(canvas, name) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (blob) => (blob ? resolve(new File([blob], name, { type: "image/png" })) : reject(new Error("Could not encode the frame as PNG."))),
            "image/png",
        );
    });
}

// clip.mp4 at 12.345s → clip_12s345.png (the upload adds its own prefix).
export function captureFileName(entry, time) {
    const stem = String(entry?.name || entry?.filename || "video")
        .replace(/\.[^.]+$/, "")
        .replace(/[^\w.-]+/g, "_")
        .slice(0, 40) || "video";
    const seconds = Math.max(0, Number(time) || 0);
    return `${stem}_${seconds.toFixed(3).replace(".", "s")}.png`;
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Opens the picker for a video entry. Returns handles the caller (and the
// tests) can drive: seekTo, step, capture, close. Hooks:
//   onCapture(canvas, time) → the added item (may throw to report a failure)
//   onDone()                → the user finished with this video: remove it
//   onClose(removed)        → the overlay is gone
export function openFramePicker(node, entry, hooks = {}) {
    installStyles();

    const overlay = document.createElement("div");
    overlay.className = "ms-video-overlay";
    overlay.innerHTML = `
      <div class="ms-video-panel" role="dialog" aria-modal="true">
        <div class="ms-video-head">
          <span>Capture frames — ${escapeHtml(entry.name || entry.filename || "video")}</span>
          <span class="info">loading…</span>
        </div>
        <div class="ms-video-stage">
          <video controls muted playsinline preload="auto"></video>
          <div class="server-box"><img class="server-frame" alt=""><input class="server-scrub" type="range" min="0" max="1000" step="1" value="0"></div>
        </div>
        <div class="ms-video-controls">
          <button class="step-back10" title="10 frames back (Shift+←)">⏮ 10</button>
          <button class="step-back" title="Previous frame (←)">◀ 1</button>
          <button class="play" title="Play / pause (Space)">▶ / ❚❚</button>
          <button class="step-fwd" title="Next frame (→)">1 ▶</button>
          <button class="step-fwd10" title="10 frames forward (Shift+→)">10 ⏭</button>
          <span class="ms-video-time">00:00.000</span>
          <label class="ms-video-hint">fps <input class="fps" type="number" min="1" max="240" step="0.001" placeholder="auto"></label>
          <label class="server-toggle" title="Decode the frame on the ComfyUI server (PyAV): exact to the frame, any codec ffmpeg reads"><input class="server-capture" type="checkbox"> server capture</label>
          <span class="ms-video-spacer"></span>
          <button class="primary capture" title="Capture this frame (Enter)">Capture</button>
          <button class="capture-done" title="Capture this frame, then remove the video">Capture &amp; Done</button>
          <button class="danger done" title="Remove the video from the server; captured frames stay">Done — remove video</button>
          <button class="close" title="Keep the video for more captures later (Esc)">Keep &amp; close</button>
        </div>
        <div class="ms-video-status"></div>
        <div class="ms-video-captures"></div>
      </div>`;
    if (typeof overlay.querySelector !== "function") throw new Error("The frame picker needs a browser DOM.");
    document.body.appendChild(overlay);

    const video = overlay.querySelector("video");
    const serverBox = overlay.querySelector(".server-box");
    const serverFrame = overlay.querySelector(".server-frame");
    const serverScrub = overlay.querySelector(".server-scrub");
    const serverToggle = overlay.querySelector("input.server-capture");
    const info = overlay.querySelector(".info");
    const timeLabel = overlay.querySelector(".ms-video-time");
    const status = overlay.querySelector(".ms-video-status");
    const captures = overlay.querySelector(".ms-video-captures");
    const fpsInput = overlay.querySelector("input.fps");
    const captureButton = overlay.querySelector(".capture");
    const captureDoneButton = overlay.querySelector(".capture-done");

    const state = {
        mediaTime: 0,
        duration: 0,
        detectedFrameDuration: null,
        busy: false,
        closed: false,
        captures: 0,
        probed: false,
        probing: false,
        pendingStep: null,
        hasFrameCallback: typeof video.requestVideoFrameCallback === "function",
        // Server mode (PyAV): `active` replaces the <video> with server-rendered
        // previews; `capture` alone asks the server for the frame while the
        // browser keeps showing the video.
        server: { active: false, capture: false, available: null, info: null, time: 0, request: 0, timer: null },
    };
    const samples = [];
    let lastPlayingTime = null;

    const flash = (message, isError = false) => {
        status.textContent = message || "";
        status.className = `ms-video-status${isError ? " error" : ""}`;
    };
    const server = state.server;
    const duration = () => {
        if (server.active) return server.info?.duration || 0;
        return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : state.duration;
    };
    const frameDuration = () => {
        const typed = Number(fpsInput.value);
        if (typed > 0) return 1 / typed;
        if (server.active && server.info?.fps > 0) return 1 / server.info.fps;
        return state.detectedFrameDuration || DEFAULT_FRAME_DURATION;
    };
    const currentTime = () => {
        if (server.active) return server.time;
        return state.hasFrameCallback ? state.mediaTime : (video.currentTime || 0);
    };
    const updateTime = () => {
        const fd = frameDuration();
        const t = currentTime();
        timeLabel.textContent = `${formatTime(t)}  ·  frame ${Math.round(t / fd)}`;
    };
    const updateInfo = () => {
        const parts = [];
        const width = server.active ? server.info?.width : video.videoWidth;
        const height = server.active ? server.info?.height : video.videoHeight;
        if (width) parts.push(`${width}×${height}`);
        if (duration() > 0) parts.push(formatTime(duration()));
        const fps = 1 / frameDuration();
        const fpsNote = fpsInput.value ? "" : server.active ? " (server)" : state.detectedFrameDuration ? " (detected)" : " (assumed)";
        parts.push(`${Number.isInteger(fps) ? fps : fps.toFixed(3)} fps${fpsNote}`);
        if (server.active) parts.push("server decode");
        parts.push(`${state.captures} captured`);
        info.textContent = parts.join("  ·  ");
    };

    // --- server mode -------------------------------------------------------
    const serverQuery = (extra = {}) => new URLSearchParams({ filename: entry.filename, ...extra }).toString();
    const fetchServerInfo = async () => {
        if (server.info) return server.info;
        if (server.available === false) return null;
        try {
            const response = await api.fetchApi(`${SERVER_INFO_ROUTE}?${serverQuery()}`);
            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                server.available = false;
                server.error = body?.error || `server decode unavailable (${response.status})`;
                return null;
            }
            server.info = body;
            server.available = true;
            return body;
        } catch (error) {
            server.available = false;
            server.error = String(error?.message || error);
            return null;
        }
    };
    const showServerFrame = () => {
        clearTimeout(server.timer);
        server.timer = setTimeout(() => {
            server.timer = null;
            server.request += 1;
            serverFrame.src = api.apiURL(`${SERVER_FRAME_ROUTE}?${serverQuery({
                time: server.time.toFixed(3), max_side: String(SERVER_PREVIEW_SIDE), r: String(server.request),
            })}`);
        }, SERVER_PREVIEW_DELAY_MS);
    };
    const serverSeek = (time) => {
        const max = server.info?.duration > 0 ? Math.max(0, server.info.duration - 0.001) : Math.max(0, time);
        server.time = Math.max(0, Math.min(max, time));
        if (server.info?.duration > 0) serverScrub.value = String(Math.round(server.time / server.info.duration * 1000));
        updateTime();
        showServerFrame();
    };
    const enterServerMode = async (reason) => {
        if (server.active) return true;
        const meta = await fetchServerInfo();
        if (state.closed) return false;
        if (!meta) {
            flash(`${reason} — and the server cannot decode it either (${server.error || "PyAV unavailable"}). Convert it to MP4 (H.264) or WebM.`, true);
            captureButton.disabled = captureDoneButton.disabled = true;
            return false;
        }
        server.active = true;
        server.capture = true;
        serverToggle.checked = true;
        serverToggle.disabled = true;
        try { video.pause?.(); } catch (_) { /* switching decoders */ }
        video.style.display = "none";
        serverBox.style.display = "flex";
        serverFrame.style.display = "block";
        entry.width = meta.width || entry.width;
        entry.height = meta.height || entry.height;
        entry.duration = meta.duration || entry.duration;
        captureButton.disabled = captureDoneButton.disabled = false;
        flash(`${reason}: frames are decoded on the server (PyAV) instead.`);
        serverSeek(Math.min(server.time, meta.duration || 0));
        updateInfo();
        return true;
    };
    const captureOnServer = async (time) => {
        const response = await api.fetchApi(SERVER_CAPTURE_ROUTE, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: entry.filename, time }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body?.error || `server capture failed (${response.status})`);
        return body;
    };
    serverScrub.addEventListener("input", () => {
        if (server.info?.duration > 0) serverSeek(Number(serverScrub.value) / 1000 * server.info.duration);
    });
    serverFrame.addEventListener("error", () => {
        if (server.active) flash("The server could not render this frame.", true);
    });
    serverToggle.addEventListener("change", async () => {
        if (server.active) return;
        if (!serverToggle.checked) {
            server.capture = false;
            flash("");
            return;
        }
        const meta = await fetchServerInfo();
        if (!meta) {
            serverToggle.checked = false;
            server.capture = false;
            flash(`Server capture unavailable: ${server.error || "PyAV is not installed on the server"}.`, true);
            return;
        }
        server.capture = true;
        flash("Captures are decoded on the server at the frame shown (exact to the frame).");
    });
    const setServerCapture = async (on) => {
        serverToggle.checked = !!on;
        await serverToggle.handlers?.change?.[0]?.() ?? serverToggle.dispatchEvent?.(new Event("change"));
        return server.capture;
    };

    const onFrame = (_now, metadata) => {
        if (state.closed) return;
        state.mediaTime = metadata.mediaTime;
        if (!video.paused && !video.seeking && lastPlayingTime !== null) {
            const delta = metadata.mediaTime - lastPlayingTime;
            if (delta > 0.0005 && delta < 1) samples.push(delta);
            if (samples.length >= 6) {
                state.detectedFrameDuration = median(samples.slice(-24));
                updateInfo();
            }
        }
        lastPlayingTime = video.paused || video.seeking ? null : metadata.mediaTime;
        updateTime();
        video.requestVideoFrameCallback(onFrame);
    };
    if (state.hasFrameCallback) video.requestVideoFrameCallback(onFrame);

    const maxTime = () => (duration() > 0 ? Math.max(0, duration() - 0.001) : Number.POSITIVE_INFINITY);
    const seekTo = (time) => {
        state.pendingStep = null;
        if (server.active) {
            serverSeek(time);
            return;
        }
        video.pause?.();
        video.currentTime = Math.max(0, Math.min(maxTime(), time));
    };
    // With frame metadata the current time is the frame's own timestamp, so
    // aim at the middle of the target frame; without it, plain time steps.
    // If the frame rate is only assumed and the seek lands on the same frame,
    // the seeked handler nudges further until the picture actually changes.
    const step = (frames) => {
        const fd = frameDuration();
        const from = currentTime();
        if (server.active) {
            // Server frames sit exactly on the frame grid: land in the middle.
            const index = Math.round(from / fd) + frames;
            serverSeek(Math.max(0, index) * fd + fd / 2);
            return;
        }
        seekTo(from + frames * fd + (state.hasFrameCallback ? fd / 2 : 0));
        if (state.hasFrameCallback) state.pendingStep = { from, direction: Math.sign(frames) || 1, tries: 0 };
    };
    // Play muted for a moment once the video is ready, read the frame
    // timestamps as they go by, and rewind: the frame rate for stepping.
    const probeFrameRate = async () => {
        if (!state.hasFrameCallback || state.probed || state.closed) return;
        state.probed = true;
        state.probing = true;
        const start = video.currentTime || 0;
        try {
            const playing = video.play?.();
            if (playing?.catch) playing.catch(() => {});
            const until = Date.now() + 900;
            while (samples.length < 8 && Date.now() < until && !state.closed) {
                await new Promise((resolve) => setTimeout(resolve, 40));
            }
        } catch (_) { /* detection is a nicety; the fps field remains */ }
        finally {
            video.pause?.();
            if (!state.closed) seekTo(start);
            state.probing = false;
            updateInfo();
        }
    };
    const maybeProbe = () => {
        if (duration() > 0 && video.readyState >= 2) probeFrameRate();
    };
    const togglePlay = () => {
        if (server.active) return;
        if (video.paused) video.play?.()?.catch?.(() => {});
        else video.pause?.();
    };

    const addShot = (source, time) => {
        const shot = document.createElement("div");
        shot.className = "shot";
        const thumb = document.createElement("canvas");
        const sourceW = source.naturalWidth || source.width || 1;
        const sourceH = source.naturalHeight || source.height || 1;
        const scale = Math.min(1, 64 / Math.max(1, sourceH));
        thumb.width = Math.max(1, Math.round(sourceW * scale));
        thumb.height = Math.max(1, Math.round(sourceH * scale));
        try {
            thumb.getContext("2d").drawImage(source, 0, 0, thumb.width, thumb.height);
        } catch (_) { /* a preview that has not loaded yet: the strip entry stays blank */ }
        const label = document.createElement("span");
        label.textContent = formatTime(time);
        shot.append(thumb, label);
        captures.appendChild(shot);
    };

    const capture = async () => {
        if (state.busy) return null;
        const onServer = server.active || server.capture;
        if (!onServer && video.readyState < 2) {
            flash("The video is still loading.", true);
            return null;
        }
        const time = currentTime();
        let canvas = null;
        if (!onServer) {
            try {
                canvas = captureVideoFrame(video);
            } catch (error) {
                flash(String(error?.message || error), true);
                return null;
            }
        }
        state.busy = true;
        captureButton.disabled = captureDoneButton.disabled = true;
        flash(`Capturing ${formatTime(time)}${onServer ? " on the server" : ""}…`);
        try {
            let item;
            if (onServer) {
                const data = await captureOnServer(time);
                item = await hooks.onServerFrame?.(data, time);
                canvas = server.active ? serverFrame : safeVideoSnapshot(video);
            } else {
                item = await hooks.onCapture?.(canvas, time);
            }
            state.captures += 1;
            if (canvas) addShot(canvas, time);
            updateInfo();
            flash(`Captured ${formatTime(time)} — image ${node._msImages?.length || state.captures} in the list.`);
            return item ?? canvas ?? true;
        } catch (error) {
            flash(String(error?.message || error), true);
            return null;
        } finally {
            state.busy = false;
            captureButton.disabled = captureDoneButton.disabled = false;
        }
    };

    let keyHandler = null;
    const close = (removeVideo = false) => {
        if (state.closed) return;
        state.closed = true;
        clearTimeout(server.timer);
        if (keyHandler) document.removeEventListener("keydown", keyHandler);
        try {
            video.pause?.();
            video.removeAttribute?.("src");
            video.load?.();
        } catch (_) { /* the element is going away anyway */ }
        overlay.remove();
        if (removeVideo) hooks.onDone?.();
        hooks.onClose?.(removeVideo);
    };

    video.addEventListener("loadedmetadata", () => {
        entry.width = video.videoWidth;
        entry.height = video.videoHeight;
        if (Number.isFinite(video.duration)) {
            state.duration = video.duration;
            entry.duration = video.duration;
        } else {
            // A recorded stream reports no length until its end has been
            // seen: seek past it once, then come back.
            const onDurationChange = () => {
                if (!Number.isFinite(video.duration) || video.duration <= 0) return;
                video.removeEventListener("durationchange", onDurationChange);
                state.duration = video.duration;
                entry.duration = video.duration;
                video.currentTime = 0;
                updateInfo();
                maybeProbe();
            };
            video.addEventListener("durationchange", onDurationChange);
            video.currentTime = 1e6;
        }
        info.textContent = "";
        updateInfo();
        updateTime();
    });
    video.addEventListener("canplay", maybeProbe);
    video.addEventListener("seeked", () => {
        if (!state.hasFrameCallback) state.mediaTime = video.currentTime;
        updateTime();
        const pending = state.pendingStep;
        if (!pending) return;
        setTimeout(() => {
            if (state.closed || state.pendingStep !== pending) return;
            if (Math.abs(currentTime() - pending.from) < 1e-4 && pending.tries < 8) {
                pending.tries += 1;
                video.currentTime = Math.max(0, Math.min(maxTime(), (video.currentTime || 0) + pending.direction * frameDuration()));
            } else {
                state.pendingStep = null;
            }
        }, 60);
    });
    video.addEventListener("timeupdate", () => { if (!state.hasFrameCallback) { state.mediaTime = video.currentTime; updateTime(); } });
    video.addEventListener("error", () => {
        captureButton.disabled = captureDoneButton.disabled = true;
        enterServerMode("This browser cannot play the video");
    });
    fpsInput.addEventListener("input", () => { updateInfo(); updateTime(); });

    overlay.querySelector(".step-back10").onclick = () => step(-10);
    overlay.querySelector(".step-back").onclick = () => step(-1);
    overlay.querySelector(".step-fwd").onclick = () => step(1);
    overlay.querySelector(".step-fwd10").onclick = () => step(10);
    overlay.querySelector(".play").onclick = togglePlay;
    captureButton.onclick = () => { capture(); };
    captureDoneButton.onclick = async () => { if (await capture()) close(true); };
    overlay.querySelector(".done").onclick = () => close(true);
    overlay.querySelector(".close").onclick = () => close(false);
    overlay.addEventListener("mousedown", (event) => {
        if (event.target === overlay) close(false);
    });

    keyHandler = (event) => {
        if (event.target === fpsInput) return;
        if (event.key === "Escape") close(false);
        else if (event.key === "ArrowLeft") { step(event.shiftKey ? -10 : -1); event.preventDefault(); }
        else if (event.key === "ArrowRight") { step(event.shiftKey ? 10 : 1); event.preventDefault(); }
        else if (event.key === "Enter") { capture(); event.preventDefault(); }
        else if (event.key === " ") { togglePlay(); event.preventDefault(); }
    };
    document.addEventListener("keydown", keyHandler);

    if (entry.serverOnly) {
        // The poster load already showed the browser cannot decode this file.
        enterServerMode("This browser cannot play the video");
    } else {
        video.src = entry.url || imageUrl(entry);
    }
    updateTime();

    return {
        overlay, video, state, seekTo, step, capture, close, currentTime, frameDuration,
        serverFrame, enterServerMode, setServerCapture,
    };
}

// A copy of the frame the <video> shows, or null when it has none to give.
function safeVideoSnapshot(video) {
    try {
        return captureVideoFrame(video);
    } catch (_) {
        return null;
    }
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
