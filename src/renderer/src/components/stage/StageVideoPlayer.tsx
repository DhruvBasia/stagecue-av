import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { MediaItem, TransitionType, VideoControl } from '../../types';
import { describeMediaElementError, type AudioEngine } from '../../services/audioEngine';
import { planTransition } from '../../services/cueManager';
import { incomingStyle, outgoingStyle } from './StageBackdrop';
import { isDrawable, readOpacity, type CaptureSource, type ReadyTracker } from './readyTracker';

/* Layer 1 — foreground video. Two persistent <video> elements (A/B) so every
 * element is wired into the Web Audio graph exactly once, and consecutive
 * videos can crossfade picture and sound. */

export interface VideoPlaybackState {
  media: MediaItem | null;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
}

export interface StageVideoHandle {
  getCaptureSources(): CaptureSource[];
  getPlaybackState(): VideoPlaybackState;
  control(control: VideoControl): void;
}

export interface StageVideoPlayerProps {
  media: MediaItem | null;
  takeId: number;
  transition: TransitionType;
  durationMs: number;
  autoPlay: boolean;
  duck: boolean;
  startAt?: number;
  engine: AudioEngine;
  tracker: ReadyTracker;
  onEnded: (mediaId: string, takeId: number) => void;
  onError: (media: MediaItem, takeId: number, message: string) => void;
}

type SlotIndex = 0 | 1;
type Pair<T> = [T, T];

interface SlotMeta {
  media: MediaItem | null;
  takeId: number;
  awaitingReveal: boolean;
  autoPlay: boolean;
  transition: TransitionType;
  durationMs: number;
}

interface LayerStyle {
  opacity: number;
  transition: string;
}

const emptyMeta = (): SlotMeta => ({
  media: null,
  takeId: -1,
  awaitingReveal: false,
  autoPlay: false,
  transition: 'cut',
  durationMs: 0
});

function otherSlot(index: SlotIndex): SlotIndex {
  return index === 0 ? 1 : 0;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export const StageVideoPlayer = forwardRef<StageVideoHandle, StageVideoPlayerProps>(function StageVideoPlayer(
  { media, takeId, transition, durationMs, autoPlay, duck, startAt, engine, tracker, onEnded, onError },
  ref
) {
  const videoRefs = useRef<Pair<HTMLVideoElement | null>>([null, null]);
  const wrapperRefs = useRef<Pair<HTMLDivElement | null>>([null, null]);
  const metaRef = useRef<Pair<SlotMeta>>([emptyMeta(), emptyMeta()]);
  const activeRef = useRef<SlotIndex>(0);
  const unloadTimers = useRef<Pair<number | null>>([null, null]);
  const duckRef = useRef(duck);
  duckRef.current = duck;
  const callbacks = useRef({ onEnded, onError });
  callbacks.current = { onEnded, onError };

  const [styles, setStyles] = useState<Pair<LayerStyle>>([
    { opacity: 0, transition: 'none' },
    { opacity: 0, transition: 'none' }
  ]);
  const [topSlot, setTopSlot] = useState<SlotIndex>(0);
  const [visibleIds, setVisibleIds] = useState<Pair<string | null>>([null, null]);

  const setSlotStyle = (index: SlotIndex, style: LayerStyle): void => {
    setStyles((prev) => {
      const next: Pair<LayerStyle> = [prev[0], prev[1]];
      next[index] = style;
      return next;
    });
  };

  const clearUnloadTimer = (index: SlotIndex): void => {
    const timer = unloadTimers.current[index];
    if (timer !== null) {
      window.clearTimeout(timer);
      unloadTimers.current[index] = null;
    }
  };

  const unloadSlot = useCallback((index: SlotIndex): void => {
    clearUnloadTimer(index);
    const el = videoRefs.current[index];
    metaRef.current[index] = emptyMeta();
    setVisibleIds((prev) => {
      const next: Pair<string | null> = [prev[0], prev[1]];
      next[index] = null;
      return next;
    });
    if (el) {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
  }, []);

  const scheduleUnload = (index: SlotIndex, afterMs: number): void => {
    clearUnloadTimer(index);
    const expectedTake = metaRef.current[index].takeId;
    unloadTimers.current[index] = window.setTimeout(() => {
      unloadTimers.current[index] = null;
      if (metaRef.current[index].takeId === expectedTake && activeRef.current !== index) unloadSlot(index);
    }, afterMs);
  };

  const playElement = (index: SlotIndex): void => {
    const el = videoRefs.current[index];
    const meta = metaRef.current[index];
    if (!el || !meta.media) return;
    const mediaAtCall = meta.media;
    const takeAtCall = meta.takeId;
    el.play().catch((error: unknown) => {
      if (metaRef.current[index].takeId !== takeAtCall) return;
      const message = error instanceof Error ? error.message : String(error);
      if (/interrupted|aborted|pause\(\)/i.test(message)) return;
      callbacks.current.onError(mediaAtCall, takeAtCall, `Playback failed: ${message}`);
    });
  };

  const reveal = (index: SlotIndex): void => {
    const meta = metaRef.current[index];
    if (!meta.awaitingReveal || !meta.media) return;
    meta.awaitingReveal = false;
    const outgoing = activeRef.current;
    activeRef.current = index;
    const plan = planTransition(meta.transition, meta.durationMs);

    if (!meta.autoPlay) engine.setVideoActivity(false, duckRef.current);
    if (meta.autoPlay) playElement(index);

    setTopSlot(index);
    setVisibleIds((prev) => {
      const next: Pair<string | null> = [prev[0], prev[1]];
      next[index] = meta.media ? meta.media.id : null;
      return next;
    });
    setStyles(() => {
      const next: Pair<LayerStyle> = [
        { opacity: 0, transition: 'none' },
        { opacity: 0, transition: 'none' }
      ];
      next[index] = incomingStyle(plan);
      if (outgoing !== index && metaRef.current[outgoing].media) next[outgoing] = outgoingStyle(meta.transition, plan);
      return next;
    });
    engine.setVideoSlotGain(index, 1, plan.inDelayMs + plan.inDurationMs);

    if (outgoing !== index && metaRef.current[outgoing].media) {
      engine.setVideoSlotGain(outgoing, 0, Math.max(plan.outDelayMs + plan.outDurationMs, plan.totalMs));
      scheduleUnload(outgoing, plan.totalMs + 80);
    }
    tracker.markReady(meta.takeId);
  };

  /* Register both elements with the audio graph once. */
  useEffect(() => {
    videoRefs.current.forEach((el, index) => {
      if (el) engine.registerVideoElement(index, el);
    });
  }, [engine]);

  /* React to a new take / cleared foreground. */
  useEffect(() => {
    const active = activeRef.current;
    const plan = planTransition(transition, durationMs);

    if (!media) {
      const pendingTarget = otherSlot(active);
      if (metaRef.current[pendingTarget].awaitingReveal) unloadSlot(pendingTarget);
      if (metaRef.current[active].media) {
        setSlotStyle(active, { opacity: 0, transition: `opacity ${plan.totalMs}ms linear 0ms` });
        engine.setVideoSlotGain(active, 0, plan.totalMs);
        engine.setVideoActivity(false, duckRef.current);
        const expectedTake = metaRef.current[active].takeId;
        clearUnloadTimer(active);
        unloadTimers.current[active] = window.setTimeout(() => {
          unloadTimers.current[active] = null;
          if (metaRef.current[active].takeId === expectedTake) unloadSlot(active);
        }, plan.totalMs + 80);
      }
      tracker.markReady(takeId);
      return;
    }

    const target = otherSlot(active);
    clearUnloadTimer(target);
    const el = videoRefs.current[target];
    if (!el) {
      tracker.markReady(takeId);
      return;
    }
    metaRef.current[target] = {
      media,
      takeId,
      awaitingReveal: true,
      autoPlay,
      transition,
      durationMs
    };
    setSlotStyle(target, { opacity: 0, transition: 'none' });
    engine.setVideoSlotGain(target, 0, 0);
    el.pause();
    el.loop = false;
    el.src = media.fileUrl;
    el.load();
    if (startAt !== undefined && startAt > 0) el.currentTime = startAt;
    // Transition/autoplay settings are captured in the slot metadata at take time.
  }, [media?.id, takeId]);

  useEffect(
    () => () => {
      clearUnloadTimer(0);
      clearUnloadTimer(1);
    },
    []
  );

  const handleCanPlay = (index: SlotIndex): void => {
    reveal(index);
  };

  const handlePlaying = (index: SlotIndex): void => {
    if (index === activeRef.current && metaRef.current[index].media) {
      engine.setVideoActivity(true, duckRef.current);
    }
  };

  const handlePause = (index: SlotIndex): void => {
    if (index === activeRef.current) engine.setVideoActivity(false, duckRef.current);
  };

  const handleEnded = (index: SlotIndex): void => {
    const meta = metaRef.current[index];
    if (index !== activeRef.current || !meta.media) return;
    engine.setVideoActivity(false, duckRef.current);
    callbacks.current.onEnded(meta.media.id, meta.takeId);
  };

  const handleError = (index: SlotIndex): void => {
    const meta = metaRef.current[index];
    const el = videoRefs.current[index];
    if (!meta.media || !el || !el.error) return;
    const failed = meta.media;
    const failedTake = meta.takeId;
    const wasAwaiting = meta.awaitingReveal;
    meta.awaitingReveal = false;
    // Never show a broken frame on stage: hide this slot instantly and keep the backdrop visible.
    setSlotStyle(index, { opacity: 0, transition: 'none' });
    engine.setVideoSlotGain(index, 0, 0);
    if (index === activeRef.current) engine.setVideoActivity(false, duckRef.current);
    if (wasAwaiting) tracker.markReady(failedTake);
    callbacks.current.onError(failed, failedTake, describeMediaElementError(el.error));
    unloadSlot(index);
  };

  useImperativeHandle(
    ref,
    () => ({
      getCaptureSources(): CaptureSource[] {
        const order: SlotIndex[] = [otherSlot(activeRef.current), activeRef.current];
        const sources: CaptureSource[] = [];
        for (const index of order) {
          const el = videoRefs.current[index];
          if (!el || !metaRef.current[index].media || !isDrawable(el)) continue;
          const opacity = readOpacity(wrapperRefs.current[index]);
          if (opacity > 0.001) sources.push({ element: el, opacity, layer: 'foreground' });
        }
        return sources;
      },
      getPlaybackState(): VideoPlaybackState {
        const index = activeRef.current;
        const meta = metaRef.current[index];
        const el = videoRefs.current[index];
        if (!meta.media || !el || meta.awaitingReveal) {
          return { media: null, currentTime: 0, duration: 0, isPlaying: false };
        }
        return {
          media: meta.media,
          currentTime: finite(el.currentTime),
          duration: finite(el.duration) || meta.media.duration || 0,
          isPlaying: !el.paused && !el.ended
        };
      },
      control(control: VideoControl): void {
        const index = activeRef.current;
        const el = videoRefs.current[index];
        if (!el || !metaRef.current[index].media) return;
        switch (control.action) {
          case 'play':
            void engine.resume();
            playElement(index);
            break;
          case 'pause':
            el.pause();
            break;
          case 'restart':
            el.currentTime = 0;
            playElement(index);
            break;
          case 'seek': {
            const duration = finite(el.duration);
            el.currentTime = duration > 0 ? Math.min(Math.max(0, control.time), duration) : Math.max(0, control.time);
            break;
          }
          default: {
            const exhaustive: never = control;
            throw new Error(`Unknown video control ${JSON.stringify(exhaustive)}`);
          }
        }
      }
    }),
    // playElement only reads refs, so the handle is stable for the engine's lifetime.
    [engine]
  );

  return (
    <div className="absolute inset-0 z-10" data-testid="video-layer">
      {([0, 1] as const).map((index) => (
        <div
          key={index}
          ref={(el) => {
            wrapperRefs.current[index] = el;
          }}
          className="absolute inset-0"
          style={{
            opacity: styles[index].opacity,
            transition: styles[index].transition,
            zIndex: topSlot === index ? 2 : 1,
            backgroundColor: visibleIds[index] ? '#000000' : 'transparent'
          }}
          data-slot={index}
          data-media-id={visibleIds[index] ?? ''}
          data-active={topSlot === index && visibleIds[index] !== null ? 'true' : 'false'}
        >
          <video
            ref={(el) => {
              videoRefs.current[index] = el;
            }}
            className="media-layer"
            crossOrigin="anonymous"
            playsInline
            preload="auto"
            disablePictureInPicture
            onCanPlay={() => handleCanPlay(index)}
            onPlaying={() => handlePlaying(index)}
            onPause={() => handlePause(index)}
            onEnded={() => handleEnded(index)}
            onError={() => handleError(index)}
          />
        </div>
      ))}
    </div>
  );
});
