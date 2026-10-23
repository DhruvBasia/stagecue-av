import { useEffect, useState } from 'react';
import type { StageOverlays as StageOverlaysState } from '../../types';
import { clockRemaining, formatClockMs, timerTone } from '../../services/onAir';

/* Layer 2.5: drawn over the picture (and over a freeze), under the blackout.
 * Used on the projector and, scaled down, in the operator's Program monitor:
 * every size is relative to the box it sits in (container query units). */

const TONE_COLOURS = {
  ok: '#4ade80',
  warn: '#fbbf24',
  over: '#f87171'
} as const;

export function StageOverlays({ overlays }: { overlays: StageOverlaysState }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  const ticking = overlays.countdown?.endsAt != null || overlays.speakerTimer?.endsAt != null;

  useEffect(() => {
    setNow(Date.now());
    if (!ticking) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [ticking, overlays]);

  const countdown = overlays.countdown;
  const countdownLeft = countdown ? clockRemaining(countdown, now) : 0;
  const showCountdown = countdown !== null && !(countdown.hideAtZero && countdownLeft <= 0);
  const caption = overlays.caption;
  const timer = overlays.speakerTimer;
  const timerLeft = timer ? clockRemaining(timer, now) : 0;

  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ zIndex: 25, containerType: 'size' }}
      data-testid="overlay-layer"
    >
      {showCountdown && countdown ? (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 text-white backdrop-blur-[1.2cqh]"
          data-testid="overlay-countdown"
        >
          {countdown.message ? (
            <div className="px-[6cqw] text-center font-semibold uppercase tracking-[0.2em] opacity-90" style={{ fontSize: '4.2cqh' }}>
              {countdown.message}
            </div>
          ) : null}
          <div className="font-black leading-none tabular-nums" style={{ fontSize: '24cqh', marginTop: '2cqh' }} data-testid="overlay-countdown-time">
            {formatClockMs(Math.max(0, countdownLeft))}
          </div>
        </div>
      ) : null}

      {caption ? (
        <div
          key={caption.id}
          className="stagecue-caption-in absolute flex max-w-[70cqw] items-stretch"
          style={{ left: '5cqw', bottom: '9cqh' }}
          data-testid="overlay-caption"
          data-style={caption.style}
        >
          {caption.style === 'bar' ? <div className="shrink-0 bg-sky-400" style={{ width: '0.8cqh' }} /> : null}
          <div
            className={caption.style === 'bar' ? 'bg-[#0b1220]/90' : 'rounded-[1.2cqh] border border-white/25 bg-white/15 backdrop-blur-md'}
            style={{ padding: '1.6cqh 2.6cqh' }}
          >
            <div className="font-bold leading-tight text-white" style={{ fontSize: '5cqh' }}>
              {caption.title}
            </div>
            {caption.subtitle ? (
              <div className="leading-tight text-white/80" style={{ fontSize: '3cqh', marginTop: '0.6cqh' }}>
                {caption.subtitle}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {timer ? (
        <div
          className="absolute rounded-[1cqh] bg-black/75 font-black tabular-nums"
          style={{ right: '2cqw', bottom: '3cqh', fontSize: '5cqh', padding: '0.6cqh 1.6cqh', color: TONE_COLOURS[timerTone(timerLeft, timer.warnMs)] }}
          data-testid="overlay-timer"
        >
          {formatClockMs(timerLeft)}
        </div>
      ) : null}
    </div>
  );
}
