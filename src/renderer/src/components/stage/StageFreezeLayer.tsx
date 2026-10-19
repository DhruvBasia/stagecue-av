import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { FreezeSource } from '../../types';
import type { CaptureSource } from './readyTracker';

/* Layer 2 — software freeze. One canvas is allocated for the lifetime of the
 * window and reused for every snapshot (no base64 strings, no leaks on long
 * shows). Showing/hiding is done by mutating the canvas style directly so the
 * freeze lands on the very next frame without waiting for a React render. */

export interface FreezeCaptureResult {
  source: FreezeSource;
  drawn: number;
}

export interface StageFreezeHandle {
  capture(sources: CaptureSource[]): FreezeCaptureResult;
  release(fadeMs: number): void;
  isActive(): boolean;
}

function intrinsicSize(element: HTMLImageElement | HTMLVideoElement): { width: number; height: number } {
  if (element instanceof HTMLVideoElement) return { width: element.videoWidth, height: element.videoHeight };
  return { width: element.naturalWidth, height: element.naturalHeight };
}

/** Same geometry as CSS `object-fit: contain`. */
export function containRect(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number
): { x: number; y: number; width: number; height: number } {
  if (sourceWidth <= 0 || sourceHeight <= 0) return { x: 0, y: 0, width: targetWidth, height: targetHeight };
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return { x: (targetWidth - width) / 2, y: (targetHeight - height) / 2, width, height };
}

export interface StageFreezeLayerProps {
  /** Fade used when the freeze canvas is hidden without an explicit duration. */
  defaultReleaseMs?: number;
}

export const StageFreezeLayer = forwardRef<StageFreezeHandle, StageFreezeLayerProps>(function StageFreezeLayer(
  { defaultReleaseMs = 0 },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const contextRef = useRef<CanvasRenderingContext2D | null>(null);
  const activeRef = useRef(false);
  const resizePendingRef = useRef(false);

  const resizeCanvas = (): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (activeRef.current) {
      // Resizing clears the bitmap; defer until the freeze is released.
      resizePendingRef.current = true;
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(window.innerWidth * dpr));
    const height = Math.max(1, Math.round(window.innerHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    resizePendingRef.current = false;
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    contextRef.current = canvas.getContext('2d', { alpha: false });
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    return () => window.removeEventListener('resize', resizeCanvas);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      capture(sources: CaptureSource[]): FreezeCaptureResult {
        const canvas = canvasRef.current;
        const ctx = contextRef.current;
        if (!canvas || !ctx) return { source: 'empty', drawn: 0 };

        const width = canvas.width;
        const height = canvas.height;
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, width, height);

        let drawn = 0;
        const layers = new Set<'backdrop' | 'foreground'>();
        for (const source of sources) {
          const size = intrinsicSize(source.element);
          const rect = containRect(size.width, size.height, width, height);
          try {
            ctx.globalAlpha = Math.min(1, Math.max(0, source.opacity));
            ctx.drawImage(source.element, rect.x, rect.y, rect.width, rect.height);
            drawn += 1;
            layers.add(source.layer);
          } catch (error) {
            console.warn('[StageCue] Freeze capture skipped a layer', error);
          }
        }
        ctx.globalAlpha = 1;

        canvas.style.transition = 'none';
        canvas.style.opacity = '1';
        canvas.dataset.active = 'true';
        activeRef.current = true;

        const source: FreezeSource =
          layers.size === 2 ? 'composite' : layers.has('foreground') ? 'foreground' : layers.has('backdrop') ? 'backdrop' : 'empty';
        return { source, drawn };
      },

      release(fadeMs: number): void {
        const canvas = canvasRef.current;
        if (!canvas || !activeRef.current) return;
        activeRef.current = false;
        const duration = Number.isFinite(fadeMs) && fadeMs >= 0 ? fadeMs : defaultReleaseMs;
        canvas.style.transition = duration > 0 ? `opacity ${duration}ms ease-out` : 'none';
        canvas.style.opacity = '0';
        canvas.dataset.active = 'false';
        if (resizePendingRef.current) {
          window.setTimeout(resizeCanvas, duration + 20);
        }
      },

      isActive(): boolean {
        return activeRef.current;
      }
    }),
    [defaultReleaseMs]
  );

  return (
    <canvas
      ref={canvasRef}
      data-testid="freeze-layer"
      data-active="false"
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ zIndex: 20, opacity: 0, objectFit: 'contain', background: '#000000' }}
    />
  );
});
