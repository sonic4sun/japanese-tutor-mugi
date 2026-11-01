// 本機語音辨識（SenseVoice，用 sherpa-onnx 在這台電腦的 CPU 上跑）：每一句自動判斷是中文還是日文，所以跟讀日文時
// 不會再被硬聽成中文。模型放在專案的 stt_model/（scripts/get-stt-model.ps1 下載），沒有模型時 /api/stt/status 回 ok:false，
// 網頁就照舊用瀏覽器內建的辨識。中文結果轉成台灣繁體（SenseVoice 輸出簡體）。聲音只在這台電腦處理，不會送到任何外部服務。
//
// Local speech recognition: SenseVoice (sherpa-onnx, CPU) with automatic language detection per utterance.
//   GET  /api/stt/status → { ok }   whether the model is here (the page then uses it instead of the browser's recognizer)
//   POST /api/stt        body { pcm: base64 of 16 kHz mono Int16LE, lang?: 'ja-JP' | 'zh-TW' } → { ok, text, lang }
// The detected language is kept to Chinese or Japanese (and English): Cantonese is read again as Mandarin, Korean as Japanese.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { Converter } from 'opencc-js';
import { guardApi, guardOptionsFrom } from './apiGuard.ts';

export const STT_DIR_NAME = 'stt_model';
/** the 2024-07-17 model: the 2025-09-09 one is a Cantonese fine-tune (WSYue) that garbles Japanese */
export const STT_MODEL_NAME = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';
export const STT_SAMPLE_RATE = 16000;
/** the longest utterance accepted, in seconds */
export const STT_MAX_SECONDS = 30;
const MAX_BODY_BYTES = Math.ceil((STT_SAMPLE_RATE * 2 * STT_MAX_SECONDS * 4) / 3) + 4096;

export type SttLang = 'zh' | 'ja' | 'en' | 'ko' | 'yue' | '';
type RawResult = { text?: string; lang?: string };
type Recognizer = { decode(samples: Float32Array): RawResult };

/** the model folder of a project root */
export function sttModelDir(root: string): string {
  return path.join(root, STT_DIR_NAME, STT_MODEL_NAME);
}

/** the model files are there */
export function sttModelPresent(root: string): boolean {
  const dir = sttModelDir(root);
  return fs.existsSync(path.join(dir, 'model.int8.onnx')) && fs.existsSync(path.join(dir, 'tokens.txt'));
}

/** '<|ja|>' → 'ja' */
export function langTag(raw: string | undefined): SttLang {
  const m = /^<\|(\w+)\|>$/.exec((raw ?? '').trim());
  const v = (m ? m[1] : (raw ?? '').trim()) as SttLang;
  return ['zh', 'ja', 'en', 'ko', 'yue'].includes(v) ? v : '';
}

const toTaiwan = Converter({ from: 'cn', to: 'twp' });

/**
 * The text as the page shows it: Chinese in Taiwan traditional characters (a Japanese or English line is left as it is), the
 * spaces SenseVoice puts around Chinese and Japanese removed, trimmed.
 */
export function cleanText(text: string, lang: SttLang): string {
  let t = (text ?? '').trim();
  if (lang === 'zh' || lang === 'yue') t = toTaiwan(t);
  if (lang !== 'en') t = t.replace(/\s+(?=[^\x00-\x7F])|(?<=[^\x00-\x7F])\s+/g, '');
  return t;
}

/**
 * One utterance: auto first; a language outside Chinese / Japanese / English is read again with the forced language
 * (Cantonese → Mandarin, Korean → Japanese), since the player speaks only Chinese and Japanese here.
 */
export function recognize(samples: Float32Array, get: (language: 'auto' | 'zh' | 'ja') => Recognizer): { text: string; lang: SttLang } {
  const first = get('auto').decode(samples);
  let lang = langTag(first.lang);
  let text = first.text ?? '';
  if (lang === 'yue' || lang === 'ko') {
    const forced = lang === 'yue' ? 'zh' : 'ja';
    const again = get(forced).decode(samples);
    text = again.text ?? '';
    lang = forced;
  }
  return { text: cleanText(text, lang), lang };
}

/** base64 of 16-bit little-endian PCM → float samples in -1..1 */
export function pcmToFloat(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

// ---------------------------------------------------------------- the sherpa-onnx recognizers (one per language setting)

const recognizers = new Map<string, Recognizer>();

function sherpaRecognizer(root: string, language: string): Recognizer {
  const key = `${root}|${language}`;
  const have = recognizers.get(key);
  if (have) return have;
  const require = createRequire(import.meta.url);
  // a native addon: loaded on the first use, so a PC without it still starts (the page then uses the browser's recognizer)
  const sherpa = require('sherpa-onnx-node') as {
    OfflineRecognizer: new (cfg: unknown) => {
      createStream(): { acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void };
      decode(s: unknown): void;
      getResult(s: unknown): RawResult;
    };
  };
  const dir = sttModelDir(root);
  const rec = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: STT_SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: path.join(dir, 'model.int8.onnx'), language, useInverseTextNormalization: 1 },
      tokens: path.join(dir, 'tokens.txt'),
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
  });
  const r: Recognizer = {
    decode(samples) {
      const s = rec.createStream();
      s.acceptWaveform({ sampleRate: STT_SAMPLE_RATE, samples });
      rec.decode(s);
      return rec.getResult(s);
    },
  };
  recognizers.set(key, r);
  return r;
}

/** whether local recognition can be used: the model is here and the addon loads (checked once, then remembered) */
let usable: boolean | null = null;
export function sttUsable(root: string): boolean {
  if (usable !== null) return usable;
  if (!sttModelPresent(root)) return false; // not remembered: the model may be downloaded while the server runs
  try {
    sherpaRecognizer(root, 'auto');
    usable = true;
  } catch (e) {
    console.warn('[stt] 本機語音辨識無法載入，改用瀏覽器內建的辨識：', e instanceof Error ? e.message : e);
    usable = false;
  }
  return usable;
}

// ---------------------------------------------------------------- the routes

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function handleStt(req: IncomingMessage, res: ServerResponse, root: string): Promise<void> {
  const url = (req.url ?? '/').split('?')[0].replace(/\/$/, '');
  if (req.method === 'GET' && url === '/status') return json(res, 200, { ok: sttUsable(root) });
  if (req.method !== 'POST' || url !== '') return json(res, 404, { error: 'not_found', message: '沒有這個 API' });
  if (!sttUsable(root)) return json(res, 503, { error: 'stt_unavailable', message: '本機語音辨識沒有安裝' });
  const raw = await readBody(req);
  if (raw === null) return json(res, 413, { error: 'bad_request', message: `一次最多 ${STT_MAX_SECONDS} 秒` });
  let pcm: unknown;
  try {
    pcm = (JSON.parse(raw) as { pcm?: unknown }).pcm;
  } catch {
    return json(res, 400, { error: 'bad_request', message: '格式錯誤' });
  }
  if (typeof pcm !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(pcm)) return json(res, 400, { error: 'bad_request', message: '格式錯誤' });
  const samples = pcmToFloat(pcm);
  if (samples.length < STT_SAMPLE_RATE / 10) return json(res, 200, { ok: true, text: '', lang: '' });
  const t0 = Date.now();
  const r = recognize(samples, (language) => sherpaRecognizer(root, language));
  console.log(`[stt] ${(samples.length / STT_SAMPLE_RATE).toFixed(1)}s → ${r.lang || '?'} in ${Date.now() - t0}ms`);
  return json(res, 200, { ok: true, text: r.text, lang: r.lang });
}

export function sttPlugin(): Plugin {
  let root = process.cwd();
  return {
    name: 'mugi-stt',
    apply: 'serve',
    configResolved(cfg) {
      root = cfg.root;
    },
    configureServer(server) {
      const guard = guardOptionsFrom(server);
      // load the model in the background, so the first sentence is not slow
      setTimeout(() => { sttUsable(root); }, 0);
      server.middlewares.use('/api/stt', guardApi((req, res) => {
        handleStt(req, res, root).catch((e: unknown) => {
          console.warn('[stt]', e instanceof Error ? e.message : e);
          if (!res.headersSent) json(res, 500, { error: 'server', message: '語音辨識失敗' });
        });
      }, guard));
    },
  };
}
