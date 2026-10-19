import { EyeOff, ImageIcon, Snowflake, VolumeX } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useAudioStore } from '../../store/useAudioStore';
import { useStageStore } from '../../store/useStageStore';

interface PadButtonProps {
  label: string;
  hotkey: string;
  icon: ReactNode;
  onClick: () => void;
  state: 'idle' | 'freeze' | 'blackout' | 'busy';
  hint: string;
  testId: string;
  disabled?: boolean;
  children?: ReactNode;
}

function PadButton({ label, hotkey, icon, onClick, state, hint, testId, disabled = false, children }: PadButtonProps): JSX.Element {
  const tone =
    state === 'freeze'
      ? 'animate-freeze-pulse border-av-blue text-white'
      : state === 'blackout'
        ? 'border-av-red bg-av-red text-av-bg shadow-[0_0_24px_rgba(248,113,113,0.45)]'
        : state === 'busy'
          ? 'border-av-amber bg-av-amber/15 text-av-amber'
          : 'border-av-border bg-av-raised text-av-text hover:border-av-muted hover:bg-av-hover';
  return (
    <button
      type="button"
      data-testid={testId}
      data-state={state}
      onClick={onClick}
      disabled={disabled}
      title={hint}
      className={`relative flex h-[76px] flex-col items-center justify-center gap-1 overflow-hidden rounded-lg border-2 px-2 text-center transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${tone}`}
    >
      <span className="flex items-center gap-1.5 text-[13px] font-black tracking-wider">
        {icon}
        {label}
      </span>
      <span
        className={`rounded px-1.5 py-px font-mono text-[10px] font-bold ${
          state === 'blackout' ? 'bg-black/20' : 'bg-black/40 text-av-muted'
        }`}
      >
        {hotkey}
      </span>
      {children}
    </button>
  );
}

function FadeProgress({ endsAt, durationMs }: { endsAt: number; durationMs: number }): JSX.Element {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 50);
    return () => window.clearInterval(timer);
  }, []);
  const remaining = Math.max(0, endsAt - now);
  const progress = 1 - remaining / durationMs;
  return (
    <span className="absolute bottom-0 left-0 h-1 bg-av-amber" style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }} />
  );
}

export function EmergencyPanel(): JSX.Element {
  const isFrozen = useStageStore((s) => s.program.isFrozen);
  const isBlackout = useStageStore((s) => s.program.isBlackout);
  const hasForeground = useStageStore((s) => s.program.foreground !== null);
  const freezeAck = useStageStore((s) => s.lastFreezeAck);
  const freezePending = useStageStore((s) => s.freezePending);
  const toggleFreeze = useStageStore((s) => s.toggleFreeze);
  const toggleBlackout = useStageStore((s) => s.toggleBlackout);
  const instantBackdrop = useStageStore((s) => s.instantBackdrop);
  const fadeOutMusic = useAudioStore((s) => s.fadeOutMusic);
  const audioTelemetry = useAudioStore((s) => s.telemetry);
  const hasMusic = useAudioStore((s) => s.bgMusicMedia !== null);

  const fading = audioTelemetry !== null && audioTelemetry.isFadingOut && audioTelemetry.fadeEndsAt !== null;

  return (
    <section className="rounded-lg border border-av-border bg-av-panel p-2" data-testid="emergency-panel">
      <header className="mb-2 flex items-center justify-between px-0.5">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-av-text">Emergency Pad</h3>
        <span className="font-mono text-[10px] text-av-muted" title="Time between the freeze command and the stage confirming it">
          {freezePending
            ? 'freeze…'
            : freezeAck && freezeAck.isFrozen
              ? `freeze ack ${freezeAck.latencyMs} ms`
              : 'operator focus locked'}
        </span>
      </header>
      <div className="grid grid-cols-2 gap-2">
        <PadButton
          label={isFrozen ? 'UNFREEZE' : 'FREEZE'}
          hotkey="F8"
          icon={<Snowflake size={16} />}
          state={isFrozen ? 'freeze' : 'idle'}
          onClick={toggleFreeze}
          hint="Lock the projector on the current frame. Browse freely on this screen."
          testId="pad-freeze"
        />
        <PadButton
          label="BLACKOUT"
          hotkey="ESC"
          icon={<EyeOff size={16} />}
          state={isBlackout ? 'blackout' : 'idle'}
          onClick={toggleBlackout}
          hint="Instant black on the projector. Press again to fade back."
          testId="pad-blackout"
        />
        <PadButton
          label="BACKDROP"
          hotkey="F4"
          icon={<ImageIcon size={16} />}
          state="idle"
          onClick={instantBackdrop}
          disabled={!hasForeground && !isFrozen}
          hint="Drop the video immediately and return to the stage poster."
          testId="pad-backdrop"
        />
        <PadButton
          label="FADE AUDIO"
          hotkey="F9"
          icon={<VolumeX size={16} />}
          state={fading ? 'busy' : 'idle'}
          onClick={() => fadeOutMusic()}
          disabled={!hasMusic}
          hint="Fade the background music out smoothly over 3 seconds."
          testId="pad-fade-audio"
        >
          {fading && audioTelemetry && audioTelemetry.fadeEndsAt !== null ? (
            <FadeProgress endsAt={audioTelemetry.fadeEndsAt} durationMs={3000} />
          ) : null}
        </PadButton>
      </div>
    </section>
  );
}
