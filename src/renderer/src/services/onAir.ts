import type { CaptionItem, CaptionStyle, OnAirSettings, OverlayClock } from '../types';
import { clamp } from './utils';

/* =========================================================================
 * On-air helpers: speaker timer, projector countdown and name captions.
 * Clocks are plain data (endsAt / remainingMs) so the operator, the stage and
 * the phones all compute the same time. Pure functions, unit tested.
 * ========================================================================= */

export const DEFAULT_ON_AIR: OnAirSettings = {
  captions: [],
  captionStyle: 'bar',
  timerMinutes: 5,
  timerWarnSeconds: 60,
  countdownMinutes: 5,
  countdownMessage: 'The event begins in'
};

/** Captions from a cue fade out by themselves after this long. */
export const CUE_CAPTION_MS = 10_000;

export function newClock(durationMs: number): OverlayClock {
  return { endsAt: null, remainingMs: Math.max(0, Math.round(durationMs)) };
}

export function clockRemaining(clock: OverlayClock, now: number): number {
  return clock.endsAt !== null ? clock.endsAt - now : clock.remainingMs;
}

export function isRunning(clock: OverlayClock): boolean {
  return clock.endsAt !== null;
}

export function startClock(clock: OverlayClock, now: number): OverlayClock {
  if (clock.endsAt !== null) return clock;
  return { endsAt: now + clock.remainingMs, remainingMs: clock.remainingMs };
}

export function pauseClock(clock: OverlayClock, now: number): OverlayClock {
  if (clock.endsAt === null) return clock;
  return { endsAt: null, remainingMs: clock.endsAt - now };
}

/** +1 min / −1 min while running or paused. */
export function addTime(clock: OverlayClock, deltaMs: number): OverlayClock {
  return clock.endsAt !== null
    ? { endsAt: clock.endsAt + deltaMs, remainingMs: clock.remainingMs + deltaMs }
    : { endsAt: null, remainingMs: clock.remainingMs + deltaMs };
}

/**
 * "4:59" counting down; whole seconds are rounded up so the display reaches
 * 0:00 exactly at the end. Over time it counts up: "+0:12".
 */
export function formatClockMs(ms: number): string {
  const over = ms < 0;
  const totalSeconds = over ? Math.floor(-ms / 1000) : Math.ceil(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const body = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  return over ? `+${body}` : body;
}

export type TimerTone = 'ok' | 'warn' | 'over';

export function timerTone(remainingMs: number, warnMs: number): TimerTone {
  if (remainingMs < 0) return 'over';
  if (remainingMs <= warnMs) return 'warn';
  return 'ok';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function number(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

export function parseCaption(raw: unknown): { title: string; subtitle: string } | undefined {
  if (!isRecord(raw)) return undefined;
  const title = text(raw.title, 80);
  const subtitle = text(raw.subtitle, 120);
  return title ? { title, subtitle } : undefined;
}

/** Validates the show file's on-air section. */
export function parseOnAir(raw: unknown): OnAirSettings {
  if (!isRecord(raw)) return { ...DEFAULT_ON_AIR, captions: [] };
  const seen = new Set<string>();
  const captions: CaptionItem[] = [];
  if (Array.isArray(raw.captions)) {
    for (const entry of raw.captions) {
      if (!isRecord(entry)) continue;
      const id = text(entry.id, 64);
      const caption = parseCaption(entry);
      if (!id || !caption || seen.has(id)) continue;
      seen.add(id);
      captions.push({ id, ...caption });
      if (captions.length >= 300) break;
    }
  }
  const style: CaptionStyle = raw.captionStyle === 'glass' ? 'glass' : 'bar';
  return {
    captions,
    captionStyle: style,
    timerMinutes: number(raw.timerMinutes, DEFAULT_ON_AIR.timerMinutes, 0.5, 600),
    timerWarnSeconds: number(raw.timerWarnSeconds, DEFAULT_ON_AIR.timerWarnSeconds, 0, 3600),
    countdownMinutes: number(raw.countdownMinutes, DEFAULT_ON_AIR.countdownMinutes, 0.5, 600),
    countdownMessage: text(raw.countdownMessage, 80) || DEFAULT_ON_AIR.countdownMessage
  };
}
