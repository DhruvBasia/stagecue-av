/* Layer 3 — highest-priority pure black overlay with instant or smooth fade. */

export interface StageBlackoutProps {
  active: boolean;
  fadeMs: number;
}

export function StageBlackout({ active, fadeMs }: StageBlackoutProps): JSX.Element {
  return (
    <div
      data-testid="blackout-layer"
      data-active={active ? 'true' : 'false'}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 bg-black"
      style={{
        zIndex: 30,
        opacity: active ? 1 : 0,
        transition: fadeMs > 0 ? `opacity ${fadeMs}ms ease-in-out` : 'none'
      }}
    />
  );
}
