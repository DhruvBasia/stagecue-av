import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The display manager must never need Electron at runtime; fail loudly if it tries.
vi.mock('electron', () => {
  throw new Error('displayManager must not import electron at runtime');
});

import {
  applyPlacementToWindow,
  computeStagePlacement,
  describeDisplays,
  DisplayManager,
  DOCKED_SIZE,
  REHEARSAL_SIZE,
  selectDisplays,
  type DisplayLike,
  type ScreenEvent,
  type ScreenLike,
  type StagePlacement,
  type StageWindowLike
} from '../../src/main/displayManager';
import type { DisplayStatus, Rect } from '../../src/renderer/src/types';

/* ------------------------------ Mock screen ------------------------------ */

function display(id: number, x: number, width: number, height: number, extra: Partial<DisplayLike> = {}): DisplayLike {
  return {
    id,
    bounds: { x, y: 0, width, height },
    workArea: { x, y: 0, width, height: height - 40 },
    scaleFactor: 1,
    label: '',
    ...extra
  };
}

const LAPTOP = display(1, 0, 1920, 1080, { label: 'Built-in Retina Display' });
const PROJECTOR = display(2, 1920, 1024, 768, { label: 'EPSON PJ' }); // 4:3 projector
const MONITOR = display(3, -2560, 2560, 1440, { label: 'Dell U2719D' });

class MockScreen extends EventEmitter implements ScreenLike {
  displays: DisplayLike[];
  primaryId: number;

  constructor(displays: DisplayLike[], primaryId: number) {
    super();
    this.displays = displays;
    this.primaryId = primaryId;
  }

  getAllDisplays(): DisplayLike[] {
    return this.displays;
  }

  getPrimaryDisplay(): DisplayLike {
    return this.displays.find((d) => d.id === this.primaryId) ?? this.displays[0];
  }

  plug(d: DisplayLike): void {
    this.displays = [...this.displays, d];
    this.emit('display-added', {}, d);
  }

  unplug(id: number): void {
    const removed = this.displays.find((d) => d.id === id);
    this.displays = this.displays.filter((d) => d.id !== id);
    this.emit('display-removed', {}, removed);
  }

  override on(event: ScreenEvent, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  override removeListener(event: ScreenEvent, listener: (...args: unknown[]) => void): this {
    return super.removeListener(event, listener);
  }
}

class FakeWindow implements StageWindowLike {
  destroyed = false;
  bounds: Rect = { x: 0, y: 0, width: 0, height: 0 };
  fullScreen = false;
  simpleFullScreen = false;
  alwaysOnTop: { flag: boolean; level?: string } = { flag: false };
  resizable = true;
  shadow = true;
  shown = 0;
  log: string[] = [];
  isDestroyed(): boolean {
    return this.destroyed;
  }
  setBounds(bounds: Rect): void {
    this.bounds = { ...bounds };
    this.log.push(`bounds:${bounds.x},${bounds.y},${bounds.width}x${bounds.height}`);
  }
  setFullScreen(flag: boolean): void {
    this.fullScreen = flag;
    this.log.push(`fullscreen:${flag}`);
  }
  isFullScreen(): boolean {
    return this.fullScreen;
  }
  setSimpleFullScreen(flag: boolean): void {
    this.simpleFullScreen = flag;
    this.log.push(`simpleFullscreen:${flag}`);
  }
  isSimpleFullScreen(): boolean {
    return this.simpleFullScreen;
  }
  setAlwaysOnTop(flag: boolean, level?: 'floating' | 'screen-saver'): void {
    this.alwaysOnTop = { flag, level };
  }
  setResizable(resizable: boolean): void {
    this.resizable = resizable;
  }
  setHasShadow(hasShadow: boolean): void {
    this.shadow = hasShadow;
  }
  showInactive(): void {
    this.shown += 1;
  }
}

/* --------------------------------- Tests --------------------------------- */

describe('display selection', () => {
  it('single display → rehearsal, no stage display', () => {
    expect(selectDisplays([LAPTOP], LAPTOP, null)).toEqual({ operator: LAPTOP, stage: null });
  });

  it('laptop + projector → projector hosts the stage', () => {
    const { operator, stage } = selectDisplays([LAPTOP, PROJECTOR], LAPTOP, null);
    expect(operator.id).toBe(1);
    expect(stage?.id).toBe(2);
  });

  it('keeps the operator on the built-in panel even if the projector was made primary', () => {
    const laptop = { ...LAPTOP, internal: true };
    const projector = { ...PROJECTOR, internal: false };
    const { operator, stage } = selectDisplays([laptop, projector], projector, null);
    expect(operator.id).toBe(1);
    expect(stage?.id).toBe(2);
  });

  it('honours an explicit stage display preference and ignores stale ones', () => {
    expect(selectDisplays([LAPTOP, PROJECTOR, MONITOR], LAPTOP, 3).stage?.id).toBe(3);
    // leftmost non-primary display wins by default
    expect(selectDisplays([LAPTOP, PROJECTOR, MONITOR], LAPTOP, null).stage?.id).toBe(3);
    expect(selectDisplays([LAPTOP, PROJECTOR], LAPTOP, 99).stage?.id).toBe(2);
  });

  it('describes displays for the operator UI', () => {
    const info = describeDisplays([PROJECTOR, LAPTOP], LAPTOP.id);
    expect(info.map((d) => d.id)).toEqual([1, 2]);
    expect(info[0]).toMatchObject({ isPrimary: true, isExternal: false, name: 'Built-in Retina Display' });
    expect(info[1]).toMatchObject({ isPrimary: false, isExternal: true, name: 'EPSON PJ' });
    expect(describeDisplays([display(9, 0, 800, 600)], 9)[0].name).toBe('Display 1 (800×600)');
  });
});

describe('stage placement', () => {
  it('pins the stage fullscreen to the external display bounds', () => {
    const placement = computeStagePlacement([LAPTOP, PROJECTOR], LAPTOP, {
      reason: 'startup',
      previousMode: null,
      preferredStageId: null
    });
    expect(placement).toEqual({
      mode: 'projector',
      displayId: 2,
      operatorDisplayId: 1,
      bounds: { x: 1920, y: 0, width: 1024, height: 768 },
      fullscreen: true,
      alwaysOnTop: true
    });
  });

  it('falls back to a centred 1280×720 rehearsal window on a single display', () => {
    const placement = computeStagePlacement([LAPTOP], LAPTOP, { reason: 'startup', previousMode: null, preferredStageId: null });
    expect(placement.mode).toBe('rehearsal');
    expect(placement.fullscreen).toBe(false);
    expect(placement.alwaysOnTop).toBe(false);
    expect(placement.bounds.width).toBe(REHEARSAL_SIZE.width);
    expect(placement.bounds.height).toBe(REHEARSAL_SIZE.height);
    expect(placement.bounds.x).toBe(Math.round((1920 - 1280) / 2));
    expect(placement.bounds.y).toBe(Math.round((1040 - 720) / 2));
  });

  it('shrinks the rehearsal window on small laptop screens, keeping 16:9', () => {
    const small = display(1, 0, 1366, 768);
    const placement = computeStagePlacement([small], small, { reason: 'startup', previousMode: null, preferredStageId: null });
    expect(placement.bounds.width).toBeLessThanOrEqual(1366 - 48);
    expect(placement.bounds.height).toBeLessThanOrEqual(728 - 48);
    expect(placement.bounds.width / placement.bounds.height).toBeCloseTo(16 / 9, 1);
  });

  it('docks a small always-on-top window bottom-right when HDMI is pulled mid-show', () => {
    const placement = computeStagePlacement([LAPTOP], LAPTOP, {
      reason: 'display-removed',
      previousMode: 'projector',
      preferredStageId: null
    });
    expect(placement.mode).toBe('docked');
    expect(placement.alwaysOnTop).toBe(true);
    expect(placement.bounds).toEqual({
      x: 1920 - DOCKED_SIZE.width - 24,
      y: 1040 - DOCKED_SIZE.height - 24,
      width: DOCKED_SIZE.width,
      height: DOCKED_SIZE.height
    });
  });
});

describe('applying placements to the stage window', () => {
  it('moves to the projector before entering fullscreen (Windows/Linux)', () => {
    const win = new FakeWindow();
    const placement = computeStagePlacement([LAPTOP, PROJECTOR], LAPTOP, { reason: 'startup', previousMode: null, preferredStageId: null });
    applyPlacementToWindow(win, placement, 'win32');
    expect(win.log).toEqual(['bounds:1920,0,1024x768', 'fullscreen:true']);
    expect(win.alwaysOnTop).toEqual({ flag: true, level: 'screen-saver' });
    expect(win.resizable).toBe(false);
    expect(win.shown).toBe(1);
  });

  it('uses simple fullscreen on macOS to avoid a separate Space', () => {
    const win = new FakeWindow();
    const placement = computeStagePlacement([LAPTOP, PROJECTOR], LAPTOP, { reason: 'startup', previousMode: null, preferredStageId: null });
    applyPlacementToWindow(win, placement, 'darwin');
    expect(win.simpleFullScreen).toBe(true);
    expect(win.fullScreen).toBe(false);
  });

  it('leaves fullscreen before docking on the laptop', () => {
    const win = new FakeWindow();
    win.fullScreen = true;
    const placement = computeStagePlacement([LAPTOP], LAPTOP, { reason: 'display-removed', previousMode: 'projector', preferredStageId: null });
    applyPlacementToWindow(win, placement, 'win32');
    expect(win.log[0]).toBe('fullscreen:false');
    expect(win.fullScreen).toBe(false);
    expect(win.alwaysOnTop).toEqual({ flag: true, level: 'floating' });
    expect(win.bounds.width).toBe(DOCKED_SIZE.width);
  });

  it('does nothing to a destroyed window', () => {
    const win = new FakeWindow();
    win.destroyed = true;
    applyPlacementToWindow(win, computeStagePlacement([LAPTOP], LAPTOP, { reason: 'startup', previousMode: null, preferredStageId: null }), 'win32');
    expect(win.log).toEqual([]);
  });
});

describe('DisplayManager hot-plug handling', () => {
  let screen: MockScreen;
  let changes: Array<{ placement: StagePlacement; status: DisplayStatus }>;
  let manager: DisplayManager;

  beforeEach(() => {
    vi.useFakeTimers();
    screen = new MockScreen([LAPTOP], LAPTOP.id);
    changes = [];
    manager = new DisplayManager(screen, {
      onPlacementChange: (placement, status) => changes.push({ placement, status }),
      now: () => 1234
    });
    manager.start();
  });

  afterEach(() => {
    manager.stop();
    vi.useRealTimers();
  });

  it('starts in rehearsal mode without notifying', () => {
    expect(manager.getPlacement().mode).toBe('rehearsal');
    expect(manager.getStatus()).toMatchObject({ mode: 'rehearsal', stageDisplayId: null, operatorDisplayId: 1, reason: 'startup' });
    expect(changes).toHaveLength(0);
  });

  it('re-maximizes onto the projector as soon as it is plugged in', () => {
    screen.plug(PROJECTOR);
    expect(changes).toHaveLength(1);
    expect(changes[0].placement.mode).toBe('projector');
    expect(changes[0].placement.bounds).toEqual(PROJECTOR.bounds);
    expect(changes[0].status).toMatchObject({ reason: 'display-added', stageDisplayId: 2, changedAt: 1234 });
  });

  it('docks on unplug and returns to the projector on re-plug', () => {
    screen.plug(PROJECTOR);
    screen.unplug(PROJECTOR.id);
    expect(changes[1].placement.mode).toBe('docked');
    expect(changes[1].status.reason).toBe('display-removed');

    screen.plug(PROJECTOR);
    expect(changes[2].placement.mode).toBe('projector');
  });

  it('debounces metrics churn and only notifies on real placement changes', () => {
    screen.plug(PROJECTOR);
    const before = changes.length;
    screen.emit('display-metrics-changed');
    screen.emit('display-metrics-changed');
    vi.advanceTimersByTime(300);
    expect(changes.length).toBe(before); // nothing moved

    screen.displays = [LAPTOP, { ...PROJECTOR, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } }];
    screen.emit('display-metrics-changed');
    vi.advanceTimersByTime(100);
    expect(changes.length).toBe(before);
    vi.advanceTimersByTime(200);
    expect(changes.length).toBe(before + 1);
    expect(changes[changes.length - 1].placement.bounds.width).toBe(1920);
  });

  it('lets the operator pick a specific display', () => {
    screen.plug(PROJECTOR);
    screen.plug(MONITOR);
    const status = manager.setPreferredStageDisplay(2);
    expect(status.stageDisplayId).toBe(2);
    expect(status.preferredStageDisplayId).toBe(2);
    expect(manager.setPreferredStageDisplay(null).stageDisplayId).toBe(3);
  });

  it('stops listening after stop()', () => {
    manager.stop();
    screen.plug(PROJECTOR);
    expect(changes).toHaveLength(0);
  });
});
