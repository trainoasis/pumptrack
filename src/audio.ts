// Minimal in-browser audio. Pedalling synthesized (no assets), "yay" is a
// recorded clip decoded into an AudioBuffer and fired on takeoff.

let ac: AudioContext | null = null;
let master: GainNode;

let pedalSrc: AudioBufferSourceNode;
let pedalGain: GainNode;

const yayBuffers: AudioBuffer[] = [];
const YAY_FILES = ['/yay.m4a', '/yay2.m4a', '/yay3.m4a'];

function pedalLoop(): AudioBuffer {
  const sr = ac!.sampleRate;
  const dur = 1.0;
  const buf = ac!.createBuffer(1, sr * dur, sr);
  const d = buf.getChannelData(0);
  const clickRate = 6;
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    const phase = (t * clickRate) % 1;
    const env = Math.max(0, 1 - phase * 30);
    d[i] = (Math.random() * 2 - 1) * env * 0.4;
  }
  return buf;
}

async function loadYays(): Promise<void> {
  await Promise.all(YAY_FILES.map(async (path) => {
    try {
      const res = await fetch(path);
      const arr = await res.arrayBuffer();
      const buf = await ac!.decodeAudioData(arr);
      yayBuffers.push(buf);
    } catch {
      // Skip this one — others will still work.
    }
  }));
}

export function initAudio(): void {
  if (ac) {
    if (ac.state === 'suspended') void ac.resume();
    return;
  }
  ac = new AudioContext();
  master = ac.createGain();
  master.gain.value = 0.6;
  master.connect(ac.destination);

  // Pedalling: synthesized click-ticks, louder + faster with ground speed.
  pedalSrc = ac.createBufferSource();
  pedalSrc.buffer = pedalLoop();
  pedalSrc.loop = true;
  pedalGain = ac.createGain();
  pedalGain.gain.value = 0;
  pedalSrc.connect(pedalGain);
  pedalGain.connect(master);
  pedalSrc.start();

  void loadYays();
}

export function updateAudio(grounded: boolean, speed: number): void {
  if (!ac) return;
  const t = ac.currentTime;
  // Pedalling only; yay is fired per-takeoff from main.ts.
  const pedalTarget = grounded ? Math.min(0.25, speed / 1200) : 0;
  pedalGain.gain.setTargetAtTime(pedalTarget, t, 0.04);
  const rate = 0.4 + Math.min(2.5, speed / 300);
  pedalSrc.playbackRate.setTargetAtTime(rate, t, 0.05);
}

// Fire once per real jump. If a previous yay is still playing, skip — no
// layering, no cut-off. Picks one of the loaded clips at random.
let yayPlaying = false;
export function playYay(): void {
  if (!ac || yayBuffers.length === 0 || yayPlaying) return;
  const buf = yayBuffers[Math.floor(Math.random() * yayBuffers.length)];
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.connect(master);
  src.onended = () => { yayPlaying = false; };
  src.start();
  yayPlaying = true;
}
