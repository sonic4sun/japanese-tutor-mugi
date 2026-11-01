// 本機語音辨識的瀏覽器端：外表跟瀏覽器的 SpeechRecognition 一樣（useSpeechInput 照舊用），裡面改成自己收音、自己判斷
// 你講完了沒，再把這一句送到電腦上的 /api/stt（SenseVoice，自動判斷中文或日文，server/stt.ts）。
//
// The local recognizer: a SpeechRecognitionLike (see useSpeechInput) that records the microphone, finds the end of the
// utterance with a simple level detector, and sends the 16 kHz PCM to /api/stt. One utterance per session (continuous off):
//   start → onstart (at once), onaudiostart (the microphone is open) → onsoundstart / onspeechstart (speech heard) →
//   an interim empty result (so the caller's silence watchdog knows speech is going on) → silence after speech or stop() →
//   the final result → onend. abort() ends it at once with no result. Errors: not-allowed, audio-capture, network.
import { apiFetch } from '../game/apiFetch';
import type { SpeechErrorEvent, SpeechRecognitionLike, SpeechResultEvent } from './useSpeechInput';

/** level detector settings (ms, and the level floor in RMS of -1..1 samples) */
export const LOCAL_VAD = { endSilenceMs: 900, minSpeechMs: 200, preRollMs: 400, maxMs: 30000, floor: 0.012, factor: 3 } as const;
export const STT_RATE = 16000;

/** the samples at 16 kHz (linear interpolation; the recognizer needs no better) */
export function resampleTo16k(input: Float32Array, rate: number): Float32Array {
  if (rate === STT_RATE) return input;
  const ratio = rate / STT_RATE;
  const n = Math.floor(input.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const j = Math.floor(x);
    const f = x - j;
    out[i] = input[j] * (1 - f) + (input[j + 1] ?? input[j]) * f;
  }
  return out;
}

/** float samples → base64 of 16-bit little-endian PCM */
export function floatToPcmBase64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * The level detector: frame by frame, the noise floor follows the quiet frames; a frame louder than floor × factor is
 * speech. Speech starts after minSpeechMs of it, and the utterance ends after endSilenceMs of quiet once it started.
 */
export class LevelDetector {
  noise = LOCAL_VAD.floor / LOCAL_VAD.factor;
  speech = false;
  private loudMs = 0;
  private quietMs = 0;
  /** one frame: 'speech-start' when speech begins, 'end' when the utterance is over, else null */
  frame(rms: number, ms: number): 'speech-start' | 'end' | null {
    const threshold = Math.max(LOCAL_VAD.floor, this.noise * LOCAL_VAD.factor);
    if (rms > threshold) {
      this.loudMs += ms;
      this.quietMs = 0;
      if (!this.speech && this.loudMs >= LOCAL_VAD.minSpeechMs) {
        this.speech = true;
        return 'speech-start';
      }
      return null;
    }
    if (!this.speech) {
      this.loudMs = 0;
      this.noise = this.noise * 0.95 + rms * 0.05;
      return null;
    }
    this.quietMs += ms;
    return this.quietMs >= LOCAL_VAD.endSilenceMs ? 'end' : null;
  }
}

// one AudioContext for the page (a new one per utterance could start suspended), and the microphone kept open for a few
// seconds after a session, so the next one (voice chat restarts at once) does not miss its first syllables
let sharedCtx: AudioContext | null = null;
let sharedStream: MediaStream | null = null;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;
const KEEP_MIC_MS = 4000;

async function openMic(): Promise<MediaStream> {
  clearTimeout(releaseTimer);
  if (sharedStream && sharedStream.getAudioTracks().some((t) => t.readyState === 'live')) return sharedStream;
  sharedStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  return sharedStream;
}
function releaseMicSoon() {
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    sharedStream?.getTracks().forEach((t) => t.stop());
    sharedStream = null;
  }, KEEP_MIC_MS);
}

type State = 'idle' | 'starting' | 'listening' | 'decoding' | 'done';

export class LocalSpeechRecognition implements SpeechRecognitionLike {
  lang = 'zh-TW';
  interimResults = false;
  continuous = false;
  maxAlternatives = 1;
  onstart: (() => void) | null = null;
  onaudiostart: (() => void) | null = null;
  onsoundstart: (() => void) | null = null;
  onspeechstart: (() => void) | null = null;
  onresult: ((e: SpeechResultEvent) => void) | null = null;
  onerror: ((e: SpeechErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;

  private state: State = 'idle';
  private chunks: Float32Array[] = [];
  private rate = 48000;
  private totalMs = 0;
  private vad = new LevelDetector();
  private source: MediaStreamAudioSourceNode | null = null;
  private node: ScriptProcessorNode | null = null;

  start(): void {
    if (this.state !== 'idle') throw new Error('InvalidStateError: already started');
    this.state = 'starting';
    queueMicrotask(() => { if (this.state !== 'done') this.onstart?.(); });
    void this.open();
  }

  /** stop listening: what was said so far is still recognised */
  stop(): void {
    if (this.state === 'listening') this.finishCapture();
    else if (this.state === 'starting') this.end();
  }

  /** stop at once, no result */
  abort(): void {
    this.end();
  }

  private async open() {
    let stream: MediaStream;
    try {
      stream = await openMic();
      if (!sharedCtx || sharedCtx.state === 'closed') sharedCtx = new AudioContext();
      if (sharedCtx.state === 'suspended') await sharedCtx.resume();
    } catch (e) {
      const name = (e as { name?: string })?.name;
      this.fail(name === 'NotAllowedError' || name === 'SecurityError' ? 'not-allowed' : 'audio-capture');
      return;
    }
    if (this.state !== 'starting') { releaseMicSoon(); return; }
    const ctx = sharedCtx;
    this.rate = ctx.sampleRate;
    this.source = ctx.createMediaStreamSource(stream);
    // ScriptProcessor: old but in every Chromium, and needs no separate worklet file
    this.node = ctx.createScriptProcessor(2048, 1, 1);
    this.node.onaudioprocess = (ev) => this.onAudio(ev.inputBuffer.getChannelData(0));
    this.source.connect(this.node);
    this.node.connect(ctx.destination); // its output is silence; the connection keeps it running
    this.state = 'listening';
    this.onaudiostart?.();
  }

  private onAudio(buf: Float32Array) {
    if (this.state !== 'listening') return;
    const ms = (buf.length / this.rate) * 1000;
    this.totalMs += ms;
    this.chunks.push(new Float32Array(buf));
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const ev = this.vad.frame(Math.sqrt(sum / buf.length), ms);
    if (!this.vad.speech) {
      // before speech, keep only the last preRollMs (the start of the first syllable)
      const keep = Math.ceil(LOCAL_VAD.preRollMs / ms);
      if (this.chunks.length > keep) this.chunks.splice(0, this.chunks.length - keep);
    }
    if (ev === 'speech-start') {
      this.onsoundstart?.();
      this.onspeechstart?.();
      // an empty interim result: the caller's silence watchdog then knows someone is speaking
      this.onresult?.(resultEvent('', false));
    } else if (ev === 'end' || this.totalMs >= LOCAL_VAD.maxMs) {
      this.finishCapture();
    }
  }

  private detach() {
    if (this.node) { this.node.onaudioprocess = null; try { this.node.disconnect(); } catch { /* gone */ } }
    if (this.source) { try { this.source.disconnect(); } catch { /* gone */ } }
    this.node = null;
    this.source = null;
  }

  private finishCapture() {
    this.detach();
    releaseMicSoon();
    if (!this.vad.speech) { this.end(); return; }
    this.state = 'decoding';
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const all = new Float32Array(total);
    let at = 0;
    for (const c of this.chunks) { all.set(c, at); at += c.length; }
    this.chunks = [];
    const pcm = floatToPcmBase64(resampleTo16k(all, this.rate));
    void apiFetch('/api/stt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pcm, lang: this.lang }),
    }).then(async (r) => {
      if (this.state !== 'decoding') return;
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; text?: unknown };
      if (!r.ok || j.ok !== true) { this.fail('network'); return; }
      const text = typeof j.text === 'string' ? j.text.trim() : '';
      if (text) this.onresult?.(resultEvent(text, true));
      this.end();
    }).catch(() => { if (this.state === 'decoding') this.fail('network'); });
  }

  private fail(code: string) {
    if (this.state === 'done') return;
    this.onerror?.({ error: code });
    this.end();
  }

  private end() {
    if (this.state === 'done') return;
    const wasOpen = this.node !== null;
    this.state = 'done';
    this.detach();
    if (wasOpen) releaseMicSoon();
    this.chunks = [];
    queueMicrotask(() => this.onend?.());
  }
}

function resultEvent(transcript: string, isFinal: boolean): SpeechResultEvent {
  const alt = { transcript, confidence: isFinal ? 1 : 0 };
  const result = { isFinal, length: 1, 0: alt };
  return { results: { length: 1, 0: result } };
}

/** asks the PC whether local recognition is installed (false on any failure) */
export async function localSttAvailable(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false;
    const r = await apiFetch('/api/stt/status');
    if (!r.ok) return false;
    const j = (await r.json()) as { ok?: unknown };
    return j.ok === true;
  } catch {
    return false;
  }
}
