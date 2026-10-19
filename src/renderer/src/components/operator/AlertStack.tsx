import { AlertTriangle, CheckCircle2, Info, X, XOctagon } from 'lucide-react';
import { useEffect } from 'react';
import type { AlertLevel, OperatorAlert } from '../../types';
import { useShowStore } from '../../store/useShowStore';

/* Operator-only banners. Nothing here is ever rendered on the stage window. */

const AUTO_DISMISS_MS: Record<AlertLevel, number> = { success: 3500, info: 5000, warning: 7000, error: 9000 };
/** Never let banners pile up over the cue stack during a show. */
const MAX_VISIBLE = 3;

const STYLES: Record<AlertLevel, { box: string; icon: JSX.Element }> = {
  info: { box: 'border-av-blue/50 bg-[#0b1d2b]', icon: <Info size={16} className="text-av-blue" /> },
  success: { box: 'border-av-green/50 bg-[#0d2316]', icon: <CheckCircle2 size={16} className="text-av-green" /> },
  warning: { box: 'border-av-amber/60 bg-[#2a2109]', icon: <AlertTriangle size={16} className="text-av-amber" /> },
  error: { box: 'border-av-red/70 bg-[#2d1214]', icon: <XOctagon size={16} className="text-av-red" /> }
};

function AlertItem({ alert }: { alert: OperatorAlert }): JSX.Element {
  const dismiss = useShowStore((s) => s.dismissAlert);

  useEffect(() => {
    if (alert.sticky) return undefined;
    const timer = window.setTimeout(() => dismiss(alert.id), AUTO_DISMISS_MS[alert.level]);
    return () => window.clearTimeout(timer);
  }, [alert.id, alert.level, alert.sticky, dismiss]);

  const style = STYLES[alert.level];
  return (
    <div
      role={alert.level === 'error' ? 'alert' : 'status'}
      data-testid="operator-alert"
      data-level={alert.level}
      className={`pointer-events-auto flex w-[380px] items-start gap-2.5 rounded-lg border px-3 py-2.5 shadow-xl shadow-black/50 ${style.box}`}
    >
      <span className="mt-0.5 shrink-0">{style.icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-av-text">{alert.title}</div>
        <div className="mt-0.5 break-words text-xs text-av-muted">{alert.message}</div>
      </div>
      <button
        type="button"
        onClick={() => dismiss(alert.id)}
        className="shrink-0 rounded p-0.5 text-av-muted hover:bg-white/10 hover:text-av-text"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function AlertStack(): JSX.Element {
  const alerts = useShowStore((s) => s.alerts);
  const clearAlerts = useShowStore((s) => s.clearAlerts);
  // Errors stay visible first; then the newest of the rest.
  const errors = alerts.filter((a) => a.level === 'error');
  const others = alerts.filter((a) => a.level !== 'error');
  const visible = [...errors, ...others].slice(-MAX_VISIBLE);
  const hidden = alerts.length - visible.length;
  return (
    <div className="pointer-events-none fixed bottom-3 right-3 z-40 flex flex-col items-end gap-2" aria-live="polite">
      {hidden > 0 ? (
        <button
          type="button"
          onClick={clearAlerts}
          className="pointer-events-auto rounded-md border border-av-border bg-av-panel px-2 py-1 text-[11px] text-av-muted hover:text-av-text"
        >
          +{hidden} more · dismiss all
        </button>
      ) : null}
      {visible.map((alert) => (
        <AlertItem key={alert.id} alert={alert} />
      ))}
    </div>
  );
}
