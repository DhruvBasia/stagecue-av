import { Lock, LockOpen, Send, Smartphone, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CrewMessage } from '../../types';
import { QUICK_REPLIES, useCrewStore } from '../../store/useCrewStore';
import { usePrefsStore } from '../../store/usePrefsStore';
import { useShowStore } from '../../store/useShowStore';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';
import { Switch } from './SettingsModal';

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

function MessageRow({ message, now }: { message: CrewMessage; now: number }): JSX.Element {
  const fromAv = message.role === 'av-room';
  const urgent = message.kind === 'problem' || message.kind === 'hold';
  return (
    <li
      data-testid="crew-message"
      className={`rounded-md border px-3 py-2 ${
        fromAv ? 'border-av-blue/40 bg-av-blue/5' : urgent ? 'border-av-red/60 bg-av-red/10' : 'border-av-border bg-av-bg'
      }`}
    >
      <div className="flex justify-between gap-2 text-[11px] text-av-muted">
        <span>
          {fromAv ? 'AV Room' : `${message.role === 'stage' ? 'Stage' : 'AV phone'} · ${message.from}`}
          {message.to ? ' → one device' : ''}
        </span>
        <span>{ago(message.at, now)}</span>
      </div>
      <div className={`text-sm font-semibold ${urgent ? 'text-av-red' : 'text-av-text'}`}>{message.text}</div>
    </li>
  );
}

export function CrewPanel(): JSX.Element | null {
  const panel = useShowStore((s) => s.panel);
  const setPanel = useShowStore((s) => s.setPanel);
  const info = usePrefsStore((s) => s.remoteInfo);
  const stageLocked = usePrefsStore((s) => s.stageLocked);
  const setStageLocked = usePrefsStore((s) => s.setStageLocked);
  const messages = useCrewStore((s) => s.messages);
  const markRead = useCrewStore((s) => s.markRead);
  const send = useCrewStore((s) => s.send);
  const [text, setText] = useState('');
  const [to, setTo] = useState<string>('');
  const [now, setNow] = useState(Date.now());
  const listRef = useRef<HTMLUListElement>(null);
  const open = panel === 'crew';

  useEffect(() => {
    if (!open) return undefined;
    markRead();
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open, markRead, messages.length]);

  useEffect(() => {
    if (open) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [open, messages.length]);

  if (!open) return null;
  const clients = info?.clients ?? [];
  const running = info?.enabled === true;
  const submit = (): void => {
    send(text, to || null, 'reply');
    setText('');
  };

  return (
    <Modal open title="Crew — stage team & phones" onClose={() => setPanel('none')} width="lg" testId="crew-panel">
      {!running ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-av-amber/50 bg-av-amber/10 p-3 text-sm text-av-amber">
          <span>The crew remote is off. Switch it on in Settings and share the QR code with the stage team.</span>
          <Button size="sm" variant="warning" onClick={() => setPanel('settings')}>
            Open Settings
          </Button>
        </div>
      ) : null}
      <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 rounded-lg border border-av-border bg-av-bg p-3">
            <div className="flex items-center gap-2">
              {stageLocked ? <Lock size={16} className="text-av-amber" /> : <LockOpen size={16} className="text-av-muted" />}
              <div>
                <div className="text-sm font-semibold text-av-text">Lock stage team controls</div>
                <div className="text-xs text-av-muted">Instantly blocks GO / play from stage phones. Messages still work.</div>
              </div>
            </div>
            <Switch checked={stageLocked} onChange={(v) => void setStageLocked(v)} label="Lock stage team" testId="crew-lock" />
          </div>
          <div>
            <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-av-muted">
              <Users size={13} /> Connected ({clients.length})
            </h3>
            {clients.length === 0 ? (
              <p className="rounded-md border border-dashed border-av-border p-3 text-xs text-av-dim">No phones connected yet.</p>
            ) : (
              <ul className="space-y-1.5" data-testid="crew-clients">
                {clients.map((c) => (
                  <li key={c.id} className="flex items-center gap-2 rounded-md border border-av-border bg-av-bg px-2.5 py-1.5">
                    <Smartphone size={14} className={c.role === 'stage' ? 'text-av-green' : 'text-av-blue'} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-av-text">{c.name}</div>
                      <div className="text-[11px] text-av-muted">
                        {c.role === 'stage' ? 'Stage team' : 'AV operator'} · {c.via === 'internet' ? 'internet' : 'same Wi-Fi'} ·{' '}
                        {c.address.replace(' (internet)', '')}
                      </div>
                    </div>
                    <span
                      className={`font-mono text-[11px] ${
                        c.latencyMs === null ? 'text-av-dim' : c.latencyMs < 100 ? 'text-av-green' : c.latencyMs < 300 ? 'text-av-amber' : 'text-av-red'
                      }`}
                    >
                      {c.latencyMs === null ? '—' : `${c.latencyMs} ms`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="flex min-h-[340px] flex-col rounded-lg border border-av-border bg-av-panel">
          <ul ref={listRef} className="flex-1 space-y-1.5 overflow-y-auto p-2" style={{ maxHeight: '42vh' }}>
            {messages.length === 0 ? (
              <li className="p-4 text-center text-xs text-av-dim">Messages from the stage team appear here.</li>
            ) : (
              messages.map((m) => <MessageRow key={m.id} message={m} now={now} />)
            )}
          </ul>
          <div className="space-y-2 border-t border-av-border p-2">
            <div className="flex flex-wrap gap-1">
              {QUICK_REPLIES.map((q) => (
                <Button key={q.text} size="xs" variant="secondary" disabled={!running} onClick={() => send(q.text, to || null, q.kind)}>
                  {q.text}
                </Button>
              ))}
            </div>
            <form
              className="flex gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <select
                value={to}
                onChange={(e) => setTo(e.target.value)}
                aria-label="Send to"
                className="h-9 max-w-[150px] rounded-md border border-av-border bg-av-bg px-1.5 text-xs text-av-text"
              >
                <option value="">Everyone</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={200}
                placeholder="Message to the crew…"
                aria-label="Message to the crew"
                data-testid="crew-input"
                className="h-9 min-w-0 flex-1 rounded-md border border-av-border bg-av-bg px-2.5 text-sm text-av-text focus:border-av-blue focus:outline-none"
              />
              <Button type="submit" size="md" variant="primary" icon={<Send size={14} />} disabled={!running || !text.trim()}>
                Send
              </Button>
            </form>
          </div>
        </div>
      </div>
    </Modal>
  );
}
