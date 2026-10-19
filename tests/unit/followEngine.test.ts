import { describe, expect, it } from 'vitest';
import { applySlideshow, buildCuesFromMedia, DEFAULT_BUILD_OPTIONS } from '../../src/renderer/src/services/cueBuilder';
import { createCue } from '../../src/renderer/src/services/cueManager';
import {
  describeFollow,
  followBlock,
  followSecondsLeft,
  msUntilFire,
  pauseFollow,
  planFollow,
  resolveFollowTarget,
  resumeFollow,
  startFollow
} from '../../src/renderer/src/services/followEngine';
import { analyzeShow, mediaUsedByCues, runPreshowCheck, type PreshowContext } from '../../src/renderer/src/services/preshowCheck';
import { buildRunSheetHtml, escapeHtml, totalVideoSeconds } from '../../src/renderer/src/services/runSheet';
import { matchHotkey, type KeyEventLike } from '../../src/renderer/src/services/hotkeyManager';
import type { CueItem, MediaItem, StageCuePayload } from '../../src/renderer/src/types';

function media(id: string, type: MediaItem['type'], extra: Partial<MediaItem> = {}): MediaItem {
  return { id, name: `${id}.${type === 'image' ? 'png' : type === 'video' ? 'mp4' : 'mp3'}`, filePath: `C:\\show\\${id}`, fileUrl: `local-media://media/${id}`, type, ...extra };
}

function payload(takeId: number, withVideo: boolean): StageCuePayload {
  return {
    takeId,
    cueId: 'x',
    label: 'x',
    backdrop: null,
    foreground: withVideo ? media('v', 'video') : null,
    transition: 'cut',
    transitionDurationMs: 0,
    autoPlayForeground: true,
    loopBackdrop: true,
    duckAudioOnVideo: true
  };
}

const stack: CueItem[] = [
  createCue({ id: 'a', label: 'Welcome', backdropMediaId: 'poster', followMode: 'after-delay', followDelaySec: 8 }, 1),
  createCue({ id: 'b', label: 'Kulgeet', foregroundMediaId: 'kulgeet', followMode: 'on-end' }, 2),
  createCue({ id: 'c', label: 'Sponsor', backdropMediaId: 'sponsor', followMode: 'after-delay', followDelaySec: 5, followTargetId: 'a' }, 3),
  createCue({ id: 'd', label: 'Closing', backdropMediaId: 'poster' }, 4)
];

describe('auto-follow rules', () => {
  it('targets the next cue, or an explicit cue for loops', () => {
    expect(resolveFollowTarget(stack, stack[0])?.id).toBe('b');
    expect(resolveFollowTarget(stack, stack[2])?.id).toBe('a');
    expect(resolveFollowTarget(stack, stack[3])).toBeNull();
    expect(resolveFollowTarget(stack, { ...stack[0], followTargetId: 'deleted' })?.id).toBe('b');
    expect(resolveFollowTarget(stack, { ...stack[0], followTargetId: 'a' })?.id).toBe('b'); // never itself
  });

  it('plans timed and end-of-video follows', () => {
    expect(planFollow(stack, stack[0], payload(4, false))).toEqual({
      takeId: 4,
      sourceCueId: 'a',
      targetCueId: 'b',
      mode: 'after-delay',
      delayMs: 8000
    });
    expect(planFollow(stack, stack[1], payload(5, true))?.mode).toBe('on-end');
    // "when video ends" without a video simply waits for the operator
    expect(planFollow(stack, stack[1], payload(5, false))).toBeNull();
    expect(planFollow(stack, stack[3], payload(6, false))).toBeNull();
  });

  it('counts down, pauses with the time left and resumes', () => {
    const plan = planFollow(stack, stack[0], payload(1, false));
    if (!plan) throw new Error('expected a plan');
    const started = startFollow(plan, 1000);
    expect(msUntilFire(started, null, 3000)).toBe(6000);
    expect(followSecondsLeft(started, 3000)).toBe(6);

    const paused = pauseFollow(started, 4000);
    expect(paused.dueAt).toBeNull();
    expect(paused.remainingMs).toBe(5000);
    expect(msUntilFire(paused, 'frozen', 9000)).toBeNull();
    expect(followSecondsLeft(paused, 60_000)).toBe(5);

    const resumed = resumeFollow(paused, 20_000);
    expect(resumed.dueAt).toBe(25_000);
    expect(msUntilFire(resumed, null, 24_000)).toBe(1000);
  });

  it('fires on-end follows only after the video finished', () => {
    const plan = planFollow(stack, stack[1], payload(2, true));
    if (!plan) throw new Error('expected a plan');
    const pending = startFollow(plan, 0);
    expect(msUntilFire(pending, null, 99_999)).toBeNull();
    expect(msUntilFire({ ...pending, videoEnded: true }, null, 0)).toBe(0);
    expect(msUntilFire({ ...pending, videoEnded: true }, 'blackout', 0)).toBeNull();
  });

  it('the master switch, freeze and blackout block automation', () => {
    expect(followBlock({ autoFollowEnabled: false, isFrozen: false, isBlackout: false })).toBe('disabled');
    expect(followBlock({ autoFollowEnabled: true, isFrozen: true, isBlackout: true })).toBe('frozen');
    expect(followBlock({ autoFollowEnabled: true, isFrozen: false, isBlackout: true })).toBe('blackout');
    expect(followBlock({ autoFollowEnabled: true, isFrozen: false, isBlackout: false })).toBeNull();
  });

  it('describes rules for the cue stack', () => {
    expect(describeFollow(stack[0], stack)).toBe('→ next after 8s');
    expect(describeFollow(stack[1], stack)).toBe('→ next when video ends');
    expect(describeFollow(stack[2], stack)).toBe('→ cue 1 after 5s');
    expect(describeFollow(stack[3], stack)).toBeNull();
  });

  it('builds looping slideshows from a folder', () => {
    const items = [media('p1', 'image'), media('promo', 'video'), media('p2', 'image')];
    let n = 0;
    const cues = buildCuesFromMedia(items, [], { ...DEFAULT_BUILD_OPTIONS, slideshow: true, slideshowSeconds: 6 }, () => `s${(n += 1)}`);
    expect(cues.map((c) => [c.followMode, c.followDelaySec, c.followTargetId])).toEqual([
      ['after-delay', 6, undefined],
      ['on-end', 10, undefined],
      ['after-delay', 6, 's1']
    ]);
    const noLoop = applySlideshow(cues, { slideshowSeconds: 6, slideshowLoop: false });
    expect(noLoop[2].followMode).toBe('off');
  });
});

describe('pre-show check', () => {
  const library = [
    media('poster', 'image'),
    media('kulgeet', 'video', { duration: 185 }),
    media('track', 'audio', { duration: 200 }),
    media('gone', 'image', { missing: true }),
    media('broken', 'video')
  ];
  const ctx = (patch: Partial<PreshowContext> = {}): PreshowContext => ({
    cues: [
      createCue({ id: 'c1', backdropMediaId: 'poster', audioMediaId: 'track' }, 1),
      createCue({ id: 'c2', foregroundMediaId: 'kulgeet', followMode: 'on-end' }, 2),
      createCue({ id: 'c3', backdropMediaId: 'gone' }, 3),
      createCue({ id: 'c4', foregroundMediaId: 'broken' }, 4)
    ],
    items: library,
    displayStatus: null,
    stageLinkOk: true,
    audioContextState: 'running',
    outputPref: null,
    outputMissing: false,
    isDirty: false,
    ...patch
  });

  it('flags projector, audio and cue configuration problems', () => {
    const issues = analyzeShow(
      ctx({
        stageLinkOk: false,
        audioContextState: 'suspended',
        outputPref: { deviceId: 'usb', label: 'USB Audio' },
        outputMissing: true,
        isDirty: true,
        cues: [
          createCue({ id: 'e', label: 'Empty' }, 1),
          createCue({ id: 'w', backdropMediaId: 'track' }, 2),
          createCue({ id: 'f', backdropMediaId: 'poster', followMode: 'on-end', followTargetId: 'deleted' }, 3),
          createCue({ id: 'v', audioMediaId: 'track', audioVolume: 0 }, 4)
        ]
      })
    );
    const titles = issues.map((i) => `${i.level}:${i.title}`);
    expect(titles).toContain('warning:No projector detected');
    expect(titles).toContain('error:Stage window not responding');
    expect(titles).toContain('error:Audio engine not running');
    expect(titles).toContain('error:Audio device “USB Audio” not connected');
    expect(titles).toContain('info:Unsaved changes');
    expect(titles).toContain('warning:Cue 1 “Empty” is empty');
    expect(titles.some((t) => t.startsWith('error:Cue 2') && t.includes('wrong file type'))).toBe(true);
    expect(titles.some((t) => t.includes('follows “when video ends” but has no video'))).toBe(true);
    expect(titles.some((t) => t.includes('follow target was deleted'))).toBe(true);
    expect(titles.some((t) => t.includes('music level is 0 %'))).toBe(true);
  });

  it('decodes every used file once and reports missing and broken media', async () => {
    const probed: string[] = [];
    const report = await runPreshowCheck(ctx({ displayStatus: null }), {
      findMissingFiles: async (items) => new Set(items.filter((i) => i.id === 'track').map((i) => i.id)),
      probe: async (item) => {
        probed.push(item.id);
        return item.id === 'broken'
          ? { ok: false, problem: 'Codec/format not supported by the player' }
          : { ok: true, duration: item.duration, dimensions: item.id === 'poster' ? { width: 9000, height: 5000 } : undefined };
      }
    });
    expect(mediaUsedByCues(ctx().cues, library).map((m) => m.id)).toEqual(['poster', 'track', 'kulgeet', 'gone', 'broken']);
    expect(probed).toEqual(['poster', 'kulgeet', 'broken']);
    const titles = report.issues.map((i) => i.title);
    expect(titles).toContain('File not found: track.mp3');
    expect(titles).toContain('File not found: gone.png');
    expect(titles).toContain('Will not play: broken.mp4');
    expect(titles).toContain('Very large image: poster.png');
    expect(report.ready).toBe(false);
    expect(report.issues[0].level).toBe('error');
    expect(report.errors).toBe(3);
  });

  it('reports ready when everything passes', async () => {
    const report = await runPreshowCheck(
      ctx({
        displayStatus: {
          mode: 'projector',
          displays: [],
          stageDisplayId: 2,
          operatorDisplayId: 1,
          preferredStageDisplayId: null,
          reason: 'startup',
          changedAt: 0
        },
        cues: [createCue({ id: 'c1', backdropMediaId: 'poster' }, 1)]
      }),
      { findMissingFiles: async () => new Set(), probe: async () => ({ ok: true }) }
    );
    expect(report).toMatchObject({ ready: true, errors: 0, warnings: 0, cuesChecked: 1, mediaChecked: 1 });
  });
});

describe('run sheet', () => {
  it('lists every cue with media, music level, follow rule and notes, safely escaped', () => {
    const items = [
      media('poster', 'image', { name: 'Welcome <b>.png', thumbnailUrl: 'data:image/jpeg;base64,QUJD' }),
      media('kulgeet', 'video', { duration: 185 }),
      media('track', 'audio')
    ];
    const cues = [
      createCue({ id: 'a', label: 'Walk-in & seating', backdropMediaId: 'poster', audioMediaId: 'track', audioVolume: 0.6, notes: 'Wait for "VIPs"' }, 1),
      createCue({ id: 'b', label: 'Kulgeet', foregroundMediaId: 'kulgeet', followMode: 'on-end' }, 2),
      createCue({ id: 'c', label: 'Closing', backdropMediaId: 'poster' }, 3)
    ];
    const html = buildRunSheetHtml({ showName: 'Convocation <2026>', cues, items, autoFollowEnabled: true, generatedAt: new Date('2026-10-14T10:00:00Z') });
    expect(html).toContain('Convocation &lt;2026&gt;');
    expect(html).toContain('Walk-in &amp; seating');
    expect(html).toContain('Welcome &lt;b&gt;.png');
    expect(html).toContain('Wait for &quot;VIPs&quot;');
    expect(html).toContain('60%');
    expect(html).toContain('next when video ends');
    expect(html).toContain('03:05');
    expect(html).toContain('<img src="data:image/jpeg;base64,QUJD"');
    expect(html).toContain('Auto-follow: ON');
    expect(html).not.toContain('<b>');
    expect(totalVideoSeconds(cues, items)).toBe(185);
    expect(escapeHtml(`<'&">`)).toBe('&lt;&#39;&amp;&quot;&gt;');
  });

  it('never embeds non-image data URLs', () => {
    const items = [media('poster', 'image', { thumbnailUrl: 'javascript:alert(1)' })];
    const html = buildRunSheetHtml({
      showName: 'x',
      cues: [createCue({ id: 'a', backdropMediaId: 'poster' }, 1)],
      items,
      autoFollowEnabled: false,
      generatedAt: new Date()
    });
    expect(html).not.toContain('javascript:');
    expect(html).toContain('class="nothumb"');
  });
});

describe('presentation clicker keys', () => {
  const key = (code: string, k: string): KeyEventLike => ({ code, key: k, repeat: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
  const on = { focus: 'none' as const, modalOpen: false, clickerEnabled: true };
  const off = { ...on, clickerEnabled: false };

  it('maps clicker keys only while the clicker setting is ON', () => {
    expect(matchHotkey(key('PageDown', 'PageDown'), on)?.action).toBe('take');
    expect(matchHotkey(key('ArrowRight', 'ArrowRight'), on)?.action).toBe('take');
    expect(matchHotkey(key('PageUp', 'PageUp'), on)?.action).toBe('prev-cue');
    expect(matchHotkey(key('KeyB', 'b'), on)?.action).toBe('blackout');
    expect(matchHotkey(key('Period', '.'), on)?.action).toBe('blackout');
    expect(matchHotkey(key('PageDown', 'PageDown'), off)).toBeNull();
    expect(matchHotkey(key('KeyB', 'b'), off)).toBeNull();
    // core keys keep working with the clicker OFF
    expect(matchHotkey(key('Space', ' '), off)?.action).toBe('take');
    // never while typing or on a fader
    expect(matchHotkey(key('KeyB', 'b'), { ...on, focus: 'text' })).toBeNull();
    expect(matchHotkey(key('ArrowRight', 'ArrowRight'), { ...on, focus: 'slider' })).toBeNull();
  });
});
