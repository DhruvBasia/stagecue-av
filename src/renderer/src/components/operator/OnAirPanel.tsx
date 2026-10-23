import { Captions, Eye, EyeOff, Hourglass, MonitorPlay, Pause, Play, Plus, RotateCcw, Timer, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CaptionStyle } from '../../types';
import { clockRemaining, formatClockMs, isRunning, timerTone, type TimerTone } from '../../services/onAir';
import { useOnAirStore } from '../../store/useOnAirStore';
import { usePrefsStore } from '../../store/usePrefsStore';
import { Button } from '../common/Button';

/* On air: speaker timer (podium phone + optional projector corner), name
 * captions over the picture, and a "starting in" countdown on the projector. */

type Tab = 'timer' | 'captions' | 'countdown';

const TONE_TEXT: Record<TimerTone, string> = { ok: 'text-av-green', warn: 'text-av-amber', over: 'text-av-red' };
const TIMER_PRESETS = [3, 5, 7, 10, 15];
const SIGNALS = ['WRAP UP', '1 MINUTE', 'TIME UP'];

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function MinutesInput({ value, onChange, label, testId }: { value: number; onChange: (v: number) => void; label: string; testId: string }): JSX.Element {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = (): void => {
    const n = Number(draft.replace(',', '.'));
    if (Number.isFinite(n) && n > 0) onChange(n);
    else setDraft(String(value));
  };
  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value.replace(/[^0-9.,]/g, '').slice(0, 5))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      aria-label={label}
      className="h-7 w-12 rounded border border-av-border bg-av-bg text-center font-mono text-xs text-av-text focus:border-av-blue focus:outline-none"
      data-testid={testId}
    />
  );
}

function SpeakerTimerTab(): JSX.Element {
  const timer = useOnAirStore((s) => s.timer);
  const store = useOnAirStore.getState;
  const remoteOn = usePrefsStore((s) => s.remoteInfo?.enabled ?? false);
  const running = isRunning(timer.clock);
  const now = useNow(running);
  const left = clockRemaining(timer.clock, now);
  const tone = timerTone(left, timer.warnMs);

  return (
    <div className="space-y-2" data-testid="onair-timer">
      <div className="flex items-center gap-2">
        <div className={`font-mono text-4xl font-black tabular-nums leading-none ${TONE_TEXT[tone]}`} data-testid="onair-timer-display">
          {formatClockMs(left)}
        </div>
        <div className="min-w-0 flex-1 text-right text-[10px] text-av-muted">
          {timer.active ? (running ? 'RUNNING' : 'PAUSED') : 'NOT STARTED'}
          {timer.message ? <div className="font-bold text-av-amber">“{timer.message}” sent</div> : null}
        </div>
      </div>
      <input
        value={timer.speaker}
        onChange={(e) => store().setSpeaker(e.target.value)}
        placeholder="Speaker (shown on the podium screen)"
        aria-label="Speaker name"
        className="h-8 w-full rounded-md border border-av-border bg-av-bg px-2 text-xs text-av-text placeholder:text-av-dim focus:border-av-blue focus:outline-none"
        data-testid="onair-speaker"
      />
      <div className="flex items-center gap-1">
        {TIMER_PRESETS.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              store().setTimerMinutes(m);
              if (!running) store().resetTimer();
            }}
            className={`h-7 flex-1 rounded border text-[11px] font-semibold ${
              timer.durationMs === m * 60_000 ? 'border-av-blue bg-av-blue/15 text-av-text' : 'border-av-border text-av-muted hover:text-av-text'
            }`}
          >
            {m}m
          </button>
        ))}
        <MinutesInput value={timer.durationMs / 60_000} onChange={(v) => store().setTimerMinutes(v)} label="Timer minutes" testId="onair-timer-minutes" />
      </div>
      <div className="grid grid-cols-4 gap-1">
        <Button
          size="sm"
          variant={running ? 'warning' : 'success'}
          icon={running ? <Pause size={13} /> : <Play size={13} />}
          onClick={() => (running ? store().pauseTimer() : store().startTimer())}
          className="col-span-2"
          data-testid="onair-timer-start"
        >
          {running ? 'Pause' : timer.active ? 'Resume' : 'Start'}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => store().addTimerTime(60_000)} title="Add one minute">
          +1m
        </Button>
        <Button size="sm" variant="secondary" icon={<RotateCcw size={13} />} onClick={() => store().resetTimer()} aria-label="Reset timer" title="Reset" />
      </div>
      <div className="flex flex-wrap gap-1">
        {SIGNALS.map((signal) => (
          <button
            key={signal}
            type="button"
            onClick={() => store().setTimerMessage(timer.message === signal ? null : signal)}
            className={`rounded border px-1.5 py-1 text-[10px] font-black tracking-wider ${
              timer.message === signal ? 'border-av-amber bg-av-amber/20 text-av-amber' : 'border-av-border text-av-muted hover:text-av-text'
            }`}
            data-testid={`onair-signal-${signal.replace(/\s+/g, '-').toLowerCase()}`}
          >
            {signal}
          </button>
        ))}
        <label className="ml-auto flex cursor-pointer items-center gap-1 text-[10px] text-av-muted" title="Also show a small timer in a corner of the projector">
          <input
            type="checkbox"
            checked={timer.onProjector}
            onChange={(e) => store().setTimerOnProjector(e.target.checked)}
            className="h-3.5 w-3.5 accent-sky-400"
            data-testid="onair-timer-projector"
          />
          <MonitorPlay size={12} /> on projector
        </label>
      </div>
      <p className="text-[10px] text-av-dim">
        {remoteOn
          ? 'Podium screen: Settings → Crew remote → “Podium timer” QR. Turns amber at the last minute, red when over.'
          : 'Switch on the crew remote in Settings to show this timer on a phone or tablet at the podium.'}
      </p>
    </div>
  );
}

function CaptionsTab(): JSX.Element {
  const captions = useOnAirStore((s) => s.captions);
  const live = useOnAirStore((s) => s.liveCaption);
  const style = useOnAirStore((s) => s.captionStyle);
  const store = useOnAirStore.getState;
  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('');

  const add = (): void => {
    if (!title.trim()) return;
    store().addCaption(title, subtitle);
    setTitle('');
    setSubtitle('');
  };

  return (
    <div className="space-y-2" data-testid="onair-captions">
      {live ? (
        <div className="flex items-center gap-2 rounded-md border border-av-red/60 bg-av-red/10 px-2 py-1.5">
          <span className="text-[9px] font-black tracking-widest text-av-red">ON AIR</span>
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-av-text">{live.title}</span>
          <Button size="xs" variant="danger" icon={<EyeOff size={12} />} onClick={() => store().hideCaption()} data-testid="onair-caption-hide">
            Hide
          </Button>
        </div>
      ) : null}
      <ul className="max-h-40 space-y-1 overflow-y-auto">
        {captions.length === 0 ? <li className="text-[11px] text-av-dim">No captions yet. Add the names of speakers and guests below.</li> : null}
        {captions.map((c) => {
          const onAir = live?.id === c.id;
          return (
            <li key={c.id} className={`flex items-center gap-1.5 rounded border px-1.5 py-1 ${onAir ? 'border-av-red/60' : 'border-av-border'}`} data-testid="onair-caption">
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-semibold text-av-text">{c.title}</div>
                {c.subtitle ? <div className="truncate text-[10px] text-av-muted">{c.subtitle}</div> : null}
              </div>
              <Button
                size="xs"
                variant={onAir ? 'danger' : 'info'}
                icon={onAir ? <EyeOff size={12} /> : <Eye size={12} />}
                onClick={() => (onAir ? store().hideCaption() : store().showCaption(c))}
                aria-label={onAir ? `Hide ${c.title}` : `Show ${c.title}`}
              >
                {onAir ? 'Hide' : 'Show'}
              </Button>
              <button
                type="button"
                onClick={() => store().removeCaption(c.id)}
                className="rounded p-0.5 text-av-dim hover:text-av-red"
                aria-label={`Delete caption ${c.title}`}
              >
                <Trash2 size={12} />
              </button>
            </li>
          );
        })}
      </ul>
      <form
        className="space-y-1"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Name, e.g. Prof. Mahesh Verma"
          maxLength={80}
          aria-label="Caption name"
          className="h-8 w-full rounded-md border border-av-border bg-av-bg px-2 text-xs text-av-text placeholder:text-av-dim focus:border-av-blue focus:outline-none"
          data-testid="onair-caption-title"
        />
        <div className="flex gap-1">
          <input
            value={subtitle}
            onChange={(e) => setSubtitle(e.target.value)}
            placeholder="Role, e.g. Vice Chancellor"
            maxLength={120}
            aria-label="Caption role"
            className="h-8 min-w-0 flex-1 rounded-md border border-av-border bg-av-bg px-2 text-xs text-av-text placeholder:text-av-dim focus:border-av-blue focus:outline-none"
            data-testid="onair-caption-subtitle"
          />
          <Button type="submit" size="sm" variant="primary" icon={<Plus size={13} />} disabled={!title.trim()} data-testid="onair-caption-add">
            Add
          </Button>
        </div>
      </form>
      <div className="flex items-center gap-1 text-[10px] text-av-muted">
        Style
        {(['bar', 'glass'] as CaptionStyle[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => store().setCaptionStyle(s)}
            className={`rounded border px-1.5 py-0.5 ${style === s ? 'border-av-blue text-av-text' : 'border-av-border hover:text-av-text'}`}
          >
            {s === 'bar' ? 'Bar' : 'Glass'}
          </button>
        ))}
        <span className="ml-auto text-av-dim">Cues can show a caption too (cue editor).</span>
      </div>
    </div>
  );
}

function CountdownTab(): JSX.Element {
  const countdown = useOnAirStore((s) => s.countdown);
  const store = useOnAirStore.getState;
  const running = isRunning(countdown.clock);
  const now = useNow(running);
  const left = clockRemaining(countdown.clock, now);
  const finished = countdown.visible && left <= 0;

  return (
    <div className="space-y-2" data-testid="onair-countdown">
      <div className="flex items-center gap-2">
        <div className="font-mono text-4xl font-black tabular-nums leading-none text-av-text" data-testid="onair-countdown-display">
          {formatClockMs(Math.max(0, left))}
        </div>
        <div className="min-w-0 flex-1 text-right text-[10px] text-av-muted">
          {countdown.visible ? (finished ? (countdown.hideAtZero ? 'FINISHED · hidden' : 'FINISHED') : running ? 'ON PROJECTOR' : 'PAUSED') : 'NOT SHOWN'}
        </div>
      </div>
      <input
        value={countdown.message}
        onChange={(e) => store().setCountdownMessage(e.target.value)}
        placeholder="Message above the clock"
        aria-label="Countdown message"
        className="h-8 w-full rounded-md border border-av-border bg-av-bg px-2 text-xs text-av-text focus:border-av-blue focus:outline-none"
        data-testid="onair-countdown-message"
      />
      <div className="flex items-center gap-1.5 text-[11px] text-av-muted">
        Minutes
        <MinutesInput value={countdown.durationMs / 60_000} onChange={(v) => store().setCountdownMinutes(v)} label="Countdown minutes" testId="onair-countdown-minutes" />
        <label className="ml-auto flex cursor-pointer items-center gap-1">
          <input
            type="checkbox"
            checked={countdown.hideAtZero}
            onChange={(e) => store().setCountdownHideAtZero(e.target.checked)}
            className="h-3.5 w-3.5 accent-sky-400"
          />
          Hide at 0:00
        </label>
      </div>
      <div className="grid grid-cols-2 gap-1">
        <Button
          size="sm"
          variant={running ? 'warning' : 'success'}
          icon={running ? <Pause size={13} /> : <Play size={13} />}
          onClick={() => (running ? store().pauseCountdown() : store().startCountdown())}
          data-testid="onair-countdown-start"
        >
          {running ? 'Pause' : countdown.visible && !finished ? 'Resume' : 'Show & start'}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon={<X size={13} />}
          disabled={!countdown.visible}
          onClick={() => store().hideCountdown()}
          data-testid="onair-countdown-hide"
        >
          Hide
        </Button>
      </div>
      <p className="text-[10px] text-av-dim">Shown full screen over the backdrop, e.g. before doors open. Blackout still covers it.</p>
    </div>
  );
}

export function OnAirPanel(): JSX.Element {
  const [tab, setTab] = useState<Tab>('timer');
  const timerActive = useOnAirStore((s) => s.timer.active);
  const captionLive = useOnAirStore((s) => s.liveCaption !== null);
  const countdownVisible = useOnAirStore((s) => s.countdown.visible);

  const tabs: Array<{ key: Tab; label: string; icon: JSX.Element; on: boolean }> = [
    { key: 'timer', label: 'Timer', icon: <Timer size={13} />, on: timerActive },
    { key: 'captions', label: 'Captions', icon: <Captions size={13} />, on: captionLive },
    { key: 'countdown', label: 'Countdown', icon: <Hourglass size={13} />, on: countdownVisible }
  ];

  return (
    <section className="rounded-lg border border-av-border bg-av-panel p-2.5" data-testid="onair-panel">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-av-text">On air</h3>
      </div>
      <div className="mb-2 grid grid-cols-3 gap-1 rounded-md bg-av-bg p-0.5" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`relative flex items-center justify-center gap-1 rounded px-1 py-1 text-[11px] font-semibold ${
              tab === t.key ? 'bg-av-raised text-av-text' : 'text-av-muted hover:text-av-text'
            }`}
            data-testid={`onair-tab-${t.key}`}
          >
            {t.icon}
            {t.label}
            {t.on ? <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-av-red" /> : null}
          </button>
        ))}
      </div>
      {tab === 'timer' ? <SpeakerTimerTab /> : tab === 'captions' ? <CaptionsTab /> : <CountdownTab />}
    </section>
  );
}
