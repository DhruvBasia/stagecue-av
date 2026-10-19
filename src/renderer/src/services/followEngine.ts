import type { CueItem, FollowMode, StageCuePayload } from '../types';
import { clamp } from './utils';

/* =========================================================================
 * Auto-follow rules (pure). The operator store owns the timer; these
 * functions decide *what* should happen.
 *
 *  - Nothing ever auto-fires while the master switch is OFF.
 *  - A pending follow pauses while the stage is frozen or blacked out and
 *    resumes (with the time it had left) when that is lifted.
 *  - A manual TAKE, F4 (instant backdrop) or a newer take cancels it.
 * ========================================================================= */

export const MIN_FOLLOW_DELAY_SEC = 1;
export const MAX_FOLLOW_DELAY_SEC = 3600;
export const DEFAULT_FOLLOW_DELAY_SEC = 10;

export interface FollowPlan {
  takeId: number;
  sourceCueId: string;
  targetCueId: string;
  mode: Exclude<FollowMode, 'off'>;
  delayMs: number;
}

export interface PendingFollow extends FollowPlan {
  /** Wall-clock time the delay elapses (null while paused or for 'on-end'). */
  dueAt: number | null;
  /** Remaining delay while paused. */
  remainingMs: number;
  /** The cue's video has finished ('on-end'). */
  videoEnded: boolean;
}

export type FollowBlock = 'disabled' | 'frozen' | 'blackout' | null;

export function followDelayMs(cue: Pick<CueItem, 'followDelaySec'>): number {
  return Math.round(clamp(cue.followDelaySec ?? DEFAULT_FOLLOW_DELAY_SEC, MIN_FOLLOW_DELAY_SEC, MAX_FOLLOW_DELAY_SEC) * 1000);
}

/** The explicit target if it still exists, otherwise the next cue in the stack (null after the last one). */
export function resolveFollowTarget(cues: readonly CueItem[], cue: CueItem): CueItem | null {
  if (cue.followTargetId && cue.followTargetId !== cue.id) {
    const explicit = cues.find((c) => c.id === cue.followTargetId);
    if (explicit) return explicit;
  }
  const ordered = [...cues].sort((a, b) => a.order - b.order);
  const index = ordered.findIndex((c) => c.id === cue.id);
  return index >= 0 && index < ordered.length - 1 ? ordered[index + 1] : null;
}

export function planFollow(cues: readonly CueItem[], cue: CueItem, payload: StageCuePayload): FollowPlan | null {
  const mode = cue.followMode ?? 'off';
  if (mode === 'off') return null;
  // "When the video ends" needs a video; otherwise the cue simply waits for the operator.
  if (mode === 'on-end' && !payload.foreground) return null;
  const target = resolveFollowTarget(cues, cue);
  if (!target) return null;
  return {
    takeId: payload.takeId,
    sourceCueId: cue.id,
    targetCueId: target.id,
    mode,
    delayMs: mode === 'after-delay' ? followDelayMs(cue) : 0
  };
}

export function startFollow(plan: FollowPlan, now: number): PendingFollow {
  return {
    ...plan,
    dueAt: plan.mode === 'after-delay' ? now + plan.delayMs : null,
    remainingMs: plan.delayMs,
    videoEnded: false
  };
}

export function followBlock(state: { autoFollowEnabled: boolean; isFrozen: boolean; isBlackout: boolean }): FollowBlock {
  if (!state.autoFollowEnabled) return 'disabled';
  if (state.isFrozen) return 'frozen';
  if (state.isBlackout) return 'blackout';
  return null;
}

/** Freezes the countdown (keeps the remaining time). */
export function pauseFollow(pending: PendingFollow, now: number): PendingFollow {
  if (pending.dueAt === null) return pending;
  return { ...pending, dueAt: null, remainingMs: Math.max(0, pending.dueAt - now) };
}

/** Restarts the countdown from the remaining time. */
export function resumeFollow(pending: PendingFollow, now: number): PendingFollow {
  if (pending.mode !== 'after-delay' || pending.dueAt !== null) return pending;
  return { ...pending, dueAt: now + pending.remainingMs };
}

/** Milliseconds until the follow should fire, 0 = now, null = waiting for something (video end / unblock). */
export function msUntilFire(pending: PendingFollow, block: FollowBlock, now: number): number | null {
  if (block !== null) return null;
  if (pending.mode === 'on-end') return pending.videoEnded ? 0 : null;
  if (pending.dueAt === null) return null;
  return Math.max(0, pending.dueAt - now);
}

/** Seconds shown in the UI countdown (also while paused). */
export function followSecondsLeft(pending: PendingFollow | null, now: number): number | null {
  if (!pending || pending.mode !== 'after-delay') return null;
  const ms = pending.dueAt !== null ? pending.dueAt - now : pending.remainingMs;
  return Math.max(0, ms / 1000);
}

export function describeFollow(cue: CueItem, cues: readonly CueItem[]): string | null {
  const mode = cue.followMode ?? 'off';
  if (mode === 'off') return null;
  const target = resolveFollowTarget(cues, cue);
  const where = !target ? 'end of stack' : cue.followTargetId && target.id === cue.followTargetId ? `cue ${target.order}` : 'next';
  return mode === 'on-end' ? `→ ${where} when video ends` : `→ ${where} after ${Math.round(followDelayMs(cue) / 1000)}s`;
}
