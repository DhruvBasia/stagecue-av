import { describe, expect, it } from 'vitest';
import {
  addTime,
  clockRemaining,
  DEFAULT_ON_AIR,
  formatClockMs,
  isRunning,
  newClock,
  parseCaption,
  parseOnAir,
  pauseClock,
  startClock,
  timerTone
} from '../../src/renderer/src/services/onAir';
import { createCue } from '../../src/renderer/src/services/cueManager';
import { DEFAULT_MIX } from '../../src/renderer/src/services/audioEngine';
import { parseShowFile, serializeShow } from '../../src/renderer/src/services/storage';

describe('speaker timer and countdown clocks', () => {
  it('counts down while running and holds while paused', () => {
    let clock = newClock(5 * 60_000);
    expect(isRunning(clock)).toBe(false);
    expect(clockRemaining(clock, 1_000)).toBe(300_000);
    clock = startClock(clock, 10_000);
    expect(clockRemaining(clock, 70_000)).toBe(240_000);
    clock = pauseClock(clock, 70_000);
    expect(clockRemaining(clock, 999_999)).toBe(240_000);
    clock = startClock(clock, 100_000);
    expect(clockRemaining(clock, 340_000)).toBe(0);
    // Keeps going into over-time.
    expect(clockRemaining(clock, 352_000)).toBe(-12_000);
  });

  it('adds or removes time whether running or paused', () => {
    expect(clockRemaining(addTime(newClock(60_000), 60_000), 0)).toBe(120_000);
    const running = startClock(newClock(60_000), 0);
    expect(clockRemaining(addTime(running, 60_000), 30_000)).toBe(90_000);
  });

  it('shows minutes:seconds, reaching 0:00 exactly at the end, then counts over time', () => {
    expect(formatClockMs(300_000)).toBe('5:00');
    expect(formatClockMs(299_001)).toBe('5:00');
    expect(formatClockMs(59_000)).toBe('0:59');
    expect(formatClockMs(1)).toBe('0:01');
    expect(formatClockMs(0)).toBe('0:00');
    expect(formatClockMs(-12_400)).toBe('+0:12');
    expect(formatClockMs(3_725_000)).toBe('1:02:05');
  });

  it('turns amber in the warning time and red when over', () => {
    expect(timerTone(61_000, 60_000)).toBe('ok');
    expect(timerTone(60_000, 60_000)).toBe('warn');
    expect(timerTone(0, 60_000)).toBe('warn');
    expect(timerTone(-1, 60_000)).toBe('over');
  });
});

describe('on-air settings in the show file', () => {
  it('cleans up untrusted values', () => {
    expect(parseOnAir(null)).toEqual(DEFAULT_ON_AIR);
    const parsed = parseOnAir({
      captions: [
        { id: 'a', title: '  Prof. Mahesh Verma ', subtitle: 'Vice Chancellor' },
        { id: 'a', title: 'duplicate id', subtitle: '' },
        { id: 'b', title: '', subtitle: 'no name' },
        { id: 'c', title: 'Dr. Kamal Pathak' },
        'junk'
      ],
      captionStyle: 'neon',
      timerMinutes: -4,
      timerWarnSeconds: 30,
      countdownMinutes: 'ten',
      countdownMessage: '   '
    });
    expect(parsed.captions).toEqual([
      { id: 'a', title: 'Prof. Mahesh Verma', subtitle: 'Vice Chancellor' },
      { id: 'c', title: 'Dr. Kamal Pathak', subtitle: '' }
    ]);
    expect(parsed).toMatchObject({ captionStyle: 'bar', timerMinutes: 0.5, timerWarnSeconds: 30, countdownMinutes: 5 });
    expect(parsed.countdownMessage).toBe(DEFAULT_ON_AIR.countdownMessage);
    expect(parseCaption({ title: '', subtitle: 'x' })).toBeUndefined();
  });

  it('saves captions, presets and cue captions with the show', () => {
    const onAir = {
      captions: [{ id: 'vc', title: 'Prof. Mahesh Verma', subtitle: 'Vice Chancellor' }],
      captionStyle: 'glass' as const,
      timerMinutes: 7,
      timerWarnSeconds: 90,
      countdownMinutes: 10,
      countdownMessage: 'Annual Day begins in'
    };
    const cue = { ...createCue({ id: 'c1', label: 'Welcome address' }, 1), caption: { title: 'Dr. Kamal Pathak', subtitle: 'Registrar' } };
    const reopened = parseShowFile(JSON.stringify(serializeShow({ name: 'Annual Day', media: [], cues: [cue], mix: DEFAULT_MIX, onAir })));
    expect(reopened.onAir).toEqual(onAir);
    expect(reopened.cues[0].caption).toEqual({ title: 'Dr. Kamal Pathak', subtitle: 'Registrar' });
  });
});
