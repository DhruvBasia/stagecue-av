import { describe, expect, it } from 'vitest';
import { classifyFocus, matchHotkey, type KeyEventLike } from '../../src/renderer/src/services/hotkeyManager';

function key(code: string, keyName: string, extra: Partial<KeyEventLike> = {}): KeyEventLike {
  return { code, key: keyName, repeat: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...extra };
}

const idle = { focus: 'none' as const, modalOpen: false };

describe('hotkey matching', () => {
  it('maps the emergency keys', () => {
    expect(matchHotkey(key('Space', ' '), idle)?.action).toBe('take');
    expect(matchHotkey(key('F8', 'F8'), idle)?.action).toBe('freeze');
    expect(matchHotkey(key('Escape', 'Escape'), idle)?.action).toBe('blackout');
    expect(matchHotkey(key('F4', 'F4'), idle)?.action).toBe('instant-backdrop');
    expect(matchHotkey(key('F9', 'F9'), idle)?.action).toBe('fade-audio');
    expect(matchHotkey(key('KeyP', 'P', { shiftKey: true }), idle)?.action).toBe('toggle-video');
    expect(matchHotkey(key('KeyP', 'p'), idle)).toBeNull();
  });

  it('ignores auto-repeat so a held Space cannot skip cues', () => {
    expect(matchHotkey(key('Space', ' ', { repeat: true }), idle)).toBeNull();
    expect(matchHotkey(key('ArrowDown', 'ArrowDown', { repeat: true }), idle)?.action).toBe('next-cue');
  });

  it('keeps typing safe but emergency keys always live', () => {
    const typing = { focus: 'text' as const, modalOpen: false };
    expect(matchHotkey(key('Space', ' '), typing)).toBeNull();
    expect(matchHotkey(key('Escape', 'Escape'), typing)).toBeNull();
    expect(matchHotkey(key('F8', 'F8'), typing)?.action).toBe('freeze');
    expect(matchHotkey(key('F4', 'F4'), typing)?.action).toBe('instant-backdrop');
  });

  it('defers to open dialogs except for F-key emergencies', () => {
    const modal = { focus: 'none' as const, modalOpen: true };
    expect(matchHotkey(key('Space', ' '), modal)).toBeNull();
    expect(matchHotkey(key('Escape', 'Escape'), modal)).toBeNull();
    expect(matchHotkey(key('F9', 'F9'), modal)?.action).toBe('fade-audio');
  });

  it('Space on a focused button TAKEs instead of clicking; arrows stay with sliders', () => {
    expect(matchHotkey(key('Space', ' '), { focus: 'control', modalOpen: false })?.action).toBe('take');
    expect(matchHotkey(key('ArrowUp', 'ArrowUp'), { focus: 'slider', modalOpen: false })).toBeNull();
  });

  it('never steals OS/menu shortcuts', () => {
    expect(matchHotkey(key('Space', ' ', { ctrlKey: true }), idle)).toBeNull();
    expect(matchHotkey(key('F4', 'F4', { altKey: true }), idle)).toBeNull();
  });

  it('classifies focus targets', () => {
    expect(classifyFocus(null)).toBe('none');
    expect(classifyFocus({ tagName: 'INPUT', type: 'search' })).toBe('text');
    expect(classifyFocus({ tagName: 'INPUT', type: 'range' })).toBe('slider');
    expect(classifyFocus({ tagName: 'INPUT', type: 'checkbox' })).toBe('control');
    expect(classifyFocus({ tagName: 'TEXTAREA' })).toBe('text');
    expect(classifyFocus({ tagName: 'BUTTON' })).toBe('control');
    expect(classifyFocus({ tagName: 'DIV', isContentEditable: true })).toBe('text');
  });
});
