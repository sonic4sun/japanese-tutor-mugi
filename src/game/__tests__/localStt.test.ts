import { describe, expect, it } from 'vitest';
import { cleanText, langTag, pcmToFloat, recognize, STT_MODEL_NAME } from '../../../server/stt.ts';
import { floatToPcmBase64, LevelDetector, LOCAL_VAD, resampleTo16k } from '../../ui/localSpeech.ts';
import { localSpeechActive, setLocalSpeech, speechCtor, type SpeechCtor } from '../../ui/useSpeechInput.ts';

describe('local STT: server side', () => {
  it('uses the 2024-07-17 model (the 2025-09-09 one is a Cantonese fine-tune)', () => {
    expect(STT_MODEL_NAME).toContain('2024-07-17');
  });
  it('reads the language tag', () => {
    expect(langTag('<|ja|>')).toBe('ja');
    expect(langTag('<|zh|>')).toBe('zh');
    expect(langTag('<|nospeech|>')).toBe('');
  });
  it('Chinese becomes Taiwan traditional; Japanese is left alone', () => {
    expect(cleanText('开饭时间早上9点 软件', 'zh')).toBe('開飯時間早上9點軟體');
    expect(cleanText('うちの中学は弁当制で', 'ja')).toBe('うちの中学は弁当制で');
    expect(cleanText(' hello world ', 'en')).toBe('hello world');
  });
  it('Cantonese is read again as Mandarin, Korean as Japanese; Chinese and Japanese once', () => {
    const calls: string[] = [];
    const fake = (out: Record<string, { text: string; lang: string }>) => (language: 'auto' | 'zh' | 'ja') => ({
      decode: () => { calls.push(language); return out[language]; },
    });
    expect(recognize(new Float32Array(1), fake({ auto: { text: '呢個', lang: '<|yue|>' }, zh: { text: '这个', lang: '<|zh|>' } }))).toEqual({ text: '這個', lang: 'zh' });
    expect(calls).toEqual(['auto', 'zh']);
    calls.length = 0;
    expect(recognize(new Float32Array(1), fake({ auto: { text: '안녕', lang: '<|ko|>' }, ja: { text: 'あんにょん', lang: '<|ja|>' } }))).toEqual({ text: 'あんにょん', lang: 'ja' });
    calls.length = 0;
    expect(recognize(new Float32Array(1), fake({ auto: { text: 'こんにちは', lang: '<|ja|>' } }))).toEqual({ text: 'こんにちは', lang: 'ja' });
    expect(calls).toEqual(['auto']);
  });
  it('PCM survives the trip from the page to the server', () => {
    const src = new Float32Array([0, 0.5, -0.5, 0.25, -1]);
    const back = pcmToFloat(floatToPcmBase64(src));
    expect(back.length).toBe(src.length);
    back.forEach((v, i) => expect(v).toBeCloseTo(src[i], 3));
  });
});

describe('local STT: page side', () => {
  it('resamples 48 kHz to 16 kHz', () => {
    expect(resampleTo16k(new Float32Array(4800), 48000).length).toBe(1600);
    const same = new Float32Array(10);
    expect(resampleTo16k(same, 16000)).toBe(same);
  });
  it('the level detector: speech after minSpeechMs of sound, the end after endSilenceMs of quiet', () => {
    const d = new LevelDetector();
    for (let i = 0; i < 20; i++) expect(d.frame(0.002, 40)).toBeNull(); // room noise
    let ev: string | null = null;
    for (let t = 0; t < LOCAL_VAD.minSpeechMs && !ev; t += 40) ev = d.frame(0.2, 40);
    expect(ev).toBe('speech-start');
    ev = null;
    let quiet = 0;
    while (!ev && quiet < 5000) { ev = d.frame(0.002, 40); quiet += 40; }
    expect(ev).toBe('end');
    expect(quiet).toBeGreaterThanOrEqual(LOCAL_VAD.endSilenceMs);
  });
  it('a click shorter than minSpeechMs is not speech', () => {
    const d = new LevelDetector();
    expect(d.frame(0.3, 40)).toBeNull();
    expect(d.frame(0.002, 40)).toBeNull();
    expect(d.speech).toBe(false);
  });
  it('the PC recognizer replaces the browser one only when set', () => {
    expect(localSpeechActive()).toBe(false);
    const Fake = class {} as unknown as SpeechCtor;
    setLocalSpeech(Fake);
    expect(speechCtor()).toBe(Fake);
    expect(localSpeechActive()).toBe(true);
    // an explicit window (the tests' own) still reads that window
    expect(speechCtor({})).toBeNull();
    setLocalSpeech(null);
    expect(localSpeechActive()).toBe(false);
  });
});
