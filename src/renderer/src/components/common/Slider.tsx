import { useId, type CSSProperties } from 'react';

export interface SliderProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  orientation?: 'horizontal' | 'vertical';
  disabled?: boolean;
  accent?: 'blue' | 'amber' | 'red' | 'green';
  /** Formats the readout under/next to the slider. */
  format?: (value: number) => string;
  /** Double-click resets to this value. */
  defaultValue?: number;
  /** Optional live level (0-1) drawn as a meter beside a vertical fader. */
  meter?: number;
  className?: string;
  testId?: string;
}

const ACCENTS: Record<NonNullable<SliderProps['accent']>, string> = {
  blue: '#38bdf8',
  amber: '#fbbf24',
  red: '#f87171',
  green: '#4ade80'
};

function meterColor(level: number): string {
  if (level > 0.89) return '#f87171';
  if (level > 0.6) return '#fbbf24';
  return '#4ade80';
}

export function Slider({
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
  label,
  orientation = 'horizontal',
  disabled = false,
  accent = 'blue',
  format,
  defaultValue,
  meter,
  className = '',
  testId
}: SliderProps): JSX.Element {
  const id = useId();
  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
  const color = ACCENTS[accent];
  const vertical = orientation === 'vertical';
  const trackStyle: CSSProperties = {
    ['--slider-fill' as string]: `${Math.max(0, Math.min(100, percent))}%`,
    ['--slider-accent' as string]: color
  };

  const input = (
    <input
      id={id}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      data-testid={testId}
      aria-label={label}
      onChange={(event) => onChange(Number(event.target.value))}
      onDoubleClick={() => {
        if (defaultValue !== undefined && !disabled) onChange(defaultValue);
      }}
      className={vertical ? 'av-range av-range-vertical' : 'av-range'}
      style={trackStyle}
    />
  );

  if (vertical) {
    const level = Math.max(0, Math.min(1, meter ?? 0));
    return (
      <div className={`flex flex-col items-center gap-1.5 ${className}`}>
        {label ? (
          <label htmlFor={id} className="text-[10px] font-semibold uppercase tracking-wider text-av-muted">
            {label}
          </label>
        ) : null}
        <div className="flex h-full min-h-0 flex-1 items-stretch gap-1.5">
          {input}
          {meter !== undefined ? (
            <div className="relative w-1.5 overflow-hidden rounded-full bg-av-bg" aria-hidden="true">
              <div
                className="absolute bottom-0 left-0 right-0 rounded-full transition-[height] duration-75"
                style={{ height: `${level * 100}%`, backgroundColor: meterColor(level) }}
              />
            </div>
          ) : null}
        </div>
        <span className="font-mono text-[11px] tabular-nums text-av-text">{format ? format(value) : value.toFixed(2)}</span>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {label ? (
        <label htmlFor={id} className="w-20 shrink-0 text-xs text-av-muted">
          {label}
        </label>
      ) : null}
      <div className="flex-1">{input}</div>
      <span className="w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-av-text">
        {format ? format(value) : value.toFixed(2)}
      </span>
    </div>
  );
}
