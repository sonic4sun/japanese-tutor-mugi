// 加密金鑰庫：Claude 與 DeepSeek 的金鑰存在專案資料夾外（MUGI_DATA_DIR，預設 ~/.mugi-tutor/keys.json）。
// Windows 上每把金鑰都用 DPAPI（CurrentUser）加密：只有這個 Windows 帳號解得開，資料夾被複製走也沒用。
// 寫入由桌面的「むぎ 設定金鑰」（scripts/set-keys.ps1）負責，伺服器只讀。檔案沒變時用記憶體裡的結果（DPAPI 每次要開
// PowerShell，約幾百毫秒）。金鑰的值從不寫進記錄或錯誤訊息。
//
// The key vault: the Claude and DeepSeek keys live outside the project folder, each one DPAPI-protected (CurrentUser) on
// Windows. scripts/set-keys.ps1 writes it; the server only reads. Format: { v: 1, keys: { name: base64 } }; a value
// 'plain:<key>' is accepted where there is no protector (other systems, tests).
import fs from 'node:fs';
import path from 'node:path';
import { dataDirectory, defaultProtector, type Protector } from './openai/credentials.ts';

export const VAULT_FILE = 'keys.json';
export const VAULT_NAMES = ['anthropic', 'deepseek'] as const;
export type VaultName = (typeof VAULT_NAMES)[number];
export type VaultKeys = Partial<Record<VaultName, string>>;

let cache: { file: string; mtimeMs: number; size: number; keys: VaultKeys } | null = null;

/** the keys in the vault (a name that is missing or cannot be opened is left out); never throws */
export function readVault(opts: { directory?: string; protector?: Protector | null } = {}): VaultKeys {
  const file = path.join(opts.directory ?? dataDirectory(), VAULT_FILE);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return {};
  }
  if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.keys;
  const protector = opts.protector === undefined ? defaultProtector() : opts.protector;
  const keys: VaultKeys = {};
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as { keys?: Record<string, unknown> };
    for (const name of VAULT_NAMES) {
      const v = data?.keys?.[name];
      if (typeof v !== 'string' || !v) continue;
      try {
        const key = v.startsWith('plain:') ? v.slice(6)
          : protector ? protector.unprotect(Buffer.from(v, 'base64')).toString('utf8') : '';
        if (key.trim()) keys[name] = key.trim();
      } catch {
        console.warn(`[keys] ${name} 的金鑰解不開（換了 Windows 帳號？），請用桌面的「むぎ 設定金鑰」重新設定`);
      }
    }
  } catch {
    console.warn('[keys] keys.json 讀不了，請用桌面的「むぎ 設定金鑰」重新設定');
  }
  cache = { file, mtimeMs: st.mtimeMs, size: st.size, keys };
  return keys;
}

/**
 * One key from this PC's vault ('' when none). Under the test runner the real vault is never read, so a key the player saved
 * cannot change what a test sees (the tests call readVault with their own folder).
 */
export function vaultKey(name: VaultName): string {
  if (process.env.VITEST) return '';
  return readVault()[name] ?? '';
}
