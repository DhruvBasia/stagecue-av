import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { WEB_PARTITION, type MediaItem, type StageWebLivePayload, type TransitionType } from '../../types';
import { planTransition, type TransitionPlan } from '../../services/cueManager';
import { isDrawable, readOpacity, type CaptureSource, type ReadyTracker } from './readyTracker';

/* Layer 0 — backdrop poster, looping background video, live web page (e.g. a
 * flipbook) or live window capture, with A/B slots for cut / fade-through-black
 * / dissolve transitions. */

/** A slow site is shown anyway after this long rather than holding up the cue. */
export const WEB_REVEAL_TIMEOUT_MS = 10_000;

interface WebviewElement extends HTMLElement {
  getWebContentsId(): number;
}

interface WebviewFailEvent extends Event {
  errorCode: number;
  errorDescription: string;
  isMainFrame: boolean;
}

export interface StageBackdropHandle {
  getCaptureSources(): CaptureSource[];
  /** True while the visible backdrop is a web page (it cannot be drawn into the freeze canvas directly). */
  isWebLive(): boolean;
}

export interface StageBackdropProps {
  media: MediaItem | null;
  loop: boolean;
  takeId: number;
  transition: TransitionType;
  durationMs: number;
  tracker: ReadyTracker;
  onError: (media: MediaItem, takeId: number, message: string) => void;
  /** Tells the main process which web page is live, so the operator can see and control it. */
  onWebLiveChange: (payload: StageWebLivePayload) => void;
}

interface SlotProps {
  media: MediaItem;
  onReady: () => void;
  onFail: (message: string) => void;
  register: (el: HTMLElement | null) => void;
}

/** A live web page in a sandboxed <webview> (the main process enforces the sandbox). */
function WebSlot({ media, onReady, onFail, register }: SlotProps): JSX.Element {
  const ref = useRef<WebviewElement | null>(null);
  const callbacks = useRef({ onReady, onFail });
  callbacks.current = { onReady, onFail };

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    let revealed = false;
    let settle: number | null = null;
    const ready = (): void => {
      if (revealed) return;
      revealed = true;
      callbacks.current.onReady();
    };
    const onLoad = (): void => {
      // Give the page a moment to paint its first screen before it fades in.
      if (settle === null) settle = window.setTimeout(ready, 150);
    };
    const onFailLoad = (event: Event): void => {
      const fail = event as WebviewFailEvent;
      // -3 = navigation aborted by the page itself (redirects), not an error.
      if (!fail.isMainFrame || fail.errorCode === -3 || revealed) return;
      revealed = true;
      callbacks.current.onFail(`Web page could not be loaded (${fail.errorDescription || `error ${fail.errorCode}`}). Check the internet connection`);
    };
    const onGone = (): void => callbacks.current.onFail('The web page crashed');
    el.addEventListener('did-finish-load', onLoad);
    el.addEventListener('did-fail-load', onFailLoad);
    el.addEventListener('render-process-gone', onGone);
    const cap = window.setTimeout(ready, WEB_REVEAL_TIMEOUT_MS);
    return () => {
      el.removeEventListener('did-finish-load', onLoad);
      el.removeEventListener('did-fail-load', onFailLoad);
      el.removeEventListener('render-process-gone', onGone);
      window.clearTimeout(cap);
      if (settle !== null) window.clearTimeout(settle);
    };
  }, []);

  return (
    <webview
      ref={(el: HTMLElement | null) => {
        ref.current = el as WebviewElement | null;
        register(el);
      }}
      src={media.web?.url ?? media.fileUrl}
      partition={WEB_PARTITION}
      webpreferences="contextIsolation=yes, sandbox=yes, javascript=yes"
      data-media-id={media.id}
      className="absolute inset-0 h-full w-full"
      style={{ display: 'flex' }}
    />
  );
}

/** A live capture of a window or screen picked by the operator. */
function ScreenSlot({ media, onReady, onFail, register }: SlotProps): JSX.Element {
  const ref = useRef<HTMLVideoElement | null>(null);
  const callbacks = useRef({ onReady, onFail });
  callbacks.current = { onReady, onFail };

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    const capture = media.capture;
    const start = async (): Promise<void> => {
      if (!capture) throw new Error('No window selected');
      const sourceId = await window.api.invoke('capture:resolve', { sourceId: capture.sourceId, name: media.name, kind: capture.kind });
      if (!sourceId) throw new Error(`“${media.name}” is not open. Open it, or pick the window again`);
      // Chromium's desktop-capture constraints (not part of the standard typings).
      const constraints = {
        audio: false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 30 } }
      } as unknown as MediaStreamConstraints;
      const captured = await navigator.mediaDevices.getUserMedia(constraints);
      if (cancelled) {
        captured.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = captured;
      const [track] = captured.getVideoTracks();
      if (track) track.addEventListener('ended', () => callbacks.current.onFail(`“${media.name}” was closed`));
      const el = ref.current;
      if (el) {
        el.srcObject = captured;
        void el.play().catch(() => undefined);
      }
    };
    start().catch((error: unknown) => {
      if (!cancelled) callbacks.current.onFail(error instanceof Error ? error.message : String(error));
    });
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [media.id, media.name, media.capture]);

  return (
    <video
      ref={(el) => {
        ref.current = el;
        register(el);
      }}
      muted
      autoPlay
      playsInline
      disablePictureInPicture
      data-media-id={media.id}
      className="media-layer"
      onCanPlay={() => callbacks.current.onReady()}
    />
  );
}

interface Slot {
  key: string;
  media: MediaItem | null;
  loop: boolean;
  takeId: number;
}

interface LayerStyle {
  opacity: number;
  transition: string;
}

type SlotIndex = 0 | 1;
type Pair<T> = [T, T];

const emptySlot = (index: number): Slot => ({ key: `empty-${index}`, media: null, loop: true, takeId: -1 });

function otherSlot(index: SlotIndex): SlotIndex {
  return index === 0 ? 1 : 0;
}

export function incomingStyle(plan: TransitionPlan): LayerStyle {
  return { opacity: 1, transition: `opacity ${plan.inDurationMs}ms linear ${plan.inDelayMs}ms` };
}

/** Dissolve keeps the outgoing layer solid underneath until the incoming one is fully up. */
export function outgoingStyle(type: TransitionType, plan: TransitionPlan): LayerStyle {
  if (type === 'dissolve') return { opacity: 0, transition: `opacity 0ms linear ${plan.totalMs}ms` };
  return { opacity: 0, transition: `opacity ${plan.outDurationMs}ms linear ${plan.outDelayMs}ms` };
}

export const StageBackdrop = forwardRef<StageBackdropHandle, StageBackdropProps>(function StageBackdrop(
  { media, loop, takeId, transition, durationMs, tracker, onError, onWebLiveChange },
  ref
) {
  const [slots, setSlots] = useState<Pair<Slot>>(() => [emptySlot(0), emptySlot(1)]);
  const [styles, setStyles] = useState<Pair<LayerStyle>>([
    { opacity: 1, transition: 'none' },
    { opacity: 0, transition: 'none' }
  ]);
  const [topSlot, setTopSlot] = useState<SlotIndex>(0);

  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const activeRef = useRef<SlotIndex>(0);
  const pendingRef = useRef<{ slot: SlotIndex; takeId: number; plan: TransitionPlan; type: TransitionType } | null>(null);
  const wrapperRefs = useRef<Pair<HTMLDivElement | null>>([null, null]);
  const mediaRefs = useRef<Pair<HTMLImageElement | HTMLVideoElement | null>>([null, null]);
  const webRefs = useRef<Pair<WebviewElement | null>>([null, null]);
  const cleanupTimer = useRef<number | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onWebLiveRef = useRef(onWebLiveChange);
  onWebLiveRef.current = onWebLiveChange;
  const reportedWebRef = useRef<string>('none');

  /** Reports the visible slot's web page (or none) to the main process, once per change. */
  const reportWebLive = (slot: SlotIndex): void => {
    const current = slotsRef.current[slot];
    const el = webRefs.current[slot];
    let payload: StageWebLivePayload = { mediaId: null, takeId: current.takeId, webContentsId: null, homeUrl: null };
    if (current.media?.type === 'web' && el) {
      try {
        payload = {
          mediaId: current.media.id,
          takeId: current.takeId,
          webContentsId: el.getWebContentsId(),
          homeUrl: current.media.web?.url ?? current.media.fileUrl
        };
      } catch {
        // Not attached yet (the page failed before loading); nothing to control.
      }
    }
    const key = payload.webContentsId === null ? 'none' : `${payload.webContentsId}:${payload.mediaId ?? ''}`;
    if (key === reportedWebRef.current) return;
    reportedWebRef.current = key;
    onWebLiveRef.current(payload);
  };

  const clearCleanup = (): void => {
    if (cleanupTimer.current !== null) {
      window.clearTimeout(cleanupTimer.current);
      cleanupTimer.current = null;
    }
  };

  const reveal = useCallback(
    (slot: SlotIndex, slotTakeId: number): void => {
      const pending = pendingRef.current;
      if (!pending || pending.slot !== slot || pending.takeId !== slotTakeId) return;
      pendingRef.current = null;
      const outgoing = activeRef.current;
      activeRef.current = slot;
      setTopSlot(slot);
      setStyles(() => {
        const next: Pair<LayerStyle> = [
          { opacity: 0, transition: 'none' },
          { opacity: 0, transition: 'none' }
        ];
        next[slot] = incomingStyle(pending.plan);
        if (outgoing !== slot) next[outgoing] = outgoingStyle(pending.type, pending.plan);
        return next;
      });
      tracker.markReady(slotTakeId);
      reportWebLive(slot);

      if (outgoing !== slot) {
        const outgoingKey = slotsRef.current[outgoing].key;
        clearCleanup();
        cleanupTimer.current = window.setTimeout(() => {
          cleanupTimer.current = null;
          setSlots((prev) => {
            if (prev[outgoing].key !== outgoingKey) return prev;
            const next: Pair<Slot> = [prev[0], prev[1]];
            next[outgoing] = emptySlot(outgoing);
            return next;
          });
        }, pending.plan.totalMs + 120);
      }
    },
    [tracker]
  );

  useEffect(() => {
    const active = activeRef.current;
    const current = slotsRef.current[active];
    const nextId = media ? media.id : null;
    const currentId = current.media ? current.media.id : null;

    if (nextId === currentId && pendingRef.current === null) {
      if (current.loop !== loop) {
        setSlots((prev) => {
          const next: Pair<Slot> = [prev[0], prev[1]];
          next[active] = { ...prev[active], loop };
          return next;
        });
        const el = mediaRefs.current[active];
        if (el instanceof HTMLVideoElement) el.loop = loop;
      }
      tracker.markReady(takeId);
      return;
    }

    const target = otherSlot(active);
    clearCleanup();
    const plan = planTransition(transition, durationMs);
    pendingRef.current = { slot: target, takeId, plan, type: transition };
    setSlots((prev) => {
      const next: Pair<Slot> = [prev[0], prev[1]];
      next[target] = { key: `${nextId ?? 'none'}:${takeId}`, media, loop, takeId };
      return next;
    });
    setStyles((prev) => {
      const next: Pair<LayerStyle> = [prev[0], prev[1]];
      next[target] = { opacity: 0, transition: 'none' };
      return next;
    });

    if (!media) {
      const frame = window.requestAnimationFrame(() => reveal(target, takeId));
      return () => window.cancelAnimationFrame(frame);
    }
    return undefined;
    // Only a new file, a re-take or a loop change re-runs this; transition settings are read at take time.
  }, [media?.id, takeId, loop]);

  useEffect(() => () => clearCleanup(), []);

  const handleError = (index: SlotIndex, message?: string): void => {
    const slot = slotsRef.current[index];
    if (!slot.media) return;
    const pending = pendingRef.current;
    if (pending && pending.slot === index && pending.takeId === slot.takeId) {
      pendingRef.current = null;
      tracker.markReady(slot.takeId);
      setSlots((prev) => {
        const next: Pair<Slot> = [prev[0], prev[1]];
        next[index] = emptySlot(index);
        return next;
      });
    }
    if (message) {
      onErrorRef.current(slot.media, slot.takeId, message);
      return;
    }
    const el = mediaRefs.current[index];
    const detail =
      el instanceof HTMLVideoElement && el.error
        ? `video error ${el.error.code}${el.error.message ? `: ${el.error.message}` : ''}`
        : 'the file could not be decoded';
    onErrorRef.current(slot.media, slot.takeId, `Backdrop failed to load (${detail})`);
  };

  useImperativeHandle(
    ref,
    () => ({
      getCaptureSources(): CaptureSource[] {
        const order: SlotIndex[] = [otherSlot(activeRef.current), activeRef.current];
        const sources: CaptureSource[] = [];
        for (const index of order) {
          const el = mediaRefs.current[index];
          if (!slotsRef.current[index].media || !el || !isDrawable(el)) continue;
          const opacity = readOpacity(wrapperRefs.current[index]);
          if (opacity > 0.001) sources.push({ element: el, opacity, layer: 'backdrop' });
        }
        return sources;
      },
      isWebLive(): boolean {
        const active = activeRef.current;
        return slotsRef.current[active].media?.type === 'web' && readOpacity(wrapperRefs.current[active]) > 0.001;
      }
    }),
    []
  );

  return (
    <div className="absolute inset-0 z-0 bg-black" data-testid="backdrop-layer">
      {([0, 1] as const).map((index) => {
        const slot = slots[index];
        const style = styles[index];
        return (
          <div
            key={index}
            ref={(el) => {
              wrapperRefs.current[index] = el;
            }}
            className="absolute inset-0"
            style={{
              opacity: style.opacity,
              transition: style.transition,
              zIndex: topSlot === index ? 2 : 1,
              backgroundColor: slot.media ? '#000000' : 'transparent'
            }}
            data-slot={index}
            data-active={topSlot === index && slot.media !== null ? 'true' : 'false'}
          >
            {slot.media && slot.media.type === 'image' ? (
              <img
                key={slot.key}
                ref={(el) => {
                  mediaRefs.current[index] = el;
                }}
                src={slot.media.fileUrl}
                alt=""
                draggable={false}
                decoding="async"
                data-media-id={slot.media.id}
                className="media-layer"
                onLoad={() => reveal(index, slot.takeId)}
                onError={() => handleError(index)}
              />
            ) : null}
            {slot.media && slot.media.type === 'video' ? (
              <video
                key={slot.key}
                ref={(el) => {
                  mediaRefs.current[index] = el;
                }}
                src={slot.media.fileUrl}
                muted
                autoPlay
                playsInline
                loop={slot.loop}
                preload="auto"
                disablePictureInPicture
                data-media-id={slot.media.id}
                className="media-layer"
                onCanPlay={() => reveal(index, slot.takeId)}
                onError={() => handleError(index)}
              />
            ) : null}
            {slot.media && slot.media.type === 'web' ? (
              <WebSlot
                key={slot.key}
                media={slot.media}
                onReady={() => reveal(index, slot.takeId)}
                onFail={(message) => handleError(index, message)}
                register={(el) => {
                  webRefs.current[index] = el as WebviewElement | null;
                  mediaRefs.current[index] = null;
                }}
              />
            ) : null}
            {slot.media && slot.media.type === 'screen' ? (
              <ScreenSlot
                key={slot.key}
                media={slot.media}
                onReady={() => reveal(index, slot.takeId)}
                onFail={(message) => handleError(index, message)}
                register={(el) => {
                  mediaRefs.current[index] = el as HTMLVideoElement | null;
                }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
});
