import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { MediaItem, TransitionType } from '../../types';
import { planTransition, type TransitionPlan } from '../../services/cueManager';
import { isDrawable, readOpacity, type CaptureSource, type ReadyTracker } from './readyTracker';

/* Layer 0 — backdrop poster or looping background video, with A/B slots for
 * cut / fade-through-black / dissolve transitions. */

export interface StageBackdropHandle {
  getCaptureSources(): CaptureSource[];
}

export interface StageBackdropProps {
  media: MediaItem | null;
  loop: boolean;
  takeId: number;
  transition: TransitionType;
  durationMs: number;
  tracker: ReadyTracker;
  onError: (media: MediaItem, takeId: number, message: string) => void;
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
  { media, loop, takeId, transition, durationMs, tracker, onError },
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
  const cleanupTimer = useRef<number | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

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

  const handleError = (index: SlotIndex): void => {
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
          </div>
        );
      })}
    </div>
  );
});
