import qrcode from 'qrcode-generator';
import { Copy, Globe, Keyboard, Lock, RefreshCw, Smartphone, Volume2, Wifi, Workflow } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type { InternetState, RemoteLink, RemoteRole, StageTeamPermissions } from '../../types';
import { DEFAULT_BINDINGS } from '../../services/hotkeyManager';
import { useAudioStore } from '../../store/useAudioStore';
import { DEFAULT_REMOTE_PORT, usePrefsStore } from '../../store/usePrefsStore';
import { useShowStore } from '../../store/useShowStore';
import { useStageStore } from '../../store/useStageStore';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';

export function Switch({
  checked,
  onChange,
  label,
  testId,
  disabled = false
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  testId?: string;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:opacity-40 ${
        checked ? 'border-av-green bg-av-green/80' : 'border-av-border bg-av-raised'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`}
      />
    </button>
  );
}

function Section({
  icon,
  title,
  description,
  control,
  children
}: {
  icon: ReactNode;
  title: string;
  description: string;
  control?: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  return (
    <section className="rounded-lg border border-av-border bg-av-bg p-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-av-blue">{icon}</span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-av-text">{title}</h3>
          <p className="text-xs text-av-muted">{description}</p>
        </div>
        {control}
      </div>
      {children ? <div className="mt-3 pl-8">{children}</div> : null}
    </section>
  );
}

function QrCode({ text, testId }: { text: string; testId: string }): JSX.Element {
  const src = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createDataURL(5, 2);
  }, [text]);
  return <img src={src} alt="QR code for the crew remote" className="h-36 w-36 rounded-md bg-white p-1" data-testid={testId} />;
}

const PERMISSION_LABELS: Array<{ key: keyof StageTeamPermissions; label: string; hint: string }> = [
  { key: 'takeCues', label: 'GO / play cues', hint: 'Next cue and tap-to-play from the cue list' },
  { key: 'mediaControls', label: 'Video & music', hint: 'Play/pause video and music, fade audio' },
  { key: 'emergency', label: 'Freeze & blackout', hint: 'Freeze, blackout, back to backdrop' },
  { key: 'autoFollow', label: 'Auto-follow switch', hint: 'Turn automatic advancing on/off' }
];

const INSTALL_COMMAND = 'winget install --id Cloudflare.cloudflared';

function StateChip({ state }: { state: InternetState }): JSX.Element {
  const map: Record<InternetState, { text: string; cls: string }> = {
    off: { text: 'OFF', cls: 'bg-av-raised text-av-dim' },
    starting: { text: 'CONNECTING…', cls: 'bg-av-amber/20 text-av-amber' },
    reconnecting: { text: 'RECONNECTING…', cls: 'bg-av-amber/20 text-av-amber' },
    online: { text: 'ONLINE', cls: 'bg-av-green/20 text-av-green' },
    error: { text: 'PROBLEM', cls: 'bg-av-red/20 text-av-red' },
    'not-installed': { text: 'SETUP NEEDED', cls: 'bg-av-amber/20 text-av-amber' }
  };
  const item = map[state];
  return (
    <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${item.cls}`} data-testid="internet-state">
      {item.text}
    </span>
  );
}

/** How phones reach this laptop: over the internet (tunnel or relay) or on the same Wi-Fi only. */
function ConnectionPanel(): JSX.Element {
  const internet = usePrefsStore((s) => s.internet);
  const setInternet = usePrefsStore((s) => s.setInternet);
  const status = usePrefsStore((s) => s.remoteInfo?.internet ?? null);
  const remoteOn = usePrefsStore((s) => s.remoteInfo?.enabled ?? false);
  const [relayText, setRelayText] = useState(internet.relayUrl);
  const [hostKeyText, setHostKeyText] = useState(internet.relayHostKey);
  const online = internet.mode !== 'off';
  const state: InternetState = status && status.mode === internet.mode ? status.state : 'off';

  const retryTunnel = async (): Promise<void> => {
    await setInternet({ mode: 'off' });
    await setInternet({ mode: 'tunnel' });
  };

  return (
    <div className="rounded-lg border border-av-border bg-av-panel p-3" data-testid="connection-panel">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-av-text">
          <Globe size={13} /> Connection
        </span>
        {remoteOn && online ? <StateChip state={state} /> : null}
      </div>
      <div className="mb-3 grid grid-cols-2 gap-1 rounded-md border border-av-border bg-av-bg p-1">
        <button
          type="button"
          onClick={() => void setInternet({ mode: internet.mode === 'off' ? 'tunnel' : internet.mode })}
          className={`rounded px-2 py-1.5 text-xs font-semibold ${online ? 'bg-av-blue text-av-bg' : 'text-av-muted hover:bg-av-raised'}`}
          data-testid="mode-internet"
        >
          Internet: any network / mobile data
        </button>
        <button
          type="button"
          onClick={() => void setInternet({ mode: 'off' })}
          className={`rounded px-2 py-1.5 text-xs font-semibold ${!online ? 'bg-av-blue text-av-bg' : 'text-av-muted hover:bg-av-raised'}`}
          data-testid="mode-lan"
        >
          Same Wi-Fi only
        </button>
      </div>

      {online ? (
        <div className="space-y-2">
          <p className="text-xs text-av-muted">
            Phones and the laptop can be on <strong className="text-av-text">different Wi-Fi networks or mobile data</strong>. Both
            connect out to a secure WebSocket address on the internet; the crew links stay secret.
          </p>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <label
              className={`cursor-pointer rounded-md border p-2.5 ${internet.mode === 'tunnel' ? 'border-av-blue bg-av-blue/5' : 'border-av-border bg-av-bg'}`}
            >
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  name="internet-mode"
                  checked={internet.mode === 'tunnel'}
                  onChange={() => void setInternet({ mode: 'tunnel' })}
                  className="accent-sky-400"
                />
                <span className="text-xs font-semibold text-av-text">Cloudflare tunnel</span>
                <span className="rounded bg-av-green/15 px-1 text-[10px] text-av-green">no server needed</span>
              </div>
              <p className="mt-1 pl-5 text-[11px] text-av-dim">Free, no account. The address changes each time StageCue starts, so share the new QR code.</p>
            </label>
            <label
              className={`cursor-pointer rounded-md border p-2.5 ${internet.mode === 'relay' ? 'border-av-blue bg-av-blue/5' : 'border-av-border bg-av-bg'}`}
            >
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  name="internet-mode"
                  checked={internet.mode === 'relay'}
                  onChange={() => void setInternet({ mode: 'relay' })}
                  className="accent-sky-400"
                />
                <span className="text-xs font-semibold text-av-text">My relay server</span>
                <span className="rounded bg-av-blue/15 px-1 text-[10px] text-av-blue">permanent link</span>
              </div>
              <p className="mt-1 pl-5 text-[11px] text-av-dim">Deploy the included relay once (free tiers work). Printed QR codes keep working.</p>
            </label>
          </div>

          {internet.mode === 'tunnel' && state === 'not-installed' ? (
            <div className="rounded-md border border-av-amber/50 bg-av-amber/5 p-2.5 text-xs text-av-muted" data-testid="tunnel-install">
              <p className="font-semibold text-av-amber">One-time setup: install Cloudflare&apos;s free tunnel tool</p>
              <p className="mt-1">Open PowerShell or Command Prompt and run:</p>
              <div className="mt-1 flex items-center gap-1">
                <code className="rounded bg-av-bg px-1.5 py-1 font-mono text-[11px] text-av-text">{INSTALL_COMMAND}</code>
                <button
                  type="button"
                  className="rounded p-1 text-av-muted hover:bg-av-raised hover:text-av-text"
                  aria-label="Copy install command"
                  onClick={() => void navigator.clipboard.writeText(INSTALL_COMMAND)}
                >
                  <Copy size={12} />
                </button>
              </div>
              <p className="mt-1">
                Or download it from developers.cloudflare.com (search “cloudflared download”). Then press{' '}
                <strong className="text-av-text">Check again</strong>.
              </p>
              <Button size="xs" variant="warning" className="mt-2" onClick={() => void retryTunnel()}>
                Check again
              </Button>
            </div>
          ) : null}

          {internet.mode === 'relay' ? (
            <div className="space-y-1.5 rounded-md border border-av-border bg-av-bg p-2.5 text-xs">
              <label className="flex flex-col gap-1 text-av-muted">
                Relay server address
                <input
                  value={relayText}
                  onChange={(e) => setRelayText(e.target.value)}
                  onBlur={() => void setInternet({ relayUrl: relayText })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void setInternet({ relayUrl: relayText });
                  }}
                  placeholder="https://stagecue-relay.onrender.com"
                  className="h-8 rounded border border-av-border bg-av-panel px-2 font-mono text-[11px] text-av-text"
                  data-testid="relay-url"
                  aria-label="Relay server address"
                />
              </label>
              <label className="flex flex-col gap-1 text-av-muted">
                Host key (only if your relay sets RELAY_HOST_KEY)
                <input
                  value={hostKeyText}
                  type="password"
                  onChange={(e) => setHostKeyText(e.target.value)}
                  onBlur={() => void setInternet({ relayHostKey: hostKeyText })}
                  className="h-8 rounded border border-av-border bg-av-panel px-2 font-mono text-[11px] text-av-text"
                  aria-label="Relay host key"
                />
              </label>
              <p className="text-[11px] text-av-dim">
                Room <span className="font-mono text-av-text">{internet.roomId}</span>. Setup guide: <span className="font-mono">relay/README.md</span>{' '}
                in the StageCue project.
              </p>
            </div>
          ) : null}

          {remoteOn && status?.error && state !== 'not-installed' ? (
            <p className="text-xs text-av-red" data-testid="internet-error">
              {status.error}
            </p>
          ) : null}
          {remoteOn && state === 'online' && status?.publicBase ? (
            <p className="text-xs text-av-green">
              Online at <span className="font-mono">{new URL(status.publicBase).host}</span>. The QR codes below work from any network.
            </p>
          ) : null}
          {!remoteOn ? <p className="text-[11px] text-av-dim">Switch the crew remote on (top right) to connect.</p> : null}
        </div>
      ) : (
        <NetworkHelp links={usePrefsStore.getState().remoteInfo?.links ?? []} />
      )}
    </div>
  );
}

function RoleLinks({ role, links }: { role: RemoteRole; links: RemoteLink[] }): JSX.Element {
  const mine = links.filter((l) => l.role === role);
  const stage = role === 'stage';
  return (
    <div
      className={`rounded-lg border p-3 ${stage ? 'border-av-green/40 bg-av-green/5' : 'border-av-blue/40 bg-av-blue/5'}`}
      data-testid={`remote-links-${role}`}
    >
      <div className={`mb-2 text-xs font-bold uppercase tracking-wider ${stage ? 'text-av-green' : 'text-av-blue'}`}>
        {stage ? 'Stage team link' : 'AV operator phone (full control)'}
      </div>
      {mine.length === 0 ? (
        <p className="text-xs text-av-amber">No network found. Join the venue Wi-Fi or start a hotspot.</p>
      ) : (
        <div className="flex flex-wrap items-start gap-3">
          <QrCode text={mine[0].url} testId={`remote-qr-${role}`} />
          <ul className="min-w-0 flex-1 space-y-1.5 text-xs">
            {mine.map((link) => (
              <li key={link.url}>
                <div className="flex items-center gap-1 text-[11px] text-av-muted">
                  {link.scope === 'internet' ? (
                    <span className="rounded bg-av-blue/20 px-1 font-semibold text-av-blue">any network</span>
                  ) : (
                    <span className="rounded bg-av-raised px-1 font-semibold text-av-dim">same Wi-Fi</span>
                  )}
                  {link.interfaceName}
                  {link.hotspot ? (
                    <span className="rounded bg-av-green/20 px-1 font-semibold text-av-green">laptop hotspot</span>
                  ) : null}
                </div>
                <div className="flex items-center gap-1">
                  <code
                    className="min-w-0 break-all rounded bg-av-panel px-1.5 py-0.5 font-mono text-[10px] leading-snug text-av-text"
                    data-testid="remote-url"
                  >
                    {link.url}
                  </code>
                  <button
                    type="button"
                    className="rounded p-1 text-av-muted hover:bg-av-raised hover:text-av-text"
                    aria-label="Copy link"
                    onClick={() => void navigator.clipboard.writeText(link.url)}
                  >
                    <Copy size={12} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function NetworkHelp({ links }: { links: RemoteLink[] }): JSX.Element {
  const hasHotspot = links.some((l) => l.hotspot);
  const isWindows = window.api.platform === 'win32';
  return (
    <div className="text-xs text-av-muted" data-testid="network-help">
      <div className="mb-1 flex items-center gap-1.5 font-semibold text-av-text">
        <Wifi size={13} /> Local mode
      </div>
      <p>
        Phones join the same network as this laptop; no internet is used. Handy where there is no signal: a pocket travel
        router or this laptop&apos;s Mobile Hotspot works.
        {hasHotspot ? <span className="text-av-green"> Hotspot detected ✓</span> : null}
      </p>
      {isWindows ? (
        <Button
          size="xs"
          variant="secondary"
          className="mt-2"
          icon={<Wifi size={12} />}
          onClick={() => void window.api.invoke('app:open-hotspot-settings')}
        >
          Open Mobile Hotspot settings
        </Button>
      ) : null}
    </div>
  );
}

function RemoteSection(): JSX.Element {
  const remoteEnabled = usePrefsStore((s) => s.remoteEnabled);
  const remotePort = usePrefsStore((s) => s.remotePort);
  const remoteInfo = usePrefsStore((s) => s.remoteInfo);
  const remoteBusy = usePrefsStore((s) => s.remoteBusy);
  const configureRemote = usePrefsStore((s) => s.configureRemote);
  const regenerateLinks = usePrefsStore((s) => s.regenerateLinks);
  const stagePermissions = usePrefsStore((s) => s.stagePermissions);
  const setStagePermission = usePrefsStore((s) => s.setStagePermission);
  const stageLocked = usePrefsStore((s) => s.stageLocked);
  const setStageLocked = usePrefsStore((s) => s.setStageLocked);
  const [portText, setPortText] = useState(String(remotePort));
  const running = remoteInfo?.enabled === true;
  const links = running ? remoteInfo.links : [];

  const applyPort = (): void => {
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      setPortText(String(remotePort));
      return;
    }
    if (port !== remotePort) void configureRemote(remoteEnabled, port);
  };

  return (
    <Section
      icon={<Smartphone size={18} />}
      title="Crew remote — stage team & phones"
      description="Real-time control and messaging from phones and tablets (WebSocket). The stage team gets its own link with only the controls you allow."
      control={
        <Switch
          checked={remoteEnabled}
          disabled={remoteBusy}
          onChange={(value) => void configureRemote(value, remotePort)}
          label="Crew remote"
          testId="toggle-remote"
        />
      }
    >
      <div className="space-y-3">
        <div className="min-w-0 flex-1 space-y-2 text-xs">
          <label className="flex items-center gap-2 text-av-muted">
            Port
            <input
              value={portText}
              onChange={(e) => setPortText(e.target.value.replace(/[^0-9]/g, '').slice(0, 5))}
              onBlur={applyPort}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyPort();
              }}
              className="h-7 w-20 rounded border border-av-border bg-av-panel px-2 font-mono text-av-text"
              aria-label="Remote port"
            />
            <span className="text-av-dim">default {DEFAULT_REMOTE_PORT}</span>
          </label>
          {remoteInfo?.error ? <p className="text-av-red">{remoteInfo.error}</p> : null}
          {running ? (
            <p className="text-av-green" data-testid="remote-status">
              Running · {remoteInfo.clients.length} device{remoteInfo.clients.length === 1 ? '' : 's'} connected
            </p>
          ) : remoteEnabled ? (
            <p className="text-av-muted">Starting…</p>
          ) : (
            <p className="text-av-dim">Off. Nothing is reachable from the network.</p>
          )}
        </div>

        <ConnectionPanel />

        {running ? (
          <>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <RoleLinks role="stage" links={links} />
              <RoleLinks role="operator" links={links} />
            </div>

            <div className="rounded-lg border border-av-border bg-av-panel p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-av-green">Stage team can…</span>
                <label className="flex items-center gap-2 text-xs text-av-amber">
                  <Lock size={12} /> Lock all
                  <Switch checked={stageLocked} onChange={(v) => void setStageLocked(v)} label="Lock stage team" testId="settings-lock" />
                </label>
              </div>
              <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {PERMISSION_LABELS.map((p) => (
                  <li key={p.key} className="flex items-center justify-between gap-2 rounded border border-av-border bg-av-bg px-2 py-1.5">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-av-text">{p.label}</div>
                      <div className="truncate text-[11px] text-av-dim">{p.hint}</div>
                    </div>
                    <Switch
                      checked={stagePermissions[p.key]}
                      onChange={(v) => void setStagePermission(p.key, v)}
                      label={p.label}
                      testId={`perm-${p.key}`}
                    />
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-av-dim">Changes reach connected phones instantly. The AV operator link always has full control.</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="xs"
                variant="ghost"
                icon={<RefreshCw size={12} />}
                onClick={() => {
                  if (window.confirm('Create new links? Old QR codes stop working and connected phones are disconnected.')) {
                    void regenerateLinks();
                  }
                }}
              >
                New links (revoke old QR codes)
              </Button>
              <span className="text-[11px] text-av-dim">
                Secret link codes stay the same across restarts. With the relay, the whole link stays the same, so printed QR codes
                keep working. If Windows asks about the firewall, allow StageCue AV on <strong>private</strong> networks.
              </span>
            </div>
          </>
        ) : null}
      </div>
    </Section>
  );
}

function AudioOutputSection(): JSX.Element {
  const devices = useAudioStore((s) => s.outputDevices);
  const supported = useAudioStore((s) => s.outputSupported);
  const pref = useAudioStore((s) => s.outputPref);
  const missing = useAudioStore((s) => s.outputMissing);
  const setOutputDevice = useAudioStore((s) => s.setOutputDevice);
  const resolved = useAudioStore((s) => s.resolvedOutputDeviceId());

  return (
    <Section
      icon={<Volume2 size={18} />}
      title="Audio output"
      description="Where music and video sound go: the projector over HDMI, the laptop headphone jack, or a USB interface to the venue mixer."
    >
      <AudioOutputSelect
        devices={devices}
        value={resolved}
        onChange={setOutputDevice}
        disabled={!supported}
      />
      {missing && pref ? (
        <p className="mt-1.5 text-xs text-av-red">“{pref.label}” is not connected. Playing on the system default output.</p>
      ) : null}
      {!supported ? <p className="mt-1.5 text-xs text-av-amber">This system cannot choose an output; the Windows default is used.</p> : null}
    </Section>
  );
}

export function AudioOutputSelect({
  devices,
  value,
  onChange,
  disabled = false,
  compact = false
}: {
  devices: ReadonlyArray<{ deviceId: string; label: string }>;
  value: string;
  onChange: (deviceId: string) => void;
  disabled?: boolean;
  compact?: boolean;
}): JSX.Element {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Audio output device"
      data-testid="audio-output-select"
      className={`w-full rounded-md border border-av-border bg-av-panel px-2 text-av-text ${compact ? 'h-7 text-xs' : 'h-9 text-sm'}`}
    >
      <option value="">System default output</option>
      {devices.map((d) => (
        <option key={d.deviceId} value={d.deviceId}>
          {d.label}
        </option>
      ))}
    </select>
  );
}

export function SettingsModal(): JSX.Element | null {
  const panel = useShowStore((s) => s.panel);
  const setPanel = useShowStore((s) => s.setPanel);
  const autoFollowEnabled = useStageStore((s) => s.autoFollowEnabled);
  const setAutoFollow = useStageStore((s) => s.setAutoFollow);
  const clickerEnabled = usePrefsStore((s) => s.clickerEnabled);
  const setClickerEnabled = usePrefsStore((s) => s.setClickerEnabled);
  const clickerTurnsPages = usePrefsStore((s) => s.clickerTurnsPages);
  const setClickerTurnsPages = usePrefsStore((s) => s.setClickerTurnsPages);

  if (panel !== 'settings') return null;
  const clickerKeys = DEFAULT_BINDINGS.filter((b) => b.clicker);

  return (
    <Modal
      open
      title="Settings"
      onClose={() => setPanel('none')}
      width="md"
      testId="settings-modal"
      footer={
        <Button size="sm" variant="primary" active onClick={() => setPanel('none')}>
          Done
        </Button>
      }
    >
      <div className="space-y-3">
        <Section
          icon={<Workflow size={18} />}
          title="Auto-follow"
          description="Lets cues set to “when video ends” or “after N seconds” advance on their own. Switch OFF to run everything manually. Saved with the show."
          control={<Switch checked={autoFollowEnabled} onChange={(v) => setAutoFollow(v)} label="Auto-follow" testId="settings-auto-follow" />}
        />
        <Section
          icon={<Keyboard size={18} />}
          title="Presentation clicker"
          description="Use a wireless slide clicker to run the show. Applies to this laptop."
          control={<Switch checked={clickerEnabled} onChange={setClickerEnabled} label="Presentation clicker" testId="toggle-clicker" />}
        >
          <ul className="grid grid-cols-1 gap-1 text-xs text-av-muted sm:grid-cols-3">
            {clickerKeys.map((b) => (
              <li key={b.label} className="rounded border border-av-border bg-av-panel px-2 py-1">
                <span className="font-mono text-av-text">{b.label}</span> · {b.description.replace('Clicker: ', '')}
              </li>
            ))}
          </ul>
          <label className="mt-2 flex items-center justify-between gap-3 rounded border border-av-border bg-av-panel px-2.5 py-2">
            <span className="text-xs text-av-muted">
              <span className="font-semibold text-av-text">Clicker turns pages</span>: while a PDF booklet, slide deck or web
              flipbook is live, forward/back turn its pages; after the last page the clicker moves on to the next cue.
            </span>
            <Switch
              checked={clickerTurnsPages}
              onChange={setClickerTurnsPages}
              label="Clicker turns pages"
              testId="toggle-clicker-pages"
            />
          </label>
        </Section>
        <RemoteSection />
        <AudioOutputSection />
      </div>
    </Modal>
  );
}
