/**
 * Tracks which take a stage layer has finished loading, so a take issued while
 * frozen can wait for the new media to be decoded before the freeze lifts.
 */
export class ReadyTracker {
  private readyTake = -1;
  private waiters: Array<{ takeId: number; resolve: () => void }> = [];

  markReady(takeId: number): void {
    if (takeId > this.readyTake) this.readyTake = takeId;
    const remaining: Array<{ takeId: number; resolve: () => void }> = [];
    for (const waiter of this.waiters) {
      if (waiter.takeId <= this.readyTake) waiter.resolve();
      else remaining.push(waiter);
    }
    this.waiters = remaining;
  }

  isReady(takeId: number): boolean {
    return takeId <= this.readyTake;
  }

  wait(takeId: number): Promise<void> {
    if (this.isReady(takeId)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push({ takeId, resolve });
    });
  }

  reset(): void {
    this.readyTake = -1;
    const pending = this.waiters;
    this.waiters = [];
    pending.forEach((w) => w.resolve());
  }
}

export interface CaptureSource {
  element: HTMLImageElement | HTMLVideoElement;
  opacity: number;
  layer: 'backdrop' | 'foreground';
}

export function readOpacity(element: HTMLElement | null): number {
  if (!element) return 0;
  const value = Number.parseFloat(window.getComputedStyle(element).opacity);
  return Number.isFinite(value) ? value : 0;
}

export function isDrawable(element: HTMLImageElement | HTMLVideoElement): boolean {
  if (element instanceof HTMLVideoElement) return element.readyState >= 2 && element.videoWidth > 0;
  return element.complete && (element.naturalWidth > 0 || element.currentSrc.length > 0);
}
