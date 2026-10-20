import { AlertTriangle, CheckCircle2, Info, Loader2, Play, XOctagon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { MediaItem } from '../../types';
import { probeMedia } from '../../services/mediaProbe';
import { runPreshowCheck, type CheckIssue, type CheckLevel, type PreshowReport } from '../../services/preshowCheck';
import { useAudioStore } from '../../store/useAudioStore';
import { useMediaStore } from '../../store/useMediaStore';
import { useShowStore } from '../../store/useShowStore';
import { useStageStore } from '../../store/useStageStore';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';

const LINK_TIMEOUT_MS = 1500;

const LEVEL_STYLE: Record<CheckLevel, { icon: JSX.Element; box: string }> = {
  error: { icon: <XOctagon size={15} className="text-av-red" />, box: 'border-av-red/50 bg-av-red/5' },
  warning: { icon: <AlertTriangle size={15} className="text-av-amber" />, box: 'border-av-amber/50 bg-av-amber/5' },
  info: { icon: <Info size={15} className="text-av-blue" />, box: 'border-av-border bg-av-bg' }
};

async function findMissingFiles(items: MediaItem[]): Promise<Set<string>> {
  if (items.length === 0) return new Set();
  const resolved = await window.api.invoke(
    'media:read-metadata',
    items.map((i) => ({ filePath: i.filePath }))
  );
  const missing = new Set<string>();
  resolved.forEach((file, index) => {
    if (!file.exists) missing.add(items[index].id);
  });
  return missing;
}

export async function runCheckNow(onProgress?: (done: number, total: number, label: string) => void): Promise<PreshowReport> {
  const stage = useStageStore.getState();
  const audio = useAudioStore.getState();
  const report = await runPreshowCheck(
    {
      cues: stage.cues,
      items: useMediaStore.getState().items,
      displayStatus: stage.displayStatus,
      stageLinkOk: stage.stageConnected && Date.now() - stage.lastTelemetryAt < LINK_TIMEOUT_MS,
      audioContextState: audio.telemetry?.contextState ?? 'uninitialized',
      outputPref: audio.outputPref,
      outputMissing: audio.outputMissing,
      isDirty: useShowStore.getState().isDirty
    },
    {
      findMissingFiles: async (items) => {
        const missing = await findMissingFiles(items);
        useMediaStore.getState().markMissing(missing);
        return missing;
      },
      probe: async (item) => {
        const result = await probeMedia(item);
        return { ok: !result.probeError, problem: result.probeError, duration: result.duration, dimensions: result.dimensions };
      },
      checkLive: async (item) => {
        try {
          if (item.type === 'web') {
            const result = await window.api.invoke('web:inspect', { url: item.web?.url ?? item.fileUrl, snapshot: false });
            return { ok: result.ok, problem: result.error ?? undefined };
          }
          const capture = item.capture;
          if (!capture) return { ok: false, problem: 'No window selected' };
          const id = await window.api.invoke('capture:resolve', { sourceId: capture.sourceId, name: item.name, kind: capture.kind });
          return id ? { ok: true } : { ok: false, problem: `“${item.name}” is not open on this laptop. Open it before its cue.` };
        } catch (error) {
          return { ok: false, problem: error instanceof Error ? error.message : String(error) };
        }
      },
      onProgress
    }
  );
  useShowStore.getState().setPreshowReport(report);
  return report;
}

function IssueRow({ issue, onGoToCue }: { issue: CheckIssue; onGoToCue: (cueId: string) => void }): JSX.Element {
  const style = LEVEL_STYLE[issue.level];
  return (
    <li className={`flex items-start gap-2.5 rounded-md border px-3 py-2 ${style.box}`} data-testid="preshow-issue" data-level={issue.level}>
      <span className="mt-0.5 shrink-0">{style.icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-av-text">{issue.title}</div>
        <div className="break-words text-xs text-av-muted">{issue.detail}</div>
      </div>
      {issue.cueId ? (
        <Button size="xs" variant="ghost" onClick={() => onGoToCue(issue.cueId as string)}>
          Go to cue
        </Button>
      ) : null}
    </li>
  );
}

export function PreshowCheckModal(): JSX.Element | null {
  const panel = useShowStore((s) => s.panel);
  const setPanel = useShowStore((s) => s.setPanel);
  const report = useShowStore((s) => s.preshowReport);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; label: string }>({ done: 0, total: 0, label: '' });
  const startedFor = useRef(false);
  const open = panel === 'preshow';

  const start = async (): Promise<void> => {
    setRunning(true);
    setProgress({ done: 0, total: 0, label: 'Starting…' });
    try {
      await runCheckNow((done, total, label) => setProgress({ done, total, label }));
    } catch (error) {
      useShowStore.getState().pushAlert('error', 'Pre-show check failed', error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    if (open && !startedFor.current) {
      startedFor.current = true;
      void start();
    }
    if (!open) startedFor.current = false;
  }, [open]);

  if (!open) return null;

  const close = (): void => setPanel('none');
  const goToCue = (cueId: string): void => {
    useStageStore.getState().selectCue(cueId);
    close();
  };
  const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 5;

  return (
    <Modal
      open
      title="Pre-show check"
      onClose={close}
      width="md"
      testId="preshow-modal"
      footer={
        <>
          <span className="mr-auto text-xs text-av-muted">
            {report && !running
              ? `Checked ${report.cuesChecked} cue(s) and ${report.mediaChecked} file(s) at ${new Date(report.checkedAt).toLocaleTimeString()}`
              : 'Every file is opened and decoded the same way the stage will play it.'}
          </span>
          <Button size="sm" variant="ghost" onClick={close}>
            Close
          </Button>
          <Button size="sm" variant="primary" icon={<Play size={13} />} onClick={() => void start()} disabled={running}>
            Run again
          </Button>
        </>
      }
    >
      {running ? (
        <div className="py-6" data-testid="preshow-running">
          <div className="mb-2 flex items-center gap-2 text-sm text-av-text">
            <Loader2 size={16} className="animate-spin text-av-blue" />
            <span className="truncate">{progress.label || 'Checking…'}</span>
            <span className="ml-auto font-mono text-xs text-av-muted">
              {progress.total > 0 ? `${progress.done}/${progress.total}` : ''}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-av-raised">
            <div className="h-full bg-av-blue transition-[width]" style={{ width: `${percent}%` }} />
          </div>
        </div>
      ) : report ? (
        <div className="space-y-3">
          <div
            data-testid="preshow-summary"
            data-ready={report.ready ? 'true' : 'false'}
            className={`flex items-center gap-3 rounded-lg border px-4 py-3 ${
              report.ready ? 'border-av-green/60 bg-av-green/10' : 'border-av-red/60 bg-av-red/10'
            }`}
          >
            {report.ready ? <CheckCircle2 size={26} className="text-av-green" /> : <XOctagon size={26} className="text-av-red" />}
            <div>
              <div className={`text-base font-bold ${report.ready ? 'text-av-green' : 'text-av-red'}`}>
                {report.ready ? 'Ready for the show' : `${report.errors} problem${report.errors === 1 ? '' : 's'} to fix`}
              </div>
              <div className="text-xs text-av-muted">
                {report.errors} error(s) · {report.warnings} warning(s)
              </div>
            </div>
          </div>
          {report.issues.length > 0 ? (
            <ul className="max-h-[50vh] space-y-1.5 overflow-y-auto pr-1">
              {report.issues.map((issue) => (
                <IssueRow key={issue.id} issue={issue} onGoToCue={goToCue} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-av-muted">Every cue, file, the projector and the audio output passed.</p>
          )}
        </div>
      ) : null}
    </Modal>
  );
}
