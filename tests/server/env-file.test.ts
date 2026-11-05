import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createEnvFileStore,
  maskEnvValue,
  parseEnvFile,
  parseEnvFileKeys,
  type EnvFileFs,
} from '../../apps/server/src/env-file.js';

const BAK_PREFIX = '.env.bak-';
const TMP_PREFIX = '.env.tmp-';

/** Wraps the real fs and lets individual calls be replaced. */
function makeFs(overrides: Partial<EnvFileFs> = {}): EnvFileFs {
  const base: EnvFileFs = {
    readFile: (path, encoding) => nodeFs.readFile(path, encoding),
    writeFile: (path, data, options) => nodeFs.writeFile(path, data, options),
    rename: (from, to) => nodeFs.rename(from, to),
    chmod: (path, mode) => nodeFs.chmod(path, mode),
    mkdir: async (path, options) => nodeFs.mkdir(path, options),
    readdir: (path) => nodeFs.readdir(path),
    unlink: (path) => nodeFs.unlink(path),
    stat: async (path) => ({ mode: (await nodeFs.stat(path)).mode }),
  };
  return { ...base, ...overrides };
}

describe('env-file store', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-env-'));
    filePath = join(dir, '.env');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function read(): string {
    return readFileSync(filePath, 'utf8');
  }

  function write(content: string): void {
    writeFileSync(filePath, content, 'utf8');
  }

  function listFiles(prefix: string): string[] {
    return readdirSync(dir).filter((name) => name.startsWith(prefix));
  }

  it('keeps comments, blank lines and line order when updating a key', async () => {
    write(
      [
        '# OmniRelay credentials (fixture)',
        '',
        'DISCORD_BOT_TOKEN=test-token-old',
        '# keep this comment',
        'QQ_APP_ID=test-app-id',
        '',
      ].join('\n'),
    );

    const store = createEnvFileStore({ filePath });
    await store.set('DISCORD_BOT_TOKEN', 'test-token-new');

    expect(read()).toBe(
      [
        '# OmniRelay credentials (fixture)',
        '',
        'DISCORD_BOT_TOKEN="test-token-new"',
        '# keep this comment',
        'QQ_APP_ID=test-app-id',
        '',
      ].join('\n'),
    );
  });

  it('appends a new key at the end without reordering existing lines', async () => {
    write('# header\nQQ_APP_ID=test-app-id\n');

    const store = createEnvFileStore({ filePath });
    await store.set('DISCORD_BOT_TOKEN', 'test-token-appended');

    expect(read()).toBe(
      '# header\nQQ_APP_ID=test-app-id\nDISCORD_BOT_TOKEN="test-token-appended"\n',
    );
    expect(Object.keys(parseEnvFile(read()))).toEqual(['QQ_APP_ID', 'DISCORD_BOT_TOKEN']);
  });

  it('escapes quotes, backslashes and newlines and round-trips them', async () => {
    const value = 'test-token-"quoted"-\\backslash\ntest-token-second-line';
    const store = createEnvFileStore({ filePath });

    await store.set('FAKE_KEY', value);

    const content = read();
    expect(content).toBe(
      `${String.raw`FAKE_KEY="test-token-\"quoted\"-\\backslash\ntest-token-second-line"`}\n`,
    );
    // A written value never spans multiple physical lines.
    expect(content.trimEnd().split('\n')).toHaveLength(1);
    expect(parseEnvFile(content)['FAKE_KEY']).toBe(value);
  });

  it('reads plain, double quoted and single quoted values', () => {
    const content = [
      'PLAIN=test-token-plain',
      'DOUBLE="test-token double"',
      "SINGLE='test-token single'",
      'ESCAPED="line1\\nline2"',
      'EMPTY=',
      // Commented-out assignments must not be parsed as keys.
      '# DISABLED_TOKEN=test-token-disabled',
    ].join('\n');

    expect(parseEnvFile(content)).toEqual({
      PLAIN: 'test-token-plain',
      DOUBLE: 'test-token double',
      SINGLE: 'test-token single',
      ESCAPED: 'line1\nline2',
      EMPTY: '',
    });
    expect(parseEnvFileKeys(content)).toEqual(['PLAIN', 'DOUBLE', 'SINGLE', 'ESCAPED', 'EMPTY']);
  });

  it('removes the line when the value is empty and leaves neighbours untouched', async () => {
    write(
      ['# header', '', 'DISCORD_BOT_TOKEN=test-token-old', '', 'QQ_APP_ID=test-app-id', ''].join(
        '\n',
      ),
    );

    const store = createEnvFileStore({ filePath });
    await store.set('DISCORD_BOT_TOKEN', '');

    expect(read()).toBe(['# header', '', '', 'QQ_APP_ID=test-app-id', ''].join('\n'));
    expect(await store.has('DISCORD_BOT_TOKEN')).toBe(false);
  });

  it('collapses duplicate keys into a single definition', async () => {
    write('A=test-a1\nB=test-b1\nA=test-a2\n');

    const store = createEnvFileStore({ filePath });
    await store.set('A', 'test-a3');

    const lines = read().trimEnd().split('\n');
    expect(lines.filter((line) => line.startsWith('A='))).toHaveLength(1);
    expect(parseEnvFile(read())).toEqual({ A: 'test-a3', B: 'test-b1' });
  });

  it('leaves the original file intact and cleans up when rename fails', async () => {
    const original = 'DISCORD_BOT_TOKEN="test-token-original"\n';
    write(original);

    const store = createEnvFileStore({
      filePath,
      fs: makeFs({
        rename: () => Promise.reject(Object.assign(new Error('rename failed'), { code: 'EACCES' })),
      }),
    });

    await expect(store.set('DISCORD_BOT_TOKEN', 'test-token-broken')).rejects.toThrow(
      'rename failed',
    );
    expect(read()).toBe(original);
    expect(listFiles(TMP_PREFIX)).toEqual([]);
  });

  it('leaves the original file intact and cleans up when writeFile fails', async () => {
    const original = 'QQ_APP_ID="test-app-id"\n';
    write(original);

    const store = createEnvFileStore({
      filePath,
      fs: makeFs({
        writeFile: () => Promise.reject(new Error('disk full')),
      }),
    });

    await expect(store.set('QQ_APP_ID', 'test-app-id-new')).rejects.toThrow('disk full');
    expect(read()).toBe(original);
    expect(listFiles(TMP_PREFIX)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('creates the file with mode 600', async () => {
    const store = createEnvFileStore({ filePath });
    await store.set('DISCORD_BOT_TOKEN', 'test-token-mode');

    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('re-applies mode 600 on an existing file', async () => {
    write('DISCORD_BOT_TOKEN="test-token-old"\n');
    await nodeFs.chmod(filePath, 0o644);

    const store = createEnvFileStore({ filePath });
    await store.set('DISCORD_BOT_TOKEN', 'test-token-new');

    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('serialises concurrent writes without corrupting the file', async () => {
    const store = createEnvFileStore({ filePath });

    await Promise.all([
      store.set('A', 'test-a1'),
      store.set('B', 'test-b1'),
      store.set('A', 'test-a3'),
    ]);

    const content = read();
    const lines = content.trimEnd().split('\n');
    expect(lines.filter((line) => line.startsWith('A='))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith('B='))).toHaveLength(1);
    expect(parseEnvFile(content)).toEqual({ A: 'test-a3', B: 'test-b1' });
  });

  it('keeps at most five backups, newest last', async () => {
    write('SEED="test-seed"\n');
    let tick = 0;
    const now = (): Date => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + tick++ * 1000);

    const store = createEnvFileStore({ filePath, now });
    const stamps = [0, 1, 2, 3, 4, 5, 6, 7].map((index) => expectedStamp(nowTick(index)));
    for (let index = 0; index < 8; index += 1) {
      await store.set('SEED', `test-seed-${index}`);
    }

    const backups = listFiles(BAK_PREFIX).sort();
    expect(backups).toHaveLength(5);
    expect(backups).toEqual(stamps.slice(-5).map((stamp) => `${BAK_PREFIX}${stamp}`));
    expect(backups.at(-1)).toBe(`${BAK_PREFIX}${stamps.at(-1)}`);
  });

  it('honours a custom maxBackups value', async () => {
    write('SEED="test-seed"\n');
    let tick = 0;
    const now = (): Date => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + tick++ * 1000);

    const store = createEnvFileStore({ filePath, now, maxBackups: 2 });
    for (let index = 0; index < 5; index += 1) {
      await store.set('SEED', `test-seed-${index}`);
    }

    expect(listFiles(BAK_PREFIX)).toHaveLength(2);
  });

  it('keeps no backups when maxBackups is zero', async () => {
    write('SEED="test-seed"\n');
    let tick = 0;
    const now = (): Date => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + tick++ * 1000);

    const store = createEnvFileStore({ filePath, now, maxBackups: 0 });
    await store.set('SEED', 'test-seed-next');

    expect(listFiles(BAK_PREFIX)).toEqual([]);
    expect(parseEnvFile(read())['SEED']).toBe('test-seed-next');
  });

  it('preserves CRLF line endings when updating a key', async () => {
    write('# header\r\nDISCORD_BOT_TOKEN="test-token-old"\r\nQQ_APP_ID="test-app-id"\r\n');

    const store = createEnvFileStore({ filePath });
    await store.set('DISCORD_BOT_TOKEN', 'test-token-new');

    expect(read()).toBe(
      '# header\r\nDISCORD_BOT_TOKEN="test-token-new"\r\nQQ_APP_ID="test-app-id"\r\n',
    );
  });

  it('is a no-op when deleting from a file that does not exist yet', async () => {
    const store = createEnvFileStore({ filePath });

    await store.set('DISCORD_BOT_TOKEN', '');

    expect(existsSync(filePath)).toBe(false);
  });

  it('reports presence and masks values without exposing them', async () => {
    const store = createEnvFileStore({ filePath });

    expect(await store.has('DISCORD_BOT_TOKEN')).toBe(false);
    expect(await store.masked('DISCORD_BOT_TOKEN')).toBeNull();

    await store.set('DISCORD_BOT_TOKEN', 'test-token-0001');

    expect(await store.has('DISCORD_BOT_TOKEN')).toBe(true);
    expect(await store.masked('DISCORD_BOT_TOKEN')).toBe('test…0001');
    expect(await store.masked('QQ_APP_ID')).toBeNull();
  });

  it('creates missing parent directories', async () => {
    const nested = join(dir, 'deep', 'nested', '.env');
    const store = createEnvFileStore({ filePath: nested });

    await store.set('QQ_APP_ID', 'test-app-id');

    expect(existsSync(nested)).toBe(true);
    expect(readFileSync(nested, 'utf8')).toBe('QQ_APP_ID="test-app-id"\n');
  });

  it('rejects keys that would break the line format', async () => {
    const store = createEnvFileStore({ filePath });

    await expect(store.set('BAD KEY', 'test-token')).rejects.toThrow(/invalid env key/);
    await expect(store.set('A=1\nB', 'test-token')).rejects.toThrow(/invalid env key/);
    expect(existsSync(filePath)).toBe(false);
  });

  function nowTick(index: number): Date {
    return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + index * 1000);
  }
});

describe('parseEnvFile', () => {
  it('lets the last duplicate win', () => {
    expect(parseEnvFile('A=test-1\nA=test-2\nA="test-3"\n')).toEqual({ A: 'test-3' });
  });

  it('accepts export prefixed keys and surrounding whitespace', () => {
    expect(parseEnvFile('export A=test-a\n  B = "test b"\n')).toEqual({
      A: 'test-a',
      B: 'test b',
    });
  });

  it('returns an empty object for an empty file', () => {
    expect(parseEnvFile('')).toEqual({});
    expect(parseEnvFileKeys('')).toEqual([]);
  });
});

describe('maskEnvValue', () => {
  it('shows four leading and four trailing characters for long values', () => {
    expect(maskEnvValue('test-token-0001')).toBe('test…0001');
    expect(maskEnvValue('12345678')).toBe('1234…5678');
  });

  it('fully hides short values', () => {
    expect(maskEnvValue('abc')).toBe('••••');
    expect(maskEnvValue('abcdefg')).toBe('••••');
    expect(maskEnvValue('a')).toBe('••');
    expect(maskEnvValue('ab')).toBe('••');
  });

  it('returns null for unconfigured values', () => {
    expect(maskEnvValue('')).toBeNull();
    expect(maskEnvValue(null)).toBeNull();
    expect(maskEnvValue(undefined)).toBeNull();
  });
});

/** Mirrors the store's `YYYYMMDDHHmmssSSS` backup stamp (local time). */
function expectedStamp(date: Date): string {
  const pad = (value: number, width: number): string => String(value).padStart(width, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1, 2)}${pad(date.getDate(), 2)}` +
    `${pad(date.getHours(), 2)}${pad(date.getMinutes(), 2)}${pad(date.getSeconds(), 2)}` +
    `${pad(date.getMilliseconds(), 3)}`
  );
}
