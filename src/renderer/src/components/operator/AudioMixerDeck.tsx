import { Music, Pause, Play, Repeat, Speaker, Square, Volume2, VolumeX } from 'lucide-react';
import { AudioOutputSelect } from './SettingsModal';
import { formatDb, formatPercent, formatTime } from '../../services/utils';
import { useAudioStore } from '../../store/useAudioStore';
import { Button } from '../common/Button';
import { Slider } from '../common/Slider';

function NowPlaying(): JSX.Element {
  const media = useAudioStore((s) => s.bgMusicMedia);
  const telemetry = useAudioStore((s) => s.telemetry);
  const isPlaying = useAudioStore((s) => s.isBgMusicPlaying);
  const loop = useAudioStore((s) => s.musicLoop);
  const playMusic = useAudioStore((s) => s.playMusic);
  const pauseMusic = useAudioStore((s) => s.pauseMusic);
  const stopMusic = useAudioStore((s) => s.stopMusic);
  const seekMusic = useAudioStore((s) => s.seekMusic);
  const setMusicLoop = useAudioStore((s) => s.setMusicLoop);

  const time = telemetry && media && telemetry.bgMusicMediaId === media.id ? telemetry.musicCurrentTime : 0;
  const duration =
    telemetry && media && telemetry.bgMusicMediaId === media.id && telemetry.musicDuration > 0
      ? telemetry.musicDuration
      : media?.duration ?? 0;
  const progress = duration > 0 ? Math.min(100, (time / duration) * 100) : 0;

  return (
    <div className="rounded-md border border-av-border bg-av-bg p-2">
      <div className="flex items-center gap-2">
        <div
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${
            isPlaying ? 'bg-av-green/15 text-av-green' : 'bg-av-raised text-av-muted'
          }`}
        >
          <Music size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-av-text" title={media?.name}>
            {media ? media.name : 'No background track'}
          </div>
          <div className="font-mono text-[10px] tabular-nums text-av-muted">
            {media ? `${formatTime(time)} / ${formatTime(duration)}` : 'Assign a track to a cue or press ⚡ in the library'}
          </div>
        </div>
      </div>
      <div
        className="mt-2 h-1.5 cursor-pointer overflow-hidden rounded-full bg-av-raised"
        role="slider"
        aria-label="Music position"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(time)}
        tabIndex={-1}
        onClick={(event) => {
          if (!media || duration <= 0) return;
          const rect = event.currentTarget.getBoundingClientRect();
          seekMusic(((event.clientX - rect.left) / rect.width) * duration);
        }}
      >
        <div className="h-full bg-av-green transition-[width] duration-100" style={{ width: `${progress}%` }} />
      </div>
      <div className="mt-2 flex items-center gap-1">
        <Button
          size="sm"
          variant={isPlaying ? 'success' : 'secondary'}
          disabled={!media}
          icon={isPlaying ? <Pause size={13} /> : <Play size={13} />}
          onClick={() => (isPlaying ? pauseMusic() : playMusic())}
        >
          {isPlaying ? 'Pause' : 'Play'}
        </Button>
        <Button size="sm" variant="secondary" disabled={!media} icon={<Square size={12} />} onClick={stopMusic}>
          Stop
        </Button>
        <Button
          size="sm"
          variant="ghost"
          active={loop}
          disabled={!media}
          icon={<Repeat size={13} />}
          onClick={() => setMusicLoop(!loop)}
          title="Loop the background track"
        >
          Loop
        </Button>
      </div>
    </div>
  );
}

function OutputPicker(): JSX.Element {
  const devices = useAudioStore((s) => s.outputDevices);
  const supported = useAudioStore((s) => s.outputSupported);
  const missing = useAudioStore((s) => s.outputMissing);
  const pref = useAudioStore((s) => s.outputPref);
  const setOutputDevice = useAudioStore((s) => s.setOutputDevice);
  const resolved = useAudioStore((s) => s.resolvedOutputDeviceId());
  return (
    <div className="mb-2">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-av-muted">
        <Speaker size={11} /> Output
        {missing && pref ? <span className="normal-case tracking-normal text-av-red">· “{pref.label}” missing</span> : null}
      </div>
      <AudioOutputSelect devices={devices} value={resolved} onChange={setOutputDevice} disabled={!supported} compact />
    </div>
  );
}

export function AudioMixerDeck(): JSX.Element {
  const bgMusicVolume = useAudioStore((s) => s.bgMusicVolume);
  const videoAudioVolume = useAudioStore((s) => s.videoAudioVolume);
  const masterVolume = useAudioStore((s) => s.masterVolume);
  const isMuted = useAudioStore((s) => s.isMuted);
  const isDucked = useAudioStore((s) => s.isDucked);
  const autoDuckEnabled = useAudioStore((s) => s.autoDuckEnabled);
  const duckAttenuationPercent = useAudioStore((s) => s.duckAttenuationPercent);
  const levels = useAudioStore((s) => s.telemetry?.levels ?? null);
  const contextState = useAudioStore((s) => s.telemetry?.contextState ?? 'uninitialized');
  const setBgMusicVolume = useAudioStore((s) => s.setBgMusicVolume);
  const setVideoAudioVolume = useAudioStore((s) => s.setVideoAudioVolume);
  const setMasterVolume = useAudioStore((s) => s.setMasterVolume);
  const toggleMute = useAudioStore((s) => s.toggleMute);
  const setAutoDuck = useAudioStore((s) => s.setAutoDuck);
  const setDuckAttenuation = useAudioStore((s) => s.setDuckAttenuation);

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-av-border bg-av-panel p-2" data-testid="audio-mixer">
      <header className="mb-2 flex items-center justify-between px-0.5">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-av-text">Audio Mixer</h3>
        <span
          className={`font-mono text-[10px] ${contextState === 'running' ? 'text-av-muted' : 'text-av-amber'}`}
          title="Web Audio engine state in the stage window"
        >
          engine {contextState}
        </span>
      </header>

      <OutputPicker />
      <NowPlaying />

      <div className="mt-2 flex min-h-[170px] flex-1 justify-around rounded-md border border-av-border bg-av-bg px-1 py-2">
        <Slider
          orientation="vertical"
          label="Music"
          value={bgMusicVolume}
          onChange={setBgMusicVolume}
          accent="green"
          defaultValue={0.8}
          meter={levels?.music ?? 0}
          format={formatPercent}
          testId="fader-music"
        />
        <Slider
          orientation="vertical"
          label="Video"
          value={videoAudioVolume}
          onChange={setVideoAudioVolume}
          accent="blue"
          defaultValue={1}
          meter={levels?.video ?? 0}
          format={formatPercent}
          testId="fader-video"
        />
        <Slider
          orientation="vertical"
          label="Master"
          value={masterVolume}
          onChange={setMasterVolume}
          accent={isMuted ? 'red' : 'amber'}
          defaultValue={1}
          meter={isMuted ? 0 : levels?.master ?? 0}
          format={formatDb}
          testId="fader-master"
        />
      </div>

      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <Button
          size="sm"
          variant={isMuted ? 'danger' : 'secondary'}
          active={isMuted}
          icon={isMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          onClick={toggleMute}
          data-testid="master-mute"
        >
          {isMuted ? 'MUTED' : 'Mute master'}
        </Button>
        <Button
          size="sm"
          variant="primary"
          active={autoDuckEnabled}
          onClick={() => setAutoDuck(!autoDuckEnabled)}
          title="Lower the music automatically while a video with sound is playing"
        >
          Auto-duck {autoDuckEnabled ? 'ON' : 'OFF'}
        </Button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${
            isDucked ? 'bg-av-amber text-av-bg' : 'bg-av-raised text-av-dim'
          }`}
          data-testid="duck-indicator"
        >
          DUCKED
        </span>
        <Slider
          className="flex-1"
          label="Duck by"
          value={duckAttenuationPercent}
          min={0}
          max={100}
          step={1}
          disabled={!autoDuckEnabled}
          accent="amber"
          defaultValue={80}
          onChange={setDuckAttenuation}
          format={(v) => `${Math.round(v)}%`}
        />
      </div>
    </section>
  );
}
