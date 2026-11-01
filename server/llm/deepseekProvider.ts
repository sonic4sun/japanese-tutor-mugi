// The DeepSeek backend: its OpenAI-compatible Chat Completions API (https://api.deepseek.com/chat/completions), with the key
// from the vault (server/secretVault.ts). The Anthropic-shaped request of claudeChat is converted here: the system blocks →
// one system message, messages → text messages (cache marks dropped), thinking off (a tutor reply should come quickly).
// DeepSeek has no strict JSON schema, only JSON mode (response_format json_object): the schema of the request is written into
// the system message instead, and an empty reply (the JSON mode sometimes gives one) is an error, so the next service answers.
import type { LlmChatRequest, LlmCompleteOptions, LlmCompleteRequest, LlmProvider, LlmResult, LlmStream } from './provider.ts';
import { defaultDescribeError } from './provider.ts';
import { readSSE } from './openaiProvider.ts';

export const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
/** the whole DeepSeek reply (stream included) must finish within this long, as the other services */
export const DEEPSEEK_STREAM_TIMEOUT_MS = 120_000;

/** An error from DeepSeek: `status` when there was an HTTP response, `timeout` when our own time limit ended it, `code` 'empty' for an empty reply. */
export class DeepSeekError extends Error {
  status?: number;
  code?: string;
  timeout?: boolean;
  constructor(message: string, opts: { status?: number; code?: string; timeout?: boolean } = {}) {
    super(message);
    this.name = 'DeepSeekError';
    this.status = opts.status;
    this.code = opts.code;
    this.timeout = opts.timeout;
  }
}

type Block = { type?: string; text?: unknown };

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b: Block) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
  return '';
}

/** the Chat Completions body of an Anthropic-shaped request (exported for the tests) */
export function deepseekBody(req: LlmChatRequest | LlmCompleteRequest, model: string): Record<string, unknown> {
  const system = req.system as unknown;
  let instructions = Array.isArray(system) ? system.map((b: Block) => textOf([b])).filter(Boolean).join('\n\n') : textOf(system);
  const format = req.output_config?.format;
  if (format) {
    // JSON mode needs the word "json" in the prompt and the shape spelled out
    instructions += '\n\n# Output format\nReply with one json object only (no code fence, no text before or after it). '
      + 'It must match this JSON Schema exactly: every required field present, no other fields.\n'
      + JSON.stringify(format.schema);
  }
  const messages = [
    ...(instructions ? [{ role: 'system', content: instructions }] : []),
    ...req.messages.map((m) => ({ role: m.role, content: textOf(m.content) })),
  ];
  return {
    model,
    messages,
    max_tokens: req.max_tokens,
    stream: true,
    thinking: { type: 'disabled' },
    ...(format ? { response_format: { type: 'json_object' } } : {}),
  };
}

/** Reads a Chat Completions stream: each content delta goes to onDelta; an empty reply or a stream without an end is an error. */
export async function collectDeepSeek(body: ReadableStream<Uint8Array> | null, onDelta: (text: string) => void): Promise<LlmResult> {
  let text = '';
  let model: string | undefined;
  let finish: string | null = null;
  for await (const ev of readSSE(body)) {
    if (typeof ev.model === 'string') model = ev.model;
    const choice = (Array.isArray(ev.choices) ? ev.choices[0] : undefined) as { delta?: { content?: unknown }; finish_reason?: unknown } | undefined;
    const delta = choice?.delta?.content;
    if (typeof delta === 'string' && delta) {
      text += delta;
      onDelta(delta);
    }
    if (typeof choice?.finish_reason === 'string') finish = choice.finish_reason;
  }
  if (!finish) throw new DeepSeekError('DeepSeek 連線中斷，請重試。');
  if (!text.trim()) throw new DeepSeekError('DeepSeek 回了空白的回覆，改用下一個服務。', { status: 502, code: 'empty' });
  return { text, model, stopReason: finish === 'stop' ? 'end_turn' : finish === 'length' ? 'max_tokens' : finish };
}

/** Upstream failure → HTTP status and a message for the player (never the key). */
export function describeDeepSeekError(e: unknown): { status: number; message: string } {
  if (e instanceof DeepSeekError) {
    if (e.timeout) return { status: 504, message: 'DeepSeek 回應逾時，已中止' };
    if (e.status === 401 || e.status === 403) return { status: 401, message: 'DeepSeek 金鑰無效，請用桌面的「むぎ 設定金鑰」重新設定' };
    if (e.status === 402) return { status: 402, message: 'DeepSeek 餘額不足，請到 DeepSeek 平台儲值' };
    if (e.status === 429) return { status: 429, message: 'DeepSeek 請求太頻繁，稍後再試' };
    if (typeof e.status === 'number' && e.status >= 500) return { status: 502, message: e.code === 'empty' ? e.message : 'DeepSeek 暫時有問題，請稍後再試' };
    if (typeof e.status === 'number') return { status: 502, message: `DeepSeek 回應錯誤（${e.status}）` };
    return { status: 502, message: e.message };
  }
  if (e instanceof TypeError) return { status: 502, message: '連不上 DeepSeek' };
  return defaultDescribeError(e);
}

export type DeepSeekFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>;

export function deepseekProvider(key: string, opts: { fetch?: DeepSeekFetch } = {}): LlmProvider {
  const doFetch: DeepSeekFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  async function run(req: LlmChatRequest | LlmCompleteRequest, onDelta: (text: string) => void, signal: AbortSignal): Promise<LlmResult> {
    const res = await doFetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(deepseekBody(req, req.model)),
      signal,
    });
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      // 402 = the balance ran out: the next service answers (aiChain.fallbackWorthy)
      throw new DeepSeekError(`DeepSeek 回應錯誤（${res.status}）`, { status: res.status, code: res.status === 402 ? 'insufficient_balance' : undefined });
    }
    const onAbort = () => { void res.body?.cancel().catch(() => {}); };
    if (signal.aborted) onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await collectDeepSeek(res.body, onDelta);
    } catch (e) {
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      throw e;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
  /** one request with a time limit: our own limit is a timeout; the caller's abort is not */
  function limited(req: LlmChatRequest | LlmCompleteRequest, onDelta: (text: string) => void, ms: number | undefined) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = ms ? setTimeout(() => { timedOut = true; ctrl.abort(); }, ms) : undefined;
    const done = run(req, onDelta, ctrl.signal)
      .catch((e: unknown) => {
        if (timedOut) throw new DeepSeekError('DeepSeek 回應逾時，已中止', { timeout: true });
        throw e;
      })
      .finally(() => { if (timer) clearTimeout(timer); });
    return { ctrl, done };
  }
  return {
    id: 'deepseek',
    streamChat(req: LlmChatRequest, onDelta: (text: string) => void): LlmStream {
      const { ctrl, done } = limited(req, onDelta, DEEPSEEK_STREAM_TIMEOUT_MS);
      return { abort: () => ctrl.abort(), done, usageSoFar: () => undefined };
    },
    complete(req: LlmCompleteRequest, o?: LlmCompleteOptions): Promise<LlmResult> {
      return limited(req, () => {}, o?.timeout).done;
    },
    describeError: describeDeepSeekError,
  };
}
