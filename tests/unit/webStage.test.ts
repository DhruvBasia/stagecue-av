import { describe, expect, it, vi } from 'vitest';
import { isCaptureResolveRequest, isWebAddress, parseWebInput, sanitizeWebview, WEB_PARTITION } from '../../src/main/webStage';

describe('web pages on stage: main-process guards', () => {
  it('only shows http(s) pages', () => {
    expect(isWebAddress('https://fests.ggsipuedc.workers.dev/netted-bytes')).toBe(true);
    expect(isWebAddress('http://192.168.1.20:8080/')).toBe(true);
    expect(isWebAddress('file:///C:/Windows/win.ini')).toBe(false);
    expect(isWebAddress('javascript:alert(1)')).toBe(false);
    expect(isWebAddress(`https://example.com/${'a'.repeat(3000)}`)).toBe(false);
    expect(isWebAddress(42)).toBe(false);
  });

  it('accepts only well-formed operator input, clamped to the page', () => {
    expect(parseWebInput({ type: 'pointer', phase: 'down', x: 0.25, y: 1.4 })).toEqual({ type: 'pointer', phase: 'down', x: 0.25, y: 1 });
    expect(parseWebInput({ type: 'pointer', phase: 'tap', x: 0.5, y: 0.5 })).toBeNull();
    expect(parseWebInput({ type: 'wheel', x: 0.5, y: 0.5, deltaY: 99999 })).toEqual({ type: 'wheel', x: 0.5, y: 0.5, deltaY: 2000 });
    expect(parseWebInput({ type: 'key', key: 'ArrowRight' })).toEqual({ type: 'key', key: 'ArrowRight' });
    expect(parseWebInput({ type: 'key', key: 'F12' })).toBeNull();
    expect(parseWebInput({ type: 'nav', action: 'home' })).toEqual({ type: 'nav', action: 'home' });
    expect(parseWebInput({ type: 'nav', action: 'devtools' })).toBeNull();
    expect(parseWebInput({ type: 'mute', muted: 'yes' })).toBeNull();
    expect(parseWebInput({ type: 'eval', code: 'x' })).toBeNull();
    expect(parseWebInput(null)).toBeNull();
  });

  it('lets the stage embed only sandboxed pages in the web partition', () => {
    expect(WEB_PARTITION).toBe('persist:stagecue-web');
    const allowed = { preventDefault: vi.fn() };
    const prefs: Record<string, unknown> = { preload: 'C:\\evil.js', nodeIntegration: true, contextIsolation: false, sandbox: false };
    sanitizeWebview(allowed as never, prefs as never, { src: 'https://example.com/mag', partition: WEB_PARTITION });
    expect(allowed.preventDefault).not.toHaveBeenCalled();
    expect(prefs).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true });
    expect(prefs).not.toHaveProperty('preload');

    const wrongPartition = { preventDefault: vi.fn() };
    sanitizeWebview(wrongPartition as never, {} as never, { src: 'https://example.com', partition: 'persist:other' });
    expect(wrongPartition.preventDefault).toHaveBeenCalled();
    const fileSrc = { preventDefault: vi.fn() };
    sanitizeWebview(fileSrc as never, {} as never, { src: 'file:///C:/x.html', partition: WEB_PARTITION });
    expect(fileSrc.preventDefault).toHaveBeenCalled();
  });

  it('validates capture lookups', () => {
    expect(isCaptureResolveRequest({ sourceId: 'window:1:0', name: 'Chrome', kind: 'window' })).toBe(true);
    expect(isCaptureResolveRequest({ sourceId: 'window:1:0', name: 'Chrome', kind: 'camera' })).toBe(false);
    expect(isCaptureResolveRequest('window:1:0')).toBe(false);
  });
});
