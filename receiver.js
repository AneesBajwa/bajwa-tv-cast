/**
 * Bajwa TV custom Cast receiver. Runs hls.js — the SAME engine the app uses —
 * instead of CAF's built-in player, which can't sustain the provider's
 * per-request 302 redirect + short live window. `skipPlayersLoad` hands the
 * plain <video> to us; the LOAD interceptor returns a Promise that resolves on
 * MANIFEST_PARSED so CAF reports success without double-loading.
 * Pattern: https://rbf.dev/blog/2023/01/custom-player-cast-receiver-framework/
 */
/* global cast, Hls */
const context = cast.framework.CastReceiverContext.getInstance();
const playerManager = context.getPlayerManager();
const video = document.querySelector('video');

const idle = document.getElementById('idle');
const errorPanel = document.getElementById('error');
const errorText = document.getElementById('error-text');
const idleHint = idle.querySelector('.hint');

function show(el) {
    el.classList.remove('hidden');
}
function hide(el) {
    el.classList.add('hidden');
}
// Live status shown on the idle screen so the TV itself reports where playback
// is (Connecting / Buffering / Waiting for connection / error) instead of a
// static "Ready to cast" that hides whether it's stuck.
function setStatus(t) {
    if (idleHint) {
        idleHint.textContent = t;
    }
}

let hls = null;
let netRetries = 0;

let playbackStarted = false;
video.addEventListener('playing', () => {
    hide(idle);
    hide(errorPanel);
    playbackStarted = true;
});

playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    (request) => {
        const url = request.media && request.media.contentId;
        show(idle);
        hide(errorPanel);
        setStatus('Connecting…');
        if (!url) {
            return request;
        }
        const isHls = /\.m3u8(\?|$)/i.test(url) && window.Hls && Hls.isSupported();
        if (!isHls) {
            // Direct playback (MP4 VOD/series). skipPlayersLoad means no CAF
            // player, so drive the <video> ourselves.
            return new Promise((resolve) => {
                if (hls) {
                    hls.destroy();
                    hls = null;
                }
                video.src = url;
                video.play().catch(() => undefined);
                const ready = () => {
                    video.removeEventListener('loadeddata', ready);
                    resolve(request);
                };
                video.addEventListener('loadeddata', ready);
                video.onerror = () => {
                    errorText.textContent = 'Stream error';
                    show(errorPanel);
                    resolve(
                        new cast.framework.messages.ErrorData(
                            cast.framework.messages.ErrorType.LOAD_FAILED
                        )
                    );
                };
            });
        }
        return new Promise((resolve) => {
            if (hls) {
                hls.destroy();
                hls = null;
            }
            netRetries = 0;
            // liveDurationInfinity pins to the live edge; very generous retries
            // ride out BOTH the provider's flaky per-refresh redirect AND the
            // max_connections=1 slot cooldown after a hand-off from the app —
            // the first segments can 403 for ~30–60s until the old slot frees.
            hls = new Hls({
                liveDurationInfinity: true,
                manifestLoadingMaxRetry: 12,
                manifestLoadingRetryDelay: 1000,
                manifestLoadingMaxRetryTimeout: 64000,
                levelLoadingMaxRetry: 12,
                fragLoadingMaxRetry: 20,
                fragLoadingRetryDelay: 1000,
                fragLoadingMaxRetryTimeout: 64000,
            });
            hls.attachMedia(video);
            hls.once(Hls.Events.MEDIA_ATTACHED, () => {
                hls.loadSource(url);
                video.play().catch(() => undefined);
                setStatus('Loading channel…');
            });
            hls.once(Hls.Events.MANIFEST_PARSED, () => {
                setStatus('Buffering…');
                resolve(request);
            });
            hls.once(Hls.Events.FRAG_LOADED, () => setStatus('Starting…'));
            hls.on(Hls.Events.ERROR, (_e, data) => {
                if (!data.fatal) {
                    // Non-fatal buffer stall → resume loading immediately
                    // (faster than waiting for the watchdog).
                    if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
                        setStatus('Buffering…');
                        try {
                            hls.startLoad();
                        } catch {
                            /* best-effort */
                        }
                    } else if (
                        data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR ||
                        data.details === Hls.ErrorDetails.FRAG_LOAD_TIMEOUT ||
                        data.details === Hls.ErrorDetails.KEY_LOAD_ERROR
                    ) {
                        // Almost always the max_connections slot not yet freed.
                        setStatus('Waiting for the connection to free…');
                    }
                    return;
                }
                if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                    // Transient live-refresh failure OR the slot cooldown —
                    // resume rather than die (rides out ~60s of contention).
                    if (netRetries++ < 30) {
                        setStatus('Reconnecting… (' + netRetries + ')');
                        hls.startLoad();
                        return;
                    }
                } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                    hls.recoverMediaError();
                    return;
                }
                errorText.textContent =
                    'Stream error' + (data.details ? ' (' + data.details + ')' : '');
                show(errorPanel);
                try {
                    hls.destroy();
                } catch {
                    /* ignore */
                }
                const err = new cast.framework.messages.ErrorData(
                    cast.framework.messages.ErrorType.LOAD_FAILED
                );
                resolve(err);
            });
        });
    }
);

// Play/pause from the Google Home app / sender drives our <video>.
const setPlay = (shouldPlay) => (msg) => {
    if (shouldPlay) {
        video.play().catch(() => undefined);
    } else {
        video.pause();
    }
    playerManager.broadcastStatus(true);
    return msg;
};
playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.PAUSE,
    setPlay(false)
);
playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.PLAY,
    setPlay(true)
);

// STOP: tear down hls.js (it drives the <video> independently of CAF, so
// without this it would keep playing after the sender stops).
playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.STOP,
    (msg) => {
        if (hls) {
            hls.destroy();
            hls = null;
        }
        try {
            video.pause();
            video.removeAttribute('src');
            video.load();
        } catch {
            /* ignore */
        }
        setStatus('Ready to cast');
        show(idle);
        return msg;
    }
);

// SEEK: skipPlayersLoad means CAF won't move the element for us — do it here
// so ±15s from the sender scrubs VOD/series on the TV.
playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.SEEK,
    (req) => {
        if (typeof req.currentTime === 'number' && isFinite(video.duration)) {
            video.currentTime = Math.max(
                0,
                Math.min(video.duration, req.currentTime)
            );
        }
        return req;
    }
);

// Stall watchdog — hls.js can get stuck buffering at the live edge (network
// hiccup, provider gateway) WITHOUT a fatal error, so the picture freezes and
// only a re-cast fixes it. Detect no-progress-while-playing and self-heal:
// nudge the loader, then (if still stuck) jump back to the live edge.
let watchdogLast = 0;
let watchdogStalls = 0;
setInterval(() => {
    // Only recover stalls AFTER playback has started — never interfere with
    // the (possibly slow) initial buffer.
    if (
        !playbackStarted ||
        !hls ||
        video.paused ||
        video.ended ||
        video.readyState < 2
    ) {
        watchdogLast = video.currentTime;
        watchdogStalls = 0;
        return;
    }
    if (Math.abs(video.currentTime - watchdogLast) < 0.1) {
        watchdogStalls++;
        try {
            if (watchdogStalls === 2) {
                hls.startLoad(); // gentle: resume fetching
            } else if (watchdogStalls >= 4) {
                if (hls.liveSyncPosition != null) {
                    video.currentTime = hls.liveSyncPosition; // skip to live
                }
                hls.startLoad();
                video.play().catch(() => undefined);
                watchdogStalls = 0;
            }
        } catch {
            /* recovery best-effort */
        }
    } else {
        watchdogStalls = 0;
    }
    watchdogLast = video.currentTime;
}, 3000);

const options = new cast.framework.CastReceiverOptions();
options.skipPlayersLoad = true; // we own playback (hls.js), not CAF's player
options.disableIdleTimeout = true; // live streams shouldn't idle out
options.maxInactivity = 3600;
options.supportedCommands = cast.framework.messages.Command.ALL_BASIC_MEDIA;
context.start(options);
