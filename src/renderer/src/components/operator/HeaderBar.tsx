import {
  ClipboardCheck,
  Clock,
  Download,
  FileDown,
  FilePlus,
  Lock,
  Printer,
  Settings,
  Users,
  FolderOpen,
  Monitor,
  MonitorOff,
  Pause,
  Play,
  Projector,
  RotateCcw,
  Save,
  Snowflake,
  SquareArrowUp,
  Timer
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { exportRunSheet, newShow, openShow, saveShow } from '../../services/operatorBridge';
import { useCrewStore } from '../../store/useCrewStore';
import { usePrefsStore } from '../../store/usePrefsStore';
import { formatClock, formatTime } from '../../services/utils';
import { useShowStore } from '../../store/useShowStore';
import { useStageStore } from '../../store/useStageStore';
import { useUpdateStore } from '../../store/useUpdateStore';
import { Button } from '../common/Button';

const LINK_TIMEOUT_MS = 1500;

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Shown only while an update downloads or is ready; installing is always the operator's choice. */
function UpdateBadge(): JSX.Element | null {
  const status = useUpdateStore((s) => s.status);
  const installNow = useUpdateStore((s) => s.installNow);
  if (!status) return null;
  if (status.state === 'downloading') {
    return (
      <span className="rounded-md border border-av-border px-2 py-1 font-mono text-[11px] text-av-muted" title="Downloading the new version in the background">
        Update {status.percent ?? 0}%
      </span>
    );
  }
  if (status.state !== 'ready') return null;
  return (
    <Button
      size="sm"
      variant="success"
      icon={<Download size={14} />}
      onClick={() => void installNow()}
      title="Installs when StageCue closes, or now (StageCue restarts; do it after the show)"
      data-testid="update-ready"
    >
      Restart to update {status.version ? `to ${status.version}` : ''}
    </Button>
  );
}

function EventTimer(): JSX.Element {
  const [running, setRunning] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAt = useRef<number | null>(null);
  const banked = useRef(0);
  useNow(250);

  const current = running && startedAt.current !== null ? banked.current + (Date.now() - startedAt.current) : elapsedMs;

  const toggle = (): void => {
    if (running) {
      banked.current += Date.now() - (startedAt.current ?? Date.now());
      startedAt.current = null;
      setElapsedMs(banked.current);
      setRunning(false);
    } else {
      startedAt.current = Date.now();
      setRunning(true);
    }
  };

  const reset = (): void => {
    banked.current = 0;
    startedAt.current = running ? Date.now() : null;
    setElapsedMs(0);
  };

  return (
    <div className="flex items-center gap-1.5 rounded-md border border-av-border bg-av-bg px-2 py-1" title="Event timer">
      <Timer size={14} className={running ? 'text-av-green' : 'text-av-muted'} />
      <span className={`w-[68px] font-mono text-sm tabular-nums ${running ? 'text-av-text' : 'text-av-muted'}`}>
        {formatTime(current / 1000)}
      </span>
      <button
        type="button"
        onClick={toggle}
        className="rounded p-0.5 text-av-muted hover:bg-av-raised hover:text-av-text"
        aria-label={running ? 'Pause event timer' : 'Start event timer'}
      >
        {running ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <button
        type="button"
        onClick={reset}
        className="rounded p-0.5 text-av-muted hover:bg-av-raised hover:text-av-text"
        aria-label="Reset event timer"
      >
        <RotateCcw size={13} />
      </button>
    </div>
  );
}

function ProjectorBadge(): JSX.Element {
  const status = useStageStore((s) => s.displayStatus);
  const [busy, setBusy] = useState(false);

  if (!status) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-av-border px-2.5 py-1 text-xs text-av-muted">
        <Monitor size={13} /> Detecting displays…
      </span>
    );
  }

  const stageDisplay = status.displays.find((d) => d.id === status.stageDisplayId);
  const projector = status.mode === 'projector';
  const docked = status.mode === 'docked';

  const changeTarget = async (value: string): Promise<void> => {
    setBusy(true);
    try {
      const next = await window.api.invoke('display:set-stage-target', value === 'auto' ? null : Number(value));
      useStageStore.getState().setDisplayStatus(next);
    } catch (error) {
      useShowStore
        .getState()
        .pushAlert('error', 'Could not move stage output', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <span
        data-testid="projector-badge"
        data-mode={status.mode}
        className={[
          'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold',
          projector
            ? 'border-av-green/60 bg-av-green/10 text-av-green'
            : docked
              ? 'border-av-red/60 bg-av-red/10 text-av-red'
              : 'border-av-amber/60 bg-av-amber/10 text-av-amber'
        ].join(' ')}
        title={
          projector && stageDisplay
            ? `${stageDisplay.name} — ${stageDisplay.bounds.width}×${stageDisplay.bounds.height}`
            : 'No external display detected'
        }
      >
        {projector ? <Projector size={13} /> : <MonitorOff size={13} />}
        {projector
          ? `HDMI ACTIVE · ${stageDisplay ? `${stageDisplay.bounds.width}×${stageDisplay.bounds.height}` : ''}`
          : docked
            ? 'HDMI LOST · DOCKED'
            : 'REHEARSAL MODE'}
      </span>
      {status.displays.length > 1 ? (
        <select
          aria-label="Stage output display"
          disabled={busy}
          value={status.preferredStageDisplayId === null ? 'auto' : String(status.preferredStageDisplayId)}
          onChange={(event) => void changeTarget(event.target.value)}
          className="h-7 rounded-md border border-av-border bg-av-bg px-1.5 text-xs text-av-text"
        >
          <option value="auto">Auto</option>
          {status.displays.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {d.isPrimary ? ' (primary)' : ''}
            </option>
          ))}
        </select>
      ) : null}
      {!projector ? (
        <Button
          size="sm"
          variant="ghost"
          icon={<SquareArrowUp size={14} />}
          onClick={() => void window.api.invoke('display:raise-stage')}
          title="Bring the stage preview window to the front"
        >
          Show stage
        </Button>
      ) : null}
    </div>
  );
}

function StatusChips(): JSX.Element {
  const program = useStageStore((s) => s.program);
  const telemetryAt = useStageStore((s) => s.lastTelemetryAt);
  const connected = useStageStore((s) => s.stageConnected);
  const now = useNow(500);
  const linkOk = connected && now - telemetryAt < LINK_TIMEOUT_MS;

  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-bold tracking-wider ${
          linkOk ? 'bg-av-green/10 text-av-green' : 'bg-av-red/15 text-av-red'
        }`}
        title={linkOk ? 'Stage window is responding' : 'No telemetry from the stage window'}
        data-testid="stage-link"
      >
        <span className={`h-2 w-2 rounded-full ${linkOk ? 'animate-live-blink bg-av-green' : 'bg-av-red'}`} />
        {linkOk ? 'STAGE LINK' : 'NO LINK'}
      </span>
      {program.isFrozen ? (
        <span
          data-testid="status-frozen"
          className="inline-flex items-center gap-1 rounded-md bg-av-blue px-2 py-1 text-[11px] font-black tracking-wider text-av-bg"
        >
          <Snowflake size={12} /> FROZEN
        </span>
      ) : null}
      {program.isBlackout ? (
        <span
          data-testid="status-blackout"
          className="inline-flex items-center gap-1 rounded-md bg-av-red px-2 py-1 text-[11px] font-black tracking-wider text-av-bg"
        >
          BLACKOUT
        </span>
      ) : null}
    </div>
  );
}

function PreshowButton(): JSX.Element {
  const report = useShowStore((s) => s.preshowReport);
  const setPanel = useShowStore((s) => s.setPanel);
  const tone = !report
    ? 'bg-av-dim'
    : report.errors > 0
      ? 'bg-av-red'
      : report.warnings > 0
        ? 'bg-av-amber'
        : 'bg-av-green';
  const title = !report
    ? 'Pre-show check: test every cue, file, the projector and audio (Ctrl+Shift+C)'
    : `Last check ${new Date(report.checkedAt).toLocaleTimeString()}: ${report.errors} error(s), ${report.warnings} warning(s)`;
  return (
    <Button
      size="sm"
      variant={report && report.errors > 0 ? 'danger' : 'secondary'}
      icon={<ClipboardCheck size={14} />}
      iconRight={<span className={`h-2 w-2 rounded-full ${tone}`} />}
      onClick={() => setPanel('preshow')}
      title={title}
      data-testid="open-preshow"
    >
      Check
    </Button>
  );
}

function CrewButton(): JSX.Element {
  const info = usePrefsStore((s) => s.remoteInfo);
  const locked = usePrefsStore((s) => s.stageLocked);
  const unread = useCrewStore((s) => s.unread);
  const running = info?.enabled === true;
  const count = running ? info.clients.length : 0;
  return (
    <button
      type="button"
      onClick={() => useShowStore.getState().setPanel('crew')}
      className={`relative inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11px] font-semibold ${
        running ? 'border-av-green/40 bg-av-green/10 text-av-green' : 'border-av-border text-av-muted'
      }`}
      title={running ? `Crew remote on · ${count} device(s)${locked ? ' · stage locked' : ''}` : 'Crew: stage team phones & messages'}
      data-testid="remote-indicator"
    >
      <Users size={13} />
      Crew
      {running ? <span className="font-mono">{count}</span> : null}
      {locked && running ? <Lock size={11} className="text-av-amber" /> : null}
      {unread > 0 ? (
        <span
          className="absolute -right-1.5 -top-1.5 min-w-[16px] rounded-full bg-av-amber px-1 text-center font-mono text-[10px] font-bold text-av-bg"
          data-testid="crew-unread"
        >
          {unread}
        </span>
      ) : null}
    </button>
  );
}

export function HeaderBar(): JSX.Element {
  const showName = useShowStore((s) => s.showName);
  const isDirty = useShowStore((s) => s.isDirty);
  const now = useNow(1000);

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-av-border bg-av-panel px-3">
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-av-blue/15 text-av-blue">
          <Projector size={16} />
        </div>
        <div className="leading-tight">
          <div className="text-[13px] font-bold tracking-wide text-av-text">StageCue AV</div>
          <div className="max-w-[220px] truncate text-[11px] text-av-muted" title={showName}>
            {showName}
            {isDirty ? <span className="ml-1 text-av-amber">●</span> : null}
          </div>
        </div>
      </div>

      <div className="mx-1 h-6 w-px bg-av-border" />
      <ProjectorBadge />
      <StatusChips />

      <div className="ml-auto flex items-center gap-2">
        <UpdateBadge />
        <EventTimer />
        <div className="flex items-center gap-1.5 rounded-md border border-av-border bg-av-bg px-2 py-1" title="Local time">
          <Clock size={14} className="text-av-muted" />
          <span className="font-mono text-sm tabular-nums text-av-text">{formatClock(new Date(now))}</span>
        </div>
        <div className="mx-1 h-6 w-px bg-av-border" />
        <PreshowButton />
        <CrewButton />
        <Button
          size="sm"
          variant="ghost"
          icon={<FileDown size={14} />}
          onClick={() => void exportRunSheet('pdf')}
          title="Export run sheet as PDF (Ctrl+E)"
          aria-label="Export run sheet PDF"
        />
        <Button
          size="sm"
          variant="ghost"
          icon={<Printer size={14} />}
          onClick={() => void exportRunSheet('print')}
          title="Print run sheet (Ctrl+P)"
          aria-label="Print run sheet"
        />
        <Button
          size="sm"
          variant="ghost"
          icon={<Settings size={14} />}
          onClick={() => useShowStore.getState().setPanel('settings')}
          title="Settings: auto-follow, clicker, phone remote, audio output (Ctrl+,)"
          aria-label="Settings"
          data-testid="open-settings"
        />
        <div className="mx-1 h-6 w-px bg-av-border" />
        <Button
          size="sm"
          variant="ghost"
          icon={<FilePlus size={14} />}
          onClick={() => newShow()}
          title="New show (Ctrl+N)"
          aria-label="New show"
        />
        <Button
          size="sm"
          variant="ghost"
          icon={<FolderOpen size={14} />}
          onClick={() => void openShow()}
          title="Open show (Ctrl+O)"
          aria-label="Open show"
        />
        <Button
          size="sm"
          variant={isDirty ? 'warning' : 'secondary'}
          icon={<Save size={14} />}
          onClick={() => void saveShow(false)}
          title="Save show (Ctrl+S)"
        >
          Save
        </Button>
      </div>
    </header>
  );
}
