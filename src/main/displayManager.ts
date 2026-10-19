import type {
  DisplayChangeReason,
  DisplayInfo,
  DisplayStatus,
  Rect,
  StageMode
} from '../renderer/src/types';

/* =========================================================================
 * Display detection & stage window placement.
 *
 * Everything here is written against small structural interfaces instead of
 * importing Electron at runtime, so the routing rules can be unit tested with
 * a mocked `screen` and a fake window.
 * ========================================================================= */

export interface DisplayLike {
  id: number;
  bounds: Rect;
  workArea: Rect;
  scaleFactor: number;
  label?: string;
  internal?: boolean;
}

export type ScreenEvent = 'display-added' | 'display-removed' | 'display-metrics-changed';

export interface ScreenLike {
  getAllDisplays(): DisplayLike[];
  getPrimaryDisplay(): DisplayLike;
  on(event: ScreenEvent, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: ScreenEvent, listener: (...args: unknown[]) => void): unknown;
}

export interface StagePlacement {
  mode: StageMode;
  /** Display the stage window occupies. */
  displayId: number;
  /** Display the operator console should live on. */
  operatorDisplayId: number;
  bounds: Rect;
  fullscreen: boolean;
  alwaysOnTop: boolean;
}

export interface StageWindowLike {
  isDestroyed(): boolean;
  setBounds(bounds: Rect): void;
  setFullScreen(flag: boolean): void;
  isFullScreen(): boolean;
  setSimpleFullScreen(flag: boolean): void;
  isSimpleFullScreen(): boolean;
  setAlwaysOnTop(flag: boolean, level?: 'floating' | 'screen-saver'): void;
  setResizable(resizable: boolean): void;
  setHasShadow(hasShadow: boolean): void;
  showInactive(): void;
}

export const REHEARSAL_SIZE = { width: 1280, height: 720 } as const;
export const DOCKED_SIZE = { width: 480, height: 270 } as const;
export const WINDOW_MARGIN = 24;
export const METRICS_DEBOUNCE_MS = 250;

function copyRect(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function sortByPosition(displays: DisplayLike[]): DisplayLike[] {
  return [...displays].sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y || a.id - b.id);
}

export function describeDisplays(displays: DisplayLike[], primaryId: number): DisplayInfo[] {
  // Electron only reports `internal: true` reliably on macOS / ChromeOS. When no
  // display claims to be internal, every non-primary display is treated as external.
  const hasInternalFlag = displays.some((d) => d.internal === true);
  return sortByPosition(displays).map((d, index) => {
    const isPrimary = d.id === primaryId;
    const label = d.label?.trim();
    return {
      id: d.id,
      bounds: copyRect(d.bounds),
      workArea: copyRect(d.workArea),
      scaleFactor: d.scaleFactor,
      isPrimary,
      isExternal: hasInternalFlag ? d.internal !== true : !isPrimary,
      name: label && label.length > 0 ? label : `Display ${index + 1} (${d.bounds.width}×${d.bounds.height})`
    };
  });
}

export interface DisplaySelection {
  operator: DisplayLike;
  stage: DisplayLike | null;
}

/**
 * Chooses which display hosts the operator console and which hosts the stage.
 * Rules, in order:
 *  1. A single display → rehearsal (no stage display).
 *  2. An explicit operator preference wins when that display is connected.
 *  3. If a built-in panel is known, it hosts the operator; the first external display is the stage.
 *  4. Otherwise the primary display hosts the operator; the first other display is the stage.
 */
export function selectDisplays(
  displays: DisplayLike[],
  primary: DisplayLike,
  preferredStageId: number | null
): DisplaySelection {
  const all = displays.length > 0 ? displays : [primary];
  const primaryDisplay = all.find((d) => d.id === primary.id) ?? all[0];
  if (all.length < 2) return { operator: primaryDisplay, stage: null };

  if (preferredStageId !== null) {
    const preferred = all.find((d) => d.id === preferredStageId);
    if (preferred) {
      const operator =
        preferred.id !== primaryDisplay.id
          ? primaryDisplay
          : sortByPosition(all.filter((d) => d.id !== preferred.id))[0];
      return { operator, stage: preferred };
    }
  }

  const internal = all.find((d) => d.internal === true);
  if (internal) {
    const externals = all.filter((d) => d.id !== internal.id);
    const ordered = [
      ...sortByPosition(externals.filter((d) => d.id !== primaryDisplay.id)),
      ...externals.filter((d) => d.id === primaryDisplay.id)
    ];
    return { operator: internal, stage: ordered[0] ?? null };
  }

  const others = sortByPosition(all.filter((d) => d.id !== primaryDisplay.id));
  return { operator: primaryDisplay, stage: others[0] ?? null };
}

export function fitSize(
  target: { width: number; height: number },
  maxWidth: number,
  maxHeight: number
): { width: number; height: number } {
  const scale = Math.min(1, Math.max(0, maxWidth) / target.width, Math.max(0, maxHeight) / target.height);
  return {
    width: Math.max(160, Math.round(target.width * scale)),
    height: Math.max(90, Math.round(target.height * scale))
  };
}

export interface PlacementOptions {
  reason: DisplayChangeReason;
  previousMode: StageMode | null;
  preferredStageId: number | null;
}

export function computeStagePlacement(
  displays: DisplayLike[],
  primary: DisplayLike,
  options: PlacementOptions
): StagePlacement {
  const { operator, stage } = selectDisplays(displays, primary, options.preferredStageId);

  if (stage) {
    return {
      mode: 'projector',
      displayId: stage.id,
      operatorDisplayId: operator.id,
      bounds: copyRect(stage.bounds),
      fullscreen: true,
      alwaysOnTop: true
    };
  }

  const area = operator.workArea;
  const wasOnProjector = options.previousMode === 'projector' || options.previousMode === 'docked';

  if (wasOnProjector) {
    // HDMI pulled mid-show: keep playing in a small floating window on the laptop.
    const size = fitSize(DOCKED_SIZE, area.width - WINDOW_MARGIN * 2, area.height - WINDOW_MARGIN * 2);
    return {
      mode: 'docked',
      displayId: operator.id,
      operatorDisplayId: operator.id,
      bounds: {
        x: area.x + area.width - size.width - WINDOW_MARGIN,
        y: area.y + area.height - size.height - WINDOW_MARGIN,
        width: size.width,
        height: size.height
      },
      fullscreen: false,
      alwaysOnTop: true
    };
  }

  const size = fitSize(REHEARSAL_SIZE, area.width - WINDOW_MARGIN * 2, area.height - WINDOW_MARGIN * 2);
  return {
    mode: 'rehearsal',
    displayId: operator.id,
    operatorDisplayId: operator.id,
    bounds: {
      x: area.x + Math.round((area.width - size.width) / 2),
      y: area.y + Math.round((area.height - size.height) / 2),
      width: size.width,
      height: size.height
    },
    fullscreen: false,
    alwaysOnTop: false
  };
}

export function buildDisplayStatus(
  displays: DisplayLike[],
  primary: DisplayLike,
  placement: StagePlacement,
  preferredStageId: number | null,
  reason: DisplayChangeReason,
  now: number
): DisplayStatus {
  return {
    mode: placement.mode,
    displays: describeDisplays(displays.length > 0 ? displays : [primary], primary.id),
    stageDisplayId: placement.mode === 'projector' ? placement.displayId : null,
    operatorDisplayId: placement.operatorDisplayId,
    preferredStageDisplayId: preferredStageId,
    reason,
    changedAt: now
  };
}

export function placementsEqual(a: StagePlacement, b: StagePlacement): boolean {
  return (
    a.mode === b.mode &&
    a.displayId === b.displayId &&
    a.operatorDisplayId === b.operatorDisplayId &&
    a.fullscreen === b.fullscreen &&
    a.alwaysOnTop === b.alwaysOnTop &&
    a.bounds.x === b.bounds.x &&
    a.bounds.y === b.bounds.y &&
    a.bounds.width === b.bounds.width &&
    a.bounds.height === b.bounds.height
  );
}

/** Moves/resizes the stage window to match a placement without recreating it (state is preserved). */
export function applyPlacementToWindow(
  win: StageWindowLike,
  placement: StagePlacement,
  platform: string
): void {
  if (win.isDestroyed()) return;

  if (placement.mode === 'projector') {
    // Leave fullscreen first so the window can travel to a different display.
    if (platform === 'darwin') {
      if (win.isSimpleFullScreen()) win.setSimpleFullScreen(false);
    } else if (win.isFullScreen()) {
      win.setFullScreen(false);
    }
    win.setResizable(true);
    win.setBounds(placement.bounds);
    win.setHasShadow(false);
    win.setAlwaysOnTop(true, 'screen-saver');
    if (platform === 'darwin') {
      win.setSimpleFullScreen(true);
    } else {
      win.setFullScreen(true);
    }
    win.setResizable(false);
  } else {
    if (platform === 'darwin') {
      if (win.isSimpleFullScreen()) win.setSimpleFullScreen(false);
    } else if (win.isFullScreen()) {
      win.setFullScreen(false);
    }
    win.setResizable(true);
    win.setHasShadow(true);
    win.setAlwaysOnTop(placement.alwaysOnTop, 'floating');
    win.setBounds(placement.bounds);
  }
  win.showInactive();
}

export interface DisplayManagerOptions {
  onPlacementChange: (placement: StagePlacement, status: DisplayStatus) => void;
  metricsDebounceMs?: number;
  now?: () => number;
}

export class DisplayManager {
  private placement: StagePlacement;
  private status: DisplayStatus;
  private preferredStageId: number | null = null;
  private metricsTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  private readonly handleAdded = (): void => {
    this.refresh('display-added');
  };

  private readonly handleRemoved = (): void => {
    this.refresh('display-removed');
  };

  private readonly handleMetrics = (): void => {
    if (this.metricsTimer !== null) clearTimeout(this.metricsTimer);
    this.metricsTimer = setTimeout(() => {
      this.metricsTimer = null;
      this.refresh('metrics-changed', true);
    }, this.options.metricsDebounceMs ?? METRICS_DEBOUNCE_MS);
  };

  constructor(
    private readonly screen: ScreenLike,
    private readonly options: DisplayManagerOptions
  ) {
    const initial = this.compute('startup', null);
    this.placement = initial.placement;
    this.status = initial.status;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private compute(
    reason: DisplayChangeReason,
    previousMode: StageMode | null
  ): { placement: StagePlacement; status: DisplayStatus } {
    const displays = this.screen.getAllDisplays();
    const primary = this.screen.getPrimaryDisplay();
    const placement = computeStagePlacement(displays, primary, {
      reason,
      previousMode,
      preferredStageId: this.preferredStageId
    });
    const status = buildDisplayStatus(displays, primary, placement, this.preferredStageId, reason, this.now());
    return { placement, status };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.screen.on('display-added', this.handleAdded);
    this.screen.on('display-removed', this.handleRemoved);
    this.screen.on('display-metrics-changed', this.handleMetrics);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.screen.removeListener('display-added', this.handleAdded);
    this.screen.removeListener('display-removed', this.handleRemoved);
    this.screen.removeListener('display-metrics-changed', this.handleMetrics);
    if (this.metricsTimer !== null) {
      clearTimeout(this.metricsTimer);
      this.metricsTimer = null;
    }
  }

  getPlacement(): StagePlacement {
    return this.placement;
  }

  getStatus(): DisplayStatus {
    return this.status;
  }

  getOperatorWorkArea(): Rect {
    const operator = this.status.displays.find((d) => d.id === this.placement.operatorDisplayId);
    return operator ? copyRect(operator.workArea) : copyRect(this.screen.getPrimaryDisplay().workArea);
  }

  setPreferredStageDisplay(displayId: number | null): DisplayStatus {
    this.preferredStageId = displayId;
    return this.refresh('manual');
  }

  /**
   * Re-evaluates the display topology. When `onlyIfChanged` is set (metrics
   * churn), listeners are notified only if the placement actually moved.
   */
  refresh(reason: DisplayChangeReason, onlyIfChanged = false): DisplayStatus {
    const next = this.compute(reason, this.placement.mode);
    const changed = !placementsEqual(next.placement, this.placement);
    this.placement = next.placement;
    this.status = next.status;
    if (!onlyIfChanged || changed) {
      this.options.onPlacementChange(this.placement, this.status);
    }
    return this.status;
  }
}
