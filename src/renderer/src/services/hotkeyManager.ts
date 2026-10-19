/* =========================================================================
 * Operator keyboard shortcuts.
 *
 * Listens in the capture phase on the operator window so a focused button can
 * never swallow (or double-fire) Space. Emergency keys (F4/F8/F9) work from
 * anywhere, including text fields and open dialogs.
 * ========================================================================= */

export type HotkeyAction =
  | 'take'
  | 'freeze'
  | 'blackout'
  | 'instant-backdrop'
  | 'fade-audio'
  | 'next-cue'
  | 'prev-cue'
  | 'toggle-video'
  | 'toggle-follow';

export interface HotkeyBinding {
  action: HotkeyAction;
  /** Matched against KeyboardEvent.code first, then KeyboardEvent.key. */
  keys: string[];
  shift?: boolean;
  label: string;
  description: string;
  /** Fires even while typing in a text field. */
  allowInTextInput: boolean;
  /** Fires while a modal dialog is open. */
  allowInModal: boolean;
  /** Ignore OS auto-repeat (holding the key down). */
  ignoreRepeat: boolean;
  /** Presentation-clicker key; only active when the clicker setting is ON. */
  clicker?: boolean;
}

export const DEFAULT_BINDINGS: readonly HotkeyBinding[] = [
  {
    action: 'take',
    keys: ['Space'],
    label: 'Space',
    description: 'TAKE the highlighted cue',
    allowInTextInput: false,
    allowInModal: false,
    ignoreRepeat: true
  },
  {
    action: 'freeze',
    keys: ['F8'],
    label: 'F8',
    description: 'Software freeze / unfreeze the projector',
    allowInTextInput: true,
    allowInModal: true,
    ignoreRepeat: true
  },
  {
    action: 'blackout',
    keys: ['Escape'],
    label: 'ESC',
    description: 'Instant blackout toggle',
    allowInTextInput: false,
    allowInModal: false,
    ignoreRepeat: true
  },
  {
    action: 'instant-backdrop',
    keys: ['F4'],
    label: 'F4',
    description: 'Drop the video and return to the backdrop',
    allowInTextInput: true,
    allowInModal: true,
    ignoreRepeat: true
  },
  {
    action: 'fade-audio',
    keys: ['F9'],
    label: 'F9',
    description: 'Fade background music out over 3 seconds',
    allowInTextInput: true,
    allowInModal: true,
    ignoreRepeat: true
  },
  {
    action: 'next-cue',
    keys: ['ArrowDown'],
    label: '↓',
    description: 'Highlight next cue',
    allowInTextInput: false,
    allowInModal: false,
    ignoreRepeat: false
  },
  {
    action: 'prev-cue',
    keys: ['ArrowUp'],
    label: '↑',
    description: 'Highlight previous cue',
    allowInTextInput: false,
    allowInModal: false,
    ignoreRepeat: false
  },
  {
    action: 'toggle-video',
    keys: ['KeyP'],
    shift: true,
    label: 'Shift+P',
    description: 'Play / pause the program video',
    allowInTextInput: false,
    allowInModal: false,
    ignoreRepeat: true
  },
  // Presentation clickers send Page Down/Up or arrow keys, and B / "." for their "blank screen" button.
  {
    action: 'take',
    keys: ['PageDown', 'ArrowRight'],
    label: 'PgDn / →',
    description: 'Clicker: TAKE',
    allowInTextInput: false,
    allowInModal: false,
    ignoreRepeat: true,
    clicker: true
  },
  {
    action: 'prev-cue',
    keys: ['PageUp', 'ArrowLeft'],
    label: 'PgUp / ←',
    description: 'Clicker: highlight previous cue',
    allowInTextInput: false,
    allowInModal: false,
    ignoreRepeat: true,
    clicker: true
  },
  {
    action: 'blackout',
    keys: ['KeyB', 'Period'],
    label: 'B / .',
    description: 'Clicker: blank screen (blackout)',
    allowInTextInput: false,
    allowInModal: false,
    ignoreRepeat: true,
    clicker: true
  }
];

export interface KeyEventLike {
  code: string;
  key: string;
  repeat: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export type FocusKind = 'none' | 'text' | 'slider' | 'control';

export interface HotkeyContext {
  focus: FocusKind;
  modalOpen: boolean;
  /** Presentation-clicker keys are live (default true). */
  clickerEnabled?: boolean;
}

const ARROW_ACTIONS: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'password',
  'url',
  'tel',
  'number',
  'date',
  'time',
  'datetime-local',
  'month',
  'week'
]);

interface ElementLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
}

/** Classifies the focused element so shortcuts never fight with typing or slider arrows. */
export function classifyFocus(target: unknown): FocusKind {
  if (typeof target !== 'object' || target === null) return 'none';
  const el = target as ElementLike;
  if (el.isContentEditable) return 'text';
  const tag = (el.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return 'text';
  if (tag === 'INPUT') {
    const type = (el.type ?? 'text').toLowerCase();
    if (TEXT_INPUT_TYPES.has(type)) return 'text';
    if (type === 'range') return 'slider';
    return 'control';
  }
  if (tag === 'BUTTON' || tag === 'A') return 'control';
  return 'none';
}

export function matchHotkey(
  event: KeyEventLike,
  context: HotkeyContext,
  bindings: readonly HotkeyBinding[] = DEFAULT_BINDINGS
): HotkeyBinding | null {
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  for (const binding of bindings) {
    if (binding.clicker && context.clickerEnabled === false) continue;
    const keyMatches = binding.keys.includes(event.code) || binding.keys.includes(event.key);
    if (!keyMatches) continue;
    if ((binding.shift ?? false) !== event.shiftKey) continue;
    if (binding.ignoreRepeat && event.repeat) return null;
    if (context.modalOpen && !binding.allowInModal) return null;
    if (context.focus === 'text' && !binding.allowInTextInput) return null;
    // Arrow keys belong to a focused slider (fine fader trims).
    if (context.focus === 'slider' && (ARROW_ACTIONS.has(event.key) || ARROW_ACTIONS.has(event.code))) return null;
    return binding;
  }
  return null;
}

export type HotkeyHandlers = Partial<Record<HotkeyAction, () => void>>;

export interface HotkeyManagerOptions {
  isModalOpen: () => boolean;
  isClickerEnabled?: () => boolean;
  bindings?: readonly HotkeyBinding[];
}

export class HotkeyManager {
  private attached = false;
  private readonly bindings: readonly HotkeyBinding[];

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const focus = classifyFocus(event.target);
    const modalOpen = this.options.isModalOpen();

    // ESC inside a text field only leaves the field; a second ESC blacks out.
    if (event.key === 'Escape' && focus === 'text' && !modalOpen) {
      const target = event.target as HTMLElement | null;
      target?.blur();
      event.preventDefault();
      return;
    }

    const clickerEnabled = this.options.isClickerEnabled ? this.options.isClickerEnabled() : true;
    const binding = matchHotkey(event, { focus, modalOpen, clickerEnabled }, this.bindings);
    if (!binding) {
      // Holding Space on a focused button must never re-trigger it.
      if (event.code === 'Space' && (focus === 'control' || focus === 'slider') && !modalOpen) {
        event.preventDefault();
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const handler = this.handlers[binding.action];
    if (handler) handler();
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    // Buttons and checkboxes activate on Space keyup — swallow it so TAKE does not click them.
    if (event.code !== 'Space') return;
    const focus = classifyFocus(event.target);
    if ((focus === 'control' || focus === 'slider') && !this.options.isModalOpen()) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  constructor(
    private readonly target: Window,
    private readonly handlers: HotkeyHandlers,
    private readonly options: HotkeyManagerOptions
  ) {
    this.bindings = options.bindings ?? DEFAULT_BINDINGS;
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.target.addEventListener('keydown', this.onKeyDown, { capture: true });
    this.target.addEventListener('keyup', this.onKeyUp, { capture: true });
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.target.removeEventListener('keydown', this.onKeyDown, { capture: true });
    this.target.removeEventListener('keyup', this.onKeyUp, { capture: true });
  }
}
