import { AppWindow, EyeOff, Film, Globe, ImageIcon, Music, Pause, Play, RotateCcw, Snowflake, Zap } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CueItem, MediaItem } from '../../types';
import { getVisibleView, isBackdropCapable, isForegroundCapable } from '../../services/cueManager';
import { formatTime } from '../../services/utils';
import { useMediaStore } from '../../store/useMediaStore';
import { useStageStore } from '../../store/useStageStore';
import { Button } from '../common/Button';
import { PageControls, WebRemoteView } from './PageControls';

const SYNC_TOLERANCE_S = 0.35;

/* ----------------------------- Media views ------------------------------- */

function StillOrLoop({ media, loop }: { media: MediaItem; loop: boolean }): JSX.Element {
  if (media.missing) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-black text-[11px] text-av-red">
        Missing: {media.name}
      </div>
    );
  }
  if (media.type === 'web' || media.type === 'screen') {
    // Live sources: the library card picture (the live web picture is shown on the Program monitor).
    const thumb = useMediaStore.getState().getById(media.id)?.thumbnailUrl;
    return (
      <div className="relative h-full w-full">
        {thumb ? <img src={thumb} alt="" draggable={false} className="monitor-media" /> : null}
        <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded bg-av-blue/90 px-1.5 py-0.5 text-[10px] font-bold text-av-bg">
          {media.type === 'web' ? <Globe size={11} /> : <AppWindow size={11} />}
          {media.type === 'web' ? 'LIVE WEB PAGE' : 'LIVE WINDOW'} · {media.name}
        </span>
      </div>
    );
  }
  if (media.type === 'video') {
    return <video src={media.fileUrl} muted autoPlay loop={loop} playsInline className="monitor-media" />;
  }
  return <img src={media.fileUrl} alt="" draggable={false} className="monitor-media" />;
}

interface MirrorVideoProps {
  media: MediaItem;
  time: number;
  playing: boolean;
}

/** Muted copy of the program video, kept within ~350 ms of the stage. */
function MirrorVideo({ media, time, playing }: MirrorVideoProps): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || el.readyState < 1) return;
    if (Math.abs(el.currentTime - time) > SYNC_TOLERANCE_S) el.currentTime = time;
    if (playing && el.paused) {
      el.play().catch(() => {
        el.pause();
      });
    } else if (!playing && !el.paused) {
      el.pause();
    }
  }, [time, playing]);

  return (
    <video
      ref={ref}
      key={media.id}
      src={media.fileUrl}
      muted
      playsInline
      preload="auto"
      className="monitor-media"
      onLoadedMetadata={(event) => {
        event.currentTarget.currentTime = time;
        if (playing) {
          event.currentTarget.play().catch(() => {
            event.currentTarget.pause();
          });
        }
      }}
    />
  );
}

interface PreviewVideoProps {
  media: MediaItem;
}

/** Operator-only scrubbable preview of the next video. Never visible on stage. */
function PreviewVideo({ media }: PreviewVideoProps): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(media.duration ?? 0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    setTime(0);
    setPlaying(false);
    setDuration(media.duration ?? 0);
  }, [media.id, media.duration]);

  return (
    <div className="relative h-full w-full">
      <video
        ref={ref}
        key={media.id}
        src={media.fileUrl}
        muted
        playsInline
        preload="auto"
        className="monitor-media"
        onLoadedMetadata={(event) => {
          const d = event.currentTarget.duration;
          if (Number.isFinite(d)) setDuration(d);
          event.currentTarget.currentTime = Math.min(0.5, Number.isFinite(d) ? d / 10 : 0);
        }}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/90 to-transparent px-2 pb-1.5 pt-4">
        <button
          type="button"
          className="rounded p-0.5 text-av-text hover:bg-white/10"
          aria-label={playing ? 'Pause preview' : 'Play preview (muted)'}
          onClick={() => {
            const el = ref.current;
            if (!el) return;
            if (el.paused) void el.play().catch(() => el.pause());
            else el.pause();
          }}
        >
          {playing ? <Pause size={13} /> : <Play size={13} />}
        </button>
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={0.05}
          value={Math.min(time, duration || 1)}
          aria-label="Scrub preview video"
          className="av-range flex-1"
          style={{
            ['--slider-fill' as string]: `${duration > 0 ? (time / duration) * 100 : 0}%`,
            ['--slider-accent' as string]: '#38bdf8'
          }}
          onChange={(event) => {
            const el = ref.current;
            const value = Number(event.target.value);
            if (el) el.currentTime = value;
            setTime(value);
          }}
        />
        <span className="font-mono text-[10px] tabular-nums text-av-muted">
          {formatTime(time)} / {formatTime(duration)}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------ Monitor frame ---------------------------- */

interface MonitorFrameProps {
  title: string;
  tone: 'preview' | 'program';
  badge?: JSX.Element | null;
  children: ReactNode;
  footer: JSX.Element;
  highlight?: 'frozen' | 'blackout' | null;
  testId: string;
}

function MonitorFrame({ title, tone, badge, children, footer, highlight, testId }: MonitorFrameProps): JSX.Element {
  const border =
    highlight === 'frozen'
      ? 'border-av-blue shadow-[0_0_0_2px_rgba(56,189,248,0.35)]'
      : highlight === 'blackout'
        ? 'border-av-red shadow-[0_0_0_2px_rgba(248,113,113,0.35)]'
        : tone === 'program'
          ? 'border-av-red/50'
          : 'border-av-green/40';
  return (
    <section className="flex min-w-0 flex-1 flex-col rounded-lg border border-av-border bg-av-panel" data-testid={testId}>
      <header className="flex h-8 items-center justify-between px-2.5">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${tone === 'program' ? 'animate-live-blink bg-av-red' : 'bg-av-green'}`}
          />
          <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-av-text">{title}</h3>
        </div>
        {badge}
      </header>
      <div className="px-2">
        <div className={`relative aspect-video w-full overflow-hidden rounded-md border-2 bg-black ${border}`}>{children}</div>
      </div>
      <div className="min-h-[52px] px-2.5 py-2">{footer}</div>
    </section>
  );
}

function EmptyMonitor({ text }: { text: string }): JSX.Element {
  return <div className="flex h-full w-full items-center justify-center text-[11px] text-av-dim">{text}</div>;
}

/* -------------------------------- Preview -------------------------------- */

function PreviewMonitor(): JSX.Element {
  const selectedCueId = useStageStore((s) => s.selectedCueId);
  const cues = useStageStore((s) => s.cues);
  const programBackdrop = useStageStore((s) => s.program.backdrop);
  const takeSelected = useStageStore((s) => s.takeSelected);
  const items = useMediaStore((s) => s.items);

  const cue: CueItem | null = cues.find((c) => c.id === selectedCueId) ?? null;
  const lookup = useMemo(() => {
    const map = new Map(items.map((i) => [i.id, i] as const));
    return (id: string | undefined): MediaItem | null => (id ? map.get(id) ?? null : null);
  }, [items]);

  const explicitBackdrop = cue ? lookup(cue.backdropMediaId) : null;
  const backdrop = isBackdropCapable(explicitBackdrop) ? explicitBackdrop : programBackdrop;
  const tracking = cue !== null && !isBackdropCapable(explicitBackdrop) && programBackdrop !== null;
  const foregroundCandidate = cue ? lookup(cue.foregroundMediaId) : null;
  const foreground = isForegroundCapable(foregroundCandidate) ? foregroundCandidate : null;
  const music = cue ? lookup(cue.audioMediaId) : null;

  return (
    <MonitorFrame
      title="Preview"
      tone="preview"
      testId="monitor-preview"
      badge={
        cue ? (
          <span className="max-w-[60%] truncate font-mono text-[11px] text-av-green" title={cue.label}>
            NEXT · {cue.order}. {cue.label}
          </span>
        ) : null
      }
      footer={
        cue ? (
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 space-y-0.5 text-[11px]">
              <div className="flex items-center gap-1.5 truncate text-av-muted">
                <ImageIcon size={12} className="shrink-0" />
                <span className="truncate">
                  {backdrop ? backdrop.name : 'No backdrop'}
                  {tracking ? <span className="ml-1 text-av-dim">(keeps current)</span> : null}
                </span>
              </div>
              <div className="flex items-center gap-3 text-av-muted">
                <span className="flex min-w-0 items-center gap-1.5 truncate">
                  <Film size={12} className="shrink-0" />
                  <span className="truncate">{foreground ? foreground.name : 'No video'}</span>
                </span>
                <span className="flex min-w-0 items-center gap-1.5 truncate">
                  <Music size={12} className="shrink-0" />
                  <span className="truncate">{music ? music.name : 'Music unchanged'}</span>
                </span>
              </div>
            </div>
            <Button variant="success" size="sm" icon={<Zap size={14} />} onClick={() => takeSelected()} title="Take (Space)">
              TAKE
            </Button>
          </div>
        ) : (
          <p className="text-[11px] text-av-dim">Select a cue to preview it here before taking it live.</p>
        )
      }
    >
      {cue ? (
        <>
          {backdrop ? (
            <div className={`absolute inset-0 ${tracking ? 'opacity-60' : ''}`}>
              <StillOrLoop media={backdrop} loop={cue.loopBackdrop} />
            </div>
          ) : (
            <EmptyMonitor text="Black" />
          )}
          {foreground ? (
            <div className="absolute inset-0">
              <PreviewVideo media={foreground} />
            </div>
          ) : null}
        </>
      ) : (
        <EmptyMonitor text="No cue selected" />
      )}
    </MonitorFrame>
  );
}

/* -------------------------------- Program -------------------------------- */

function ProgramTransport(): JSX.Element {
  const telemetry = useStageStore((s) => s.telemetry);
  const program = useStageStore((s) => s.program);
  const videoControl = useStageStore((s) => s.videoControl);
  const hasVideo = program.foreground !== null && telemetry?.currentForeground?.id === program.foreground.id;
  const time = hasVideo && telemetry ? telemetry.foregroundCurrentTime : 0;
  const duration = hasVideo && telemetry ? telemetry.foregroundDuration : 0;
  const remaining = Math.max(0, duration - time);
  const playing = hasVideo && telemetry ? telemetry.isForegroundPlaying : false;
  const progress = duration > 0 ? Math.min(100, (time / duration) * 100) : 0;
  const remainingTone = !hasVideo ? 'text-av-dim' : remaining < 5 ? 'text-av-red' : remaining < 10 ? 'text-av-amber' : 'text-av-text';

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="secondary"
          disabled={!hasVideo}
          icon={playing ? <Pause size={14} /> : <Play size={14} />}
          onClick={() => videoControl({ action: playing ? 'pause' : 'play' })}
          title="Play / pause program video (Shift+P)"
          aria-label={playing ? 'Pause program video' : 'Play program video'}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={!hasVideo}
          icon={<RotateCcw size={14} />}
          onClick={() => videoControl({ action: 'restart' })}
          title="Restart program video"
          aria-label="Restart program video"
        />
      </div>
      <div className="min-w-0 flex-1">
        <div
          className="group relative h-2 cursor-pointer overflow-hidden rounded-full bg-av-bg"
          role="slider"
          aria-label="Program video position"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(time)}
          tabIndex={-1}
          onClick={(event) => {
            if (!hasVideo || duration <= 0) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const ratio = (event.clientX - rect.left) / rect.width;
            videoControl({ action: 'seek', time: ratio * duration });
          }}
        >
          <div className="h-full rounded-full bg-av-red transition-[width] duration-100" style={{ width: `${progress}%` }} />
        </div>
        <div className="mt-1 flex justify-between font-mono text-[10px] tabular-nums text-av-muted">
          <span>{hasVideo ? formatTime(time) : '--:--'}</span>
          <span>{hasVideo ? formatTime(duration) : '--:--'}</span>
        </div>
      </div>
      <div className="text-right">
        <div className="text-[9px] font-semibold uppercase tracking-wider text-av-muted">Remaining</div>
        <div className={`font-mono text-lg font-bold leading-none tabular-nums ${remainingTone}`} data-testid="program-remaining">
          {hasVideo ? `-${formatTime(remaining)}` : '--:--'}
        </div>
      </div>
    </div>
  );
}

function ProgramMonitor(): JSX.Element {
  const program = useStageStore((s) => s.program);
  const telemetry = useStageStore((s) => s.telemetry);
  const items = useMediaStore((s) => s.items);
  const liveTime = telemetry ? telemetry.foregroundCurrentTime : 0;
  const view = getVisibleView(program, liveTime);
  const frozen = program.isFrozen;
  const playing = !frozen && telemetry !== null && telemetry.isForegroundPlaying;
  const time = frozen && program.frozenView ? program.frozenView.foregroundTime : liveTime;
  // The library item (with its PDF page / web address) behind the live backdrop.
  const liveItem = program.backdrop ? items.find((i) => i.id === program.backdrop?.id) ?? null : null;
  const booklet = liveItem !== null && !liveItem.missing && (liveItem.pdf !== undefined || liveItem.type === 'web');
  const webLive = liveItem !== null && liveItem.type === 'web' && view.backdrop?.id === liveItem.id;

  return (
    <MonitorFrame
      title="Program"
      tone="program"
      testId="monitor-program"
      highlight={frozen ? 'frozen' : program.isBlackout ? 'blackout' : null}
      badge={
        <span className="max-w-[60%] truncate font-mono text-[11px] text-av-red" title={program.liveCueLabel}>
          {program.liveCueLabel ? `LIVE · ${program.liveCueLabel}` : 'LIVE'}
        </span>
      }
      footer={booklet && liveItem && !program.foreground ? <PageControls item={liveItem} /> : <ProgramTransport />}
    >
      {webLive && liveItem ? (
        <WebRemoteView media={liveItem} />
      ) : view.backdrop ? (
        <div className="absolute inset-0">
          <StillOrLoop media={view.backdrop} loop={program.loopBackdrop} />
        </div>
      ) : (
        <EmptyMonitor text="Black" />
      )}
      {view.foreground ? (
        <div className="absolute inset-0">
          <MirrorVideo media={view.foreground} time={time} playing={playing} />
        </div>
      ) : null}
      {program.isBlackout ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/85" data-testid="program-blackout">
          <span className="flex items-center gap-1.5 rounded bg-av-red px-2 py-1 text-xs font-black tracking-widest text-av-bg">
            <EyeOff size={13} /> BLACKOUT
          </span>
        </div>
      ) : null}
      {frozen ? (
        <div className="pointer-events-none absolute inset-0 flex items-start justify-end p-2" data-testid="program-frozen">
          <span className="flex items-center gap-1.5 rounded bg-av-blue px-2 py-1 text-xs font-black tracking-widest text-av-bg">
            <Snowflake size={13} /> FROZEN
          </span>
        </div>
      ) : null}
    </MonitorFrame>
  );
}

export function MonitorDualDeck(): JSX.Element {
  return (
    <div className="flex shrink-0 gap-2">
      <PreviewMonitor />
      <ProgramMonitor />
    </div>
  );
}
