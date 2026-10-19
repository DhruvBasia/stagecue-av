import { describe, expect, it } from 'vitest';
import {
  assignMediaToCue,
  buildAdHocPayload,
  buildCuePayload,
  createCue,
  createInitialProgram,
  detachMediaFromCues,
  duplicateCue,
  getIndexAfterTake,
  getNextCueIndex,
  getVisibleView,
  insertCue,
  moveCue,
  planTransition,
  programReducer,
  removeCue,
  renumberCues,
  type MediaLookup,
  type ProgramState
} from '../../src/renderer/src/services/cueManager';
import type { CueItem, MediaItem } from '../../src/renderer/src/types';

/* ------------------------------ Fixtures --------------------------------- */

function media(id: string, type: MediaItem['type'], extra: Partial<MediaItem> = {}): MediaItem {
  return {
    id,
    name: `${id}.${type === 'image' ? 'png' : type === 'video' ? 'mp4' : 'mp3'}`,
    filePath: `/show/${id}`,
    fileUrl: `local-media://media/${id}`,
    type,
    thumbnailUrl: 'data:image/jpeg;base64,AAAA',
    ...extra
  };
}

const poster = media('poster', 'image');
const welcome = media('welcome', 'image');
const kulgeet = media('kulgeet', 'video', { duration: 185 });
const promo = media('promo', 'video', { duration: 60 });
const walkIn = media('walkin', 'audio');
const ghost = media('ghost', 'video', { missing: true });

const library = new Map<string, MediaItem>([poster, welcome, kulgeet, promo, walkIn, ghost].map((m) => [m.id, m]));
const lookup: MediaLookup = (id) => (id ? library.get(id) ?? null : null);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function stack(): CueItem[] {
  return [
    createCue({ id: 'c1', label: 'Walk-in poster', backdropMediaId: 'poster', audioMediaId: 'walkin' }, 1),
    createCue({ id: 'c2', label: 'Kulgeet', foregroundMediaId: 'kulgeet', transition: 'fade', transitionDurationMs: 1000 }, 2),
    createCue({ id: 'c3', label: 'Welcome slide', backdropMediaId: 'welcome', transition: 'cut' }, 3)
  ];
}

function take(program: ProgramState, cue: CueItem): ProgramState {
  return programReducer(program, { type: 'TAKE', payload: buildCuePayload(cue, lookup, program, program.takeId + 1) });
}

/* -------------------------------- Tests ---------------------------------- */

describe('cue stack progression', () => {
  it('advances, clamps at the ends and starts from the top', () => {
    expect(getNextCueIndex(3, -1, 1)).toBe(0);
    expect(getNextCueIndex(3, -1, -1)).toBe(2);
    expect(getNextCueIndex(3, 0, 1)).toBe(1);
    expect(getNextCueIndex(3, 2, 1)).toBe(2);
    expect(getNextCueIndex(3, 0, -1)).toBe(0);
    expect(getNextCueIndex(0, 0, 1)).toBe(-1);
  });

  it('highlights the following cue after a TAKE and holds on the last one', () => {
    const cues = stack();
    expect(getIndexAfterTake(cues, 'c1')).toBe(1);
    expect(getIndexAfterTake(cues, 'c2')).toBe(2);
    expect(getIndexAfterTake(cues, 'c3')).toBe(2);
    expect(getIndexAfterTake(cues, 'unknown')).toBe(0);
  });

  it('inserts, moves, duplicates and removes while keeping order contiguous', () => {
    const cues = deepFreeze(stack());
    const inserted = insertCue(cues, createCue({ id: 'c1b', label: 'Speech' }, 99), 'c1');
    expect(inserted.map((c) => c.id)).toEqual(['c1', 'c1b', 'c2', 'c3']);
    expect(inserted.map((c) => c.order)).toEqual([1, 2, 3, 4]);

    const moved = moveCue(inserted, 'c3', -2);
    expect(moved.map((c) => c.id)).toEqual(['c1', 'c3', 'c1b', 'c2']);
    expect(moved.map((c) => c.order)).toEqual([1, 2, 3, 4]);
    expect(moveCue(moved, 'c1', -5).map((c) => c.id)).toEqual(['c1', 'c3', 'c1b', 'c2']);

    const duplicated = duplicateCue(moved, 'c3', 'c3copy');
    expect(duplicated.map((c) => c.id)).toEqual(['c1', 'c3', 'c3copy', 'c1b', 'c2']);
    expect(duplicated[2].label).toBe('Welcome slide (copy)');
    expect(duplicated[2].backdropMediaId).toBe('welcome');

    const removed = removeCue(duplicated, 'c1b');
    expect(removed.map((c) => c.order)).toEqual([1, 2, 3, 4]);
    expect(renumberCues(removed)).toEqual(removed);
  });

  it('assigns dropped media to the matching slot and detaches deleted media', () => {
    let cue = createCue({ id: 'x' }, 1);
    cue = assignMediaToCue(cue, poster);
    cue = assignMediaToCue(cue, kulgeet);
    cue = assignMediaToCue(cue, walkIn);
    expect(cue).toMatchObject({ backdropMediaId: 'poster', foregroundMediaId: 'kulgeet', audioMediaId: 'walkin' });

    const [detached] = detachMediaFromCues([cue], 'kulgeet');
    expect(detached.foregroundMediaId).toBeUndefined();
    expect(detached.backdropMediaId).toBe('poster');
  });

  it('creates sane defaults and clamps values', () => {
    const cue = createCue({ id: 'd', audioVolume: 4, transition: 'dissolve', transitionDurationMs: 99_999 }, 7);
    expect(cue.label).toBe('Cue 7');
    expect(cue.audioVolume).toBe(1);
    expect(cue.transitionDurationMs).toBe(10_000);
    expect(createCue({ id: 'e', transition: 'cut', transitionDurationMs: 900 }, 1).transitionDurationMs).toBe(0);
  });
});

describe('TAKE & auto-return logic', () => {
  it('builds stage payloads with backdrop tracking and without UI-only data', () => {
    const cues = stack();
    let program = createInitialProgram();
    program = take(program, cues[0]);
    expect(program.backdrop?.id).toBe('poster');
    expect(program.backdrop?.thumbnailUrl).toBeUndefined();
    expect(program.liveCueId).toBe('c1');

    // Kulgeet has no backdrop → poster keeps showing behind the video
    const payload = buildCuePayload(cues[1], lookup, program, 2);
    expect(payload.backdrop?.id).toBe('poster');
    expect(payload.foreground?.id).toBe('kulgeet');
    expect(payload.transition).toBe('fade');
    expect(payload.transitionDurationMs).toBe(1000);

    program = programReducer(program, { type: 'TAKE', payload });
    expect(program.foreground?.id).toBe('kulgeet');

    // Next cue without a foreground clears the video
    program = take(program, cues[2]);
    expect(program.foreground).toBeNull();
    expect(program.backdrop?.id).toBe('welcome');
    expect(program.transitionDurationMs).toBe(0);
  });

  it('never sends missing or wrongly-typed media to the stage', () => {
    const cue = createCue({ id: 'bad', foregroundMediaId: 'ghost', backdropMediaId: 'walkin' }, 1);
    const program = programReducer(createInitialProgram(), {
      type: 'TAKE',
      payload: buildAdHocPayload(poster, createInitialProgram(), 1)
    });
    const payload = buildCuePayload(cue, lookup, program, 2);
    expect(payload.foreground).toBeNull();
    expect(payload.backdrop?.id).toBe('poster');
  });

  it('auto-returns to the backdrop when the current video ends', () => {
    const cues = stack();
    let program = take(take(createInitialProgram(), cues[0]), cues[1]);
    const ended = programReducer(program, { type: 'FOREGROUND_ENDED', mediaId: 'kulgeet', takeId: program.takeId });
    expect(ended.foreground).toBeNull();
    expect(ended.backdrop?.id).toBe('poster');
    program = ended;
    expect(programReducer(program, { type: 'FOREGROUND_ENDED', mediaId: 'kulgeet', takeId: program.takeId })).toBe(program);
  });

  it('ignores stale "ended" events from an earlier take', () => {
    const cues = stack();
    const first = take(take(createInitialProgram(), cues[0]), cues[1]);
    const retaken = take(first, cues[1]);
    const stale = programReducer(retaken, { type: 'FOREGROUND_ENDED', mediaId: 'kulgeet', takeId: first.takeId });
    expect(stale).toBe(retaken);
    expect(stale.foreground?.id).toBe('kulgeet');
  });

  it('ad-hoc takes route videos to the foreground and images to the backdrop', () => {
    const base = take(createInitialProgram(), stack()[0]);
    const video = buildAdHocPayload(promo, base, 5);
    expect(video.foreground?.id).toBe('promo');
    expect(video.backdrop?.id).toBe('poster');
    const still = buildAdHocPayload(welcome, base, 6);
    expect(still.backdrop?.id).toBe('welcome');
    expect(still.foreground).toBeNull();
  });
});

describe('freeze isolation', () => {
  const live = (): ProgramState => deepFreeze(take(take(createInitialProgram(), stack()[0]), stack()[1]));

  it('captures an immutable view of what the audience sees', () => {
    const program = live();
    const frozen = programReducer(program, { type: 'FREEZE', foregroundTime: 42.5, at: 1000 });
    expect(frozen).not.toBe(program);
    expect(program.isFrozen).toBe(false);
    expect(frozen.isFrozen).toBe(true);
    expect(frozen.frozenView).toEqual({
      cueId: 'c2',
      backdrop: program.backdrop,
      foreground: program.foreground,
      foregroundTime: 42.5,
      capturedAt: 1000
    });
    expect(getVisibleView(frozen, 99).foregroundTime).toBe(42.5);
  });

  it('a second freeze is a no-op (no re-capture)', () => {
    const frozen = deepFreeze(programReducer(live(), { type: 'FREEZE', foregroundTime: 10, at: 1 }));
    expect(programReducer(frozen, { type: 'FREEZE', foregroundTime: 50, at: 2 })).toBe(frozen);
  });

  it('the frozen view survives the video ending underneath', () => {
    const frozen = deepFreeze(programReducer(live(), { type: 'FREEZE', foregroundTime: 10, at: 1 }));
    const ended = programReducer(frozen, { type: 'FOREGROUND_ENDED', mediaId: 'kulgeet', takeId: frozen.takeId });
    expect(ended.foreground).toBeNull(); // live state auto-returned
    expect(ended.isFrozen).toBe(true);
    expect(ended.frozenView).toBe(frozen.frozenView); // audience still sees the same still, same object
    expect(getVisibleView(ended, 0).foreground?.id).toBe('kulgeet');
  });

  it('blackout toggles do not disturb the freeze', () => {
    const frozen = deepFreeze(programReducer(live(), { type: 'FREEZE', foregroundTime: 3, at: 1 }));
    const black = programReducer(frozen, { type: 'SET_BLACKOUT', active: true });
    expect(black.isBlackout).toBe(true);
    expect(black.frozenView).toBe(frozen.frozenView);
    expect(programReducer(black, { type: 'SET_BLACKOUT', active: true })).toBe(black);
  });

  it('a TAKE reveals the new cue out of the freeze', () => {
    const frozen = deepFreeze(programReducer(live(), { type: 'FREEZE', foregroundTime: 3, at: 1 }));
    const next = take(frozen, stack()[2]);
    expect(next.isFrozen).toBe(false);
    expect(next.frozenView).toBeNull();
    expect(next.backdrop?.id).toBe('welcome');
  });

  it('instant backdrop drops the video and releases the freeze', () => {
    const frozen = deepFreeze(programReducer(live(), { type: 'FREEZE', foregroundTime: 3, at: 1 }));
    const cleared = programReducer(frozen, { type: 'CLEAR_FOREGROUND' });
    expect(cleared.foreground).toBeNull();
    expect(cleared.isFrozen).toBe(false);
    expect(cleared.backdrop?.id).toBe('poster');
  });

  it('unfreeze is idempotent', () => {
    const program = live();
    expect(programReducer(program, { type: 'UNFREEZE' })).toBe(program);
    const frozen = programReducer(program, { type: 'FREEZE', foregroundTime: 0, at: 0 });
    const thawed = programReducer(frozen, { type: 'UNFREEZE' });
    expect(thawed.isFrozen).toBe(false);
    expect(thawed.frozenView).toBeNull();
  });
});

describe('transition planning', () => {
  it('produces cut / dissolve / fade-through-black timings', () => {
    expect(planTransition('cut', 2000)).toEqual({ outDelayMs: 0, outDurationMs: 0, inDelayMs: 0, inDurationMs: 0, totalMs: 0 });
    expect(planTransition('dissolve', 800)).toEqual({ outDelayMs: 0, outDurationMs: 800, inDelayMs: 0, inDurationMs: 800, totalMs: 800 });
    expect(planTransition('fade', 1001)).toEqual({ outDelayMs: 0, outDurationMs: 501, inDelayMs: 501, inDurationMs: 500, totalMs: 1001 });
  });
});
