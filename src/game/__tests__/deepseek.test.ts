import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deepseekBody, deepseekProvider, collectDeepSeek, DeepSeekError, DEEPSEEK_URL } from '../../../server/llm/deepseekProvider.ts';
import { readVault, VAULT_FILE } from '../../../server/secretVault.ts';
import { fallbackWorthy } from '../../../server/aiChain.ts';
import { parseProviderList } from '../claudeProtocol.ts';
import { serviceReady } from '../tutor.ts';

function sse(events: unknown[]): ReadableStream<Uint8Array> {
  const text = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
  return new Response(text).body!;
}
const chunk = (content: string, finish: string | null = null) => ({ model: 'deepseek-flash', choices: [{ delta: { content }, finish_reason: finish }] });

describe('DeepSeek request body', () => {
  it('one system message, thinking off, JSON mode with the schema spelled out', () => {
    const body = deepseekBody({
      model: 'deepseek-flash', max_tokens: 500,
      system: [{ type: 'text', text: 'You are Mugi.', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'こんにちは' }] }],
      output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: { a: { type: 'string' } } } } },
    } as never, 'deepseek-flash');
    expect(body.model).toBe('deepseek-flash');
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.stream).toBe(true);
    const msgs = body.messages as { role: string; content: string }[];
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('You are Mugi.');
    expect(msgs[0].content).toContain('json');
    expect(msgs[0].content).toContain('"properties"');
    expect(msgs[1]).toEqual({ role: 'user', content: 'こんにちは' });
  });
  it('no schema: no JSON mode', () => {
    const body = deepseekBody({ model: 'm', max_tokens: 10, system: 'hi', messages: [{ role: 'user', content: 'x' }] }, 'deepseek-flash');
    expect(body.response_format).toBeUndefined();
  });
});

describe('DeepSeek stream', () => {
  it('passes each delta on and returns the whole text', async () => {
    const seen: string[] = [];
    const r = await collectDeepSeek(sse([chunk('{"a":'), chunk('"b"}', 'stop'), '[DONE]']), (d) => seen.push(d));
    expect(seen).toEqual(['{"a":', '"b"}']);
    expect(r.text).toBe('{"a":"b"}');
    expect(r.stopReason).toBe('end_turn');
  });
  it('an empty reply is an error the next service takes over', async () => {
    const e = await collectDeepSeek(sse([chunk('', 'stop')]), () => {}).catch((x) => x);
    expect(e).toBeInstanceOf(DeepSeekError);
    expect(fallbackWorthy(e)).toBe(true);
  });
  it('a stream without an end is a dropped line', async () => {
    await expect(collectDeepSeek(sse([chunk('{')]), () => {})).rejects.toThrow('連線中斷');
  });
});

describe('DeepSeek provider', () => {
  it('sends the key as a bearer token to the DeepSeek endpoint', async () => {
    const fetch = vi.fn(async () => new Response(sse([chunk('ok', 'stop')])));
    const r = await deepseekProvider('sk-test', { fetch }).complete({ model: 'deepseek-flash', max_tokens: 5, system: 's', messages: [{ role: 'user', content: 'u' }] });
    expect(r.text).toBe('ok');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe(DEEPSEEK_URL);
    expect(init.headers.Authorization).toBe('Bearer sk-test');
  });
  it('a 402 (no balance) and a 401 move on to the next service', async () => {
    for (const status of [402, 401]) {
      const fetch = vi.fn(async () => new Response('{}', { status }));
      const e = await deepseekProvider('k', { fetch }).complete({ model: 'm', max_tokens: 5, system: 's', messages: [] }).catch((x) => x);
      expect(fallbackWorthy(e)).toBe(true);
    }
  });
});

describe('DeepSeek in the service list', () => {
  it('up to three services, deepseek included', () => {
    expect(parseProviderList(['deepseek', 'anthropic', 'openai'])).toEqual(['deepseek', 'anthropic', 'openai']);
    expect(parseProviderList(['deepseek', 'deepseek'])).toBeUndefined();
  });
  it('ready when DeepSeek is listed and has its key', () => {
    expect(serviceReady(['deepseek'], { anthropic: false, openai: false, deepseek: true })).toBe(true);
    expect(serviceReady(['deepseek'], { anthropic: true, openai: true, deepseek: false })).toBe(false);
  });
});

describe('key vault', () => {
  it('opens each key with the protector; a missing file is no keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mugi-vault-'));
    try {
      expect(readVault({ directory: dir, protector: null })).toEqual({});
      const protector = { protect: (b: Buffer) => Buffer.from(b.toString('utf8').split('').reverse().join('')), unprotect: (b: Buffer) => Buffer.from(b.toString('utf8').split('').reverse().join('')) };
      writeFileSync(join(dir, VAULT_FILE), JSON.stringify({ v: 1, keys: { deepseek: Buffer.from('cba-ks').toString('base64'), anthropic: 'plain:sk-ant' } }));
      expect(readVault({ directory: dir, protector })).toEqual({ deepseek: 'sk-abc', anthropic: 'sk-ant' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
