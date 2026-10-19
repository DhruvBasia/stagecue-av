import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'warning' | 'info' | 'success';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  iconRight?: ReactNode;
  active?: boolean;
  fullWidth?: boolean;
}

const VARIANTS: Record<ButtonVariant, { base: string; active: string }> = {
  primary: {
    base: 'bg-av-blue/15 text-av-blue border-av-blue/50 hover:bg-av-blue/25',
    active: 'bg-av-blue text-av-bg border-av-blue'
  },
  secondary: {
    base: 'bg-av-raised text-av-text border-av-border hover:bg-av-hover hover:border-av-muted/60',
    active: 'bg-av-text text-av-bg border-av-text'
  },
  ghost: {
    base: 'bg-transparent text-av-muted border-transparent hover:bg-av-raised hover:text-av-text',
    active: 'bg-av-raised text-av-text border-av-border'
  },
  danger: {
    base: 'bg-av-red/10 text-av-red border-av-red/50 hover:bg-av-red/20',
    active: 'bg-av-red text-av-bg border-av-red'
  },
  warning: {
    base: 'bg-av-amber/10 text-av-amber border-av-amber/50 hover:bg-av-amber/20',
    active: 'bg-av-amber text-av-bg border-av-amber'
  },
  info: {
    base: 'bg-sky-950/40 text-av-blue border-av-blue/40 hover:bg-sky-900/40',
    active: 'bg-av-blue text-av-bg border-av-blue'
  },
  success: {
    base: 'bg-av-green/10 text-av-green border-av-green/50 hover:bg-av-green/20',
    active: 'bg-av-green text-av-bg border-av-green'
  }
};

const SIZES: Record<ButtonSize, string> = {
  xs: 'h-6 px-1.5 text-[11px] gap-1 rounded',
  sm: 'h-7 px-2 text-xs gap-1.5 rounded-md',
  md: 'h-9 px-3 text-sm gap-2 rounded-md',
  lg: 'h-12 px-4 text-base gap-2 rounded-lg',
  xl: 'h-16 px-5 text-lg gap-3 rounded-xl'
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    icon,
    iconRight,
    active = false,
    fullWidth = false,
    className = '',
    children,
    type = 'button',
    ...rest
  },
  ref
) {
  const palette = VARIANTS[variant];
  return (
    <button
      ref={ref}
      type={type}
      aria-pressed={rest['aria-pressed'] ?? (active ? true : undefined)}
      className={[
        'inline-flex select-none items-center justify-center border font-medium transition-colors duration-100',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-av-blue/70 focus-visible:ring-offset-1 focus-visible:ring-offset-av-bg',
        'disabled:cursor-not-allowed disabled:opacity-40',
        active ? palette.active : palette.base,
        SIZES[size],
        fullWidth ? 'w-full' : '',
        className
      ].join(' ')}
      {...rest}
    >
      {icon ? <span className="inline-flex shrink-0 items-center">{icon}</span> : null}
      {children !== undefined && children !== null ? <span className="truncate">{children}</span> : null}
      {iconRight ? <span className="inline-flex shrink-0 items-center">{iconRight}</span> : null}
    </button>
  );
});
