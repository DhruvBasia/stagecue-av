import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  AudioCommand,
  AudioOutputDevice,
  BlackoutPayload,
  FreezeRequest,
  MediaItem,
  MediaLayer,
  StageCuePayload,
  StageMode,
  StageSyncSnapshot,
  StageWebLivePayload,
  UnfreezeRequest
} from './types';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { StageBackdrop, type StageBackdropHandle } from './components/stage/StageBackdrop';
import { StageBlackout } from './components/stage/StageBlackout';
import { StageFreezeLayer, type StageFreezeHandle } from './components/stage/StageFreezeLayer';
import { StageVideoPlayer, type StageVideoHandle } from './components/stage/StageVideoPlayer';
import { ReadyTracker, type CaptureSource } from './components/stage/readyTracker';
import { AudioEngine } from './services/audioEngine';
import { AUTO_RETURN_FADE_MS, UNFREEZE_FADE_MS } from './services/cueManager';
import { delay } from './services/utils';
import './styles/globals.css';

const TELEMETRY_INTERVAL_MS = 100;
const FREEZE_REVEAL_TIMEOUT_MS = 2500;

function reportError(
  layer: MediaLayer,
  media: MediaItem | null,
  takeId: number | null,
  message: string,
  code: number | null = null
): void {
  window.api.send('stage:media-error', {
    mediaId: media ? media.id : null,
    mediaName: media ? media.name : 'Stage output',
    layer,
    takeId,
    message,
    code
  });
}

const engine = new AudioEngine({
  createContext: () => new AudioContext({ latencyHint: 'interactive' }),
  createMediaElement: () => new Audio(),
  onMediaError: (media, message, code) => reportError('music', media, null, message, code)
});

/** Lists real output devices (the "default"/"communications" aliases are covered by ''). */
async function publishAudioDevices(error: string | null = null): Promise<void> {
  let devices: AudioOutputDevice[] = [];
  let problem = error;
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    devices = all
      .filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d, index) => ({ deviceId: d.deviceId, label: d.label || `Audio output ${index + 1}` }));
  } catch (enumerateError) {
    problem = problem ?? (enumerateError instanceof Error ? enumerateError.message : String(enumerateError));
  }
  window.api.send('audio:devices', {
    devices,
    currentSinkId: engine.getSinkId(),
    supported: engine.supportsOutputSelection(),
    error: problem
  });
}

async function applyAudioOutput(deviceId: string): Promise<void> {
  try {
    await engine.setOutputDevice(deviceId);
    await publishAudioDevices();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await engine.setOutputDevice('');
    } catch {
      // Already on (or unable to leave) the default device; report the original failure below.
    }
    await publishAudioDevices(`Could not switch audio output (${message}). Playing on the system default output.`);
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

/** Full-quality still of the live web page, decoded and ready to draw. Null when unavailable. */
async function captureWebStill(): Promise<HTMLImageElement | null> {
  try {
    const dataUrl = await window.api.invoke('stage:capture-web');
    if (!dataUrl) return null;
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    return img;
  } catch {
    return null;
  }
}

function runAudioCommand(command: AudioCommand): void {
  switch (command.type) {
    case 'music-load':
      engine.loadMusic(command.media, {
        loop: command.loop,
        autoplay: command.autoplay,
        crossfadeMs: command.crossfadeMs,
        startAt: command.startAt
      });
      break;
    case 'music-play':
      engine.playMusic();
      break;
    case 'music-pause':
      engine.pauseMusic();
      break;
    case 'music-stop':
      engine.stopMusic(command.fadeMs);
      break;
    case 'music-fade-out':
      engine.fadeOutMusic(command.durationMs);
      break;
    case 'music-seek':
      engine.seekMusic(command.time);
      break;
    case 'music-set-loop':
      engine.setMusicLoop(command.loop);
      break;
    case 'set-mix':
      engine.setMix(command.mix);
      break;
    case 'set-output':
      void applyAudioOutput(command.deviceId);
      break;
    case 'refresh-devices':
      void publishAudioDevices();
      break;
    default: {
      const exhaustive: never = command;
      throw new Error(`Unknown audio command ${JSON.stringify(exhaustive)}`);
    }
  }
}

function StageApp(): JSX.Element {
  const backdropTracker = useMemo(() => new ReadyTracker(), []);
  const videoTracker = useMemo(() => new ReadyTracker(), []);
  const backdropRef = useRef<StageBackdropHandle>(null);
  const videoRef = useRef<StageVideoHandle>(null);
  const freezeRef = useRef<StageFreezeHandle>(null);

  const [cue, setCue] = useState<StageCuePayload | null>(null);
  const cueRef = useRef<StageCuePayload | null>(null);
  cueRef.current = cue;

  const [blackout, setBlackout] = useState<BlackoutPayload>({ active: false, fadeMs: 0 });
  const blackoutRef = useRef(blackout);
  blackoutRef.current = blackout;

  const [displayMode, setDisplayMode] = useState<StageMode | null>(null);
  const displayModeRef = useRef<StageMode | null>(null);
  displayModeRef.current = displayMode;

  const frozenRef = useRef(false);
  const revealSeq = useRef(0);

  const releaseFreeze = useCallback((fadeMs: number, requestedAt: number) => {
    if (!frozenRef.current) return;
    freezeRef.current?.release(fadeMs);
    frozenRef.current = false;
    const now = Date.now();
    window.api.send('stage:freeze-ack', {
      isFrozen: false,
      requestedAt,
      acknowledgedAt: now,
      latencyMs: Math.max(0, now - requestedAt),
      source: 'empty'
    });
  }, []);

  const applyTake = useCallback(
    async (payload: StageCuePayload) => {
      if (!frozenRef.current) {
        setCue(payload);
        return;
      }
      // Frozen: load the new cue underneath with a cut, then dissolve out of the still.
      const seq = ++revealSeq.current;
      setCue({ ...payload, transition: 'cut', transitionDurationMs: 0 });
      await Promise.race([
        Promise.all([backdropTracker.wait(payload.takeId), videoTracker.wait(payload.takeId)]),
        delay(FREEZE_REVEAL_TIMEOUT_MS)
      ]);
      await nextFrame();
      await nextFrame();
      if (seq !== revealSeq.current) return;
      releaseFreeze(payload.transition === 'cut' ? 0 : Math.max(150, payload.transitionDurationMs), Date.now());
    },
    [backdropTracker, videoTracker, releaseFreeze]
  );

  const handleFreeze = useCallback((request: FreezeRequest) => {
    revealSeq.current += 1;
    const seq = revealSeq.current;
    const now = (): number => Date.now();
    if (frozenRef.current) {
      window.api.send('stage:freeze-ack', {
        isFrozen: true,
        requestedAt: request.requestedAt,
        acknowledgedAt: now(),
        latencyMs: Math.max(0, now() - request.requestedAt),
        source: 'composite'
      });
      return;
    }
    const finish = (backdropSources: CaptureSource[]): void => {
      const sources = [...backdropSources, ...(videoRef.current ? videoRef.current.getCaptureSources() : [])];
      const result = freezeRef.current ? freezeRef.current.capture(sources) : { source: 'empty' as const, drawn: 0 };
      const acknowledgedAt = now();
      window.api.send('stage:freeze-ack', {
        isFrozen: true,
        requestedAt: request.requestedAt,
        acknowledgedAt,
        latencyMs: Math.max(0, acknowledgedAt - request.requestedAt),
        source: result.source
      });
    };
    frozenRef.current = true;
    if (!backdropRef.current?.isWebLive()) {
      finish(backdropRef.current ? backdropRef.current.getCaptureSources() : []);
      return;
    }
    // A web page cannot be drawn into a canvas from here: the main process takes a full-quality still of it.
    void captureWebStill().then((still) => {
      // An unfreeze or a new take while capturing wins.
      if (seq !== revealSeq.current || !frozenRef.current) return;
      finish(still ? [{ element: still, opacity: 1, layer: 'backdrop' }] : []);
    });
  }, []);

  const handleUnfreeze = useCallback(
    (request: UnfreezeRequest) => {
      revealSeq.current += 1;
      releaseFreeze(request.fadeMs, request.requestedAt);
    },
    [releaseFreeze]
  );

  const handleFullSync = useCallback(
    (snapshot: StageSyncSnapshot) => {
      revealSeq.current += 1;
      releaseFreeze(0, Date.now());
      setCue(snapshot.cue ? { ...snapshot.cue } : null);
      setBlackout({ active: snapshot.isBlackout, fadeMs: 0 });
      engine.setMix(snapshot.mix);
      if (engine.getSinkId() !== snapshot.outputDeviceId) void applyAudioOutput(snapshot.outputDeviceId);
      if (snapshot.music) {
        const telemetry = engine.getTelemetry();
        if (telemetry.bgMusicMediaId !== snapshot.music.media.id) {
          engine.loadMusic(snapshot.music.media, {
            loop: snapshot.music.loop,
            autoplay: snapshot.music.playing,
            crossfadeMs: 300,
            startAt: snapshot.music.currentTime
          });
        }
      }
    },
    [releaseFreeze]
  );

  useEffect(() => {
    engine.init();
    const api = window.api;
    const offs = [
      api.on('stage:take-cue', (payload) => {
        void applyTake(payload);
      }),
      api.on('stage:action-freeze', handleFreeze),
      api.on('stage:action-unfreeze', handleUnfreeze),
      api.on('stage:action-blackout', (payload) => setBlackout(payload)),
      api.on('stage:action-clear-foreground', (payload) => {
        revealSeq.current += 1;
        setCue((prev) =>
          prev && prev.foreground
            ? {
                ...prev,
                foreground: null,
                transition: payload.fadeMs > 0 ? 'dissolve' : 'cut',
                transitionDurationMs: payload.fadeMs
              }
            : prev
        );
        releaseFreeze(payload.fadeMs, Date.now());
      }),
      api.on('stage:video-control', (control) => videoRef.current?.control(control)),
      api.on('stage:full-sync', handleFullSync),
      api.on('audio:command', runAudioCommand),
      api.on('display:changed', (status) => setDisplayMode(status.mode))
    ];

    api
      .invoke('display:get-list')
      .then((status) => setDisplayMode(status.mode))
      .catch((error: unknown) => console.warn('[StageCue] display status unavailable', error));

    const telemetryTimer = window.setInterval(() => {
      const playback = videoRef.current
        ? videoRef.current.getPlaybackState()
        : { media: null, currentTime: 0, duration: 0, isPlaying: false };
      const current = cueRef.current;
      api.send('stage:state-update', {
        currentBackdrop: current ? current.backdrop : null,
        currentForeground: playback.media,
        isForegroundPlaying: playback.isPlaying,
        foregroundCurrentTime: playback.currentTime,
        foregroundDuration: playback.duration,
        isFrozen: frozenRef.current,
        isBlackout: blackoutRef.current.active,
        transitionDurationMs: current ? current.transitionDurationMs : 0,
        takeId: current ? current.takeId : 0,
        cueId: current ? current.cueId : null,
        displayMode: displayModeRef.current,
        sentAt: Date.now()
      });
      api.send('audio:state-update', engine.getTelemetry());
    }, TELEMETRY_INTERVAL_MS);

    api.send('stage:ready', { loadedAt: Date.now() });

    // Report audio outputs now and whenever a USB interface / HDMI sink appears or disappears.
    const onDeviceChange = (): void => {
      void publishAudioDevices();
    };
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
    void publishAudioDevices();

    return () => {
      offs.forEach((off) => off());
      window.clearInterval(telemetryTimer);
      navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
    };
  }, [applyTake, handleFreeze, handleUnfreeze, handleFullSync, releaseFreeze]);

  const handleForegroundEnded = useCallback((mediaId: string, takeId: number) => {
    setCue((prev) =>
      prev && prev.takeId === takeId && prev.foreground && prev.foreground.id === mediaId
        ? { ...prev, foreground: null, transition: 'dissolve', transitionDurationMs: AUTO_RETURN_FADE_MS }
        : prev
    );
    window.api.send('stage:foreground-ended', { mediaId, takeId, cueId: cueRef.current ? cueRef.current.cueId : null });
  }, []);

  const handleVideoError = useCallback((media: MediaItem, takeId: number, message: string) => {
    reportError('foreground', media, takeId, message);
    setCue((prev) =>
      prev && prev.takeId === takeId && prev.foreground && prev.foreground.id === media.id
        ? { ...prev, foreground: null, transition: 'cut', transitionDurationMs: 0 }
        : prev
    );
  }, []);

  const handleBackdropError = useCallback((media: MediaItem, takeId: number, message: string) => {
    reportError('backdrop', media, takeId, message);
  }, []);

  const handleWebLiveChange = useCallback((payload: StageWebLivePayload) => {
    window.api.send('stage:web-live', payload);
  }, []);

  const projector = displayMode === 'projector';
  const takeId = cue ? cue.takeId : 0;

  return (
    <div
      className={`stage-root relative h-screen w-screen overflow-hidden bg-black ${projector ? 'cursor-none' : ''}`}
      data-testid="stage-root"
      data-mode={displayMode ?? 'unknown'}
    >
      <StageBackdrop
        ref={backdropRef}
        media={cue ? cue.backdrop : null}
        loop={cue ? cue.loopBackdrop : true}
        takeId={takeId}
        transition={cue ? cue.transition : 'cut'}
        durationMs={cue ? cue.transitionDurationMs : 0}
        tracker={backdropTracker}
        onError={handleBackdropError}
        onWebLiveChange={handleWebLiveChange}
      />
      <StageVideoPlayer
        ref={videoRef}
        media={cue ? cue.foreground : null}
        takeId={takeId}
        transition={cue ? cue.transition : 'cut'}
        durationMs={cue ? cue.transitionDurationMs : 0}
        autoPlay={cue ? cue.autoPlayForeground : true}
        duck={cue ? cue.duckAudioOnVideo : true}
        startAt={cue ? cue.foregroundStartAt : undefined}
        engine={engine}
        tracker={videoTracker}
        onEnded={handleForegroundEnded}
        onError={handleVideoError}
      />
      <StageFreezeLayer ref={freezeRef} defaultReleaseMs={UNFREEZE_FADE_MS} />
      <StageBlackout active={blackout.active} fadeMs={blackout.fadeMs} />
      {displayMode && !projector ? (
        <div
          className="stage-drag-region absolute inset-x-0 top-0 flex h-7 items-center justify-center gap-2 bg-black/70 font-mono text-[11px] font-semibold tracking-widest text-av-amber"
          style={{ zIndex: 40 }}
          data-testid="rehearsal-label"
        >
          <span className="h-1.5 w-1.5 animate-live-blink rounded-full bg-av-amber" />
          {displayMode === 'docked'
            ? '[STAGE OUTPUT - PROJECTOR DISCONNECTED]'
            : '[STAGE OUTPUT - REHEARSAL MODE]'}
        </div>
      ) : null}
    </div>
  );
}

function StageCrashFallback(): JSX.Element {
  return <div className="h-screen w-screen bg-black" data-testid="stage-crashed" />;
}

window.addEventListener('contextmenu', (event) => event.preventDefault());
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());
window.addEventListener('error', (event) => {
  reportError('stage', null, null, event.message || 'Unexpected stage error');
});
window.addEventListener('unhandledrejection', (event) => {
  const reason: unknown = event.reason;
  reportError('stage', null, null, reason instanceof Error ? reason.message : String(reason));
});

const container = document.getElementById('root');
if (!container) throw new Error('Stage root element missing');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary
      fallback={() => <StageCrashFallback />}
      onError={(error) => reportError('stage', null, null, `Stage renderer error: ${error.message}`)}
    >
      <StageApp />
    </ErrorBoundary>
  </StrictMode>
);
