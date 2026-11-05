import * as nodeFs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

/**
 * Minimal filesystem surface used by the `.env` store.
 *
 * Abstracted so tests can inject failures (e.g. a failing `rename`) and verify
 * that the original file is never corrupted.
 */
export interface EnvFileFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(
    path: string,
    data: string,
    options: { mode?: number; encoding: 'utf8' },
  ): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
  stat(path: string): Promise<{ mode: number }>;
}

/** `.env` accessor used by the console credential routes. */
export interface EnvFileStore {
  /** Returns whether a key is present (existence only, the value is never exposed). */
  has(key: string): Promise<boolean>;
  /** Writes or updates a key; an empty value removes the key. */
  set(key: string, value: string): Promise<void>;
  /** Masked value for display; `null` when the key is not configured. */
  masked(key: string): Promise<string | null>;
}

export interface EnvFileStoreOptions {
  /** Absolute path of the `.env` file. */
  filePath: string;
  /** Number of backups to keep, defaults to 5. */
  maxBackups?: number | undefined;
  /** Injectable clock, mainly so tests get deterministic backup names. */
  now?: (() => Date) | undefined;
  /** Injectable fs, used by tests to simulate a failed atomic replace. */
  fs?: EnvFileFs | undefined;
}

const DEFAULT_MAX_BACKUPS = 5;

/** Owner read/write only. */
const FILE_MODE = 0o600;

/** Temporary and backup files are prefixed with the target basename. */
const TEMP_MARKER = '.tmp-';
const BACKUP_MARKER = '.bak-';

/** `KEY=`, optionally prefixed with `export`. */
const KEY_LINE_PATTERN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

const DEFAULT_FS: EnvFileFs = {
  readFile: (path, encoding) => nodeFs.readFile(path, encoding),
  writeFile: (path, data, options) => nodeFs.writeFile(path, data, options),
  rename: (from, to) => nodeFs.rename(from, to),
  chmod: (path, mode) => nodeFs.chmod(path, mode),
  mkdir: async (path, options) => nodeFs.mkdir(path, options),
  readdir: (path) => nodeFs.readdir(path),
  unlink: (path) => nodeFs.unlink(path),
  stat: async (path) => {
    const stats = await nodeFs.stat(path);
    return { mode: stats.mode };
  },
};

/**
 * Creates a store that reads and writes `KEY="value"` lines in a `.env` file.
 *
 * Every write is serialised in-process, backed up, and committed with a
 * temp-file + `rename` so a crash cannot leave a half-written file behind.
 */
export function createEnvFileStore(options: EnvFileStoreOptions): EnvFileStore {
  const { filePath } = options;
  const maxBackups = Math.max(0, Math.trunc(options.maxBackups ?? DEFAULT_MAX_BACKUPS));
  const clock = options.now ?? ((): Date => new Date());
  const fs = options.fs ?? DEFAULT_FS;

  // Process-wide tail of the write queue: each mutation links onto it, so
  // concurrent `set()` calls run one after another instead of interleaving.
  let queue: Promise<unknown> = Promise.resolve();

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function readText(): Promise<string | null> {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) {
        return null;
      }
      throw error;
    }
  }

  async function writeLines(content: string, previous: string | null): Promise<void> {
    await fs.mkdir(dirname(filePath), { recursive: true });
    if (previous !== null) {
      await writeBackup(previous);
    }

    const tempPath = `${filePath}${TEMP_MARKER}${randomSuffix()}`;
    try {
      await fs.writeFile(tempPath, content, { mode: FILE_MODE, encoding: 'utf8' });
      // `mode` is masked by the umask on creation; enforce it explicitly.
      await fs.chmod(tempPath, FILE_MODE);
      await fs.rename(tempPath, filePath);
    } catch (error) {
      await removeQuietly(tempPath);
      throw error;
    }

    // `rename` replaces the inode, so re-assert the mode on the final file.
    await fs.chmod(filePath, FILE_MODE);
    await pruneBackups();
  }

  async function writeBackup(content: string): Promise<void> {
    const backupPath = `${filePath}${BACKUP_MARKER}${timestampFor(clock())}`;
    try {
      await nodeFs.copyFile(filePath, backupPath);
    } catch {
      // Source vanished between read and copy: fall back to a plain write.
      await fs.writeFile(backupPath, content, { mode: FILE_MODE, encoding: 'utf8' });
    }
    // Best effort: not every platform honours chmod, and a failed chmod must
    // not abort an otherwise valid write.
    try {
      await fs.chmod(backupPath, FILE_MODE);
    } catch {
      // ignored, see above
    }
  }

  async function pruneBackups(): Promise<void> {
    const directory = dirname(filePath);
    const prefix = `${basename(filePath)}${BACKUP_MARKER}`;
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch {
      return;
    }
    const backups = entries.filter((entry) => entry.startsWith(prefix)).sort();
    const excess = backups.slice(0, Math.max(0, backups.length - maxBackups));
    for (const entry of excess) {
      await removeQuietly(join(directory, entry));
    }
  }

  async function removeQuietly(path: string): Promise<void> {
    try {
      await fs.unlink(path);
    } catch {
      // Already gone or never created: nothing to clean up.
    }
  }

  return {
    async has(key: string): Promise<boolean> {
      const content = await readText();
      if (content === null) {
        return false;
      }
      // A key assigned an empty value counts as "not configured", matching
      // `masked()` so both accessors agree on what "configured" means.
      return (parseEnvFile(content)[key] ?? '').length > 0;
    },

    async masked(key: string): Promise<string | null> {
      const content = await readText();
      if (content === null) {
        return null;
      }
      return maskEnvValue(parseEnvFile(content)[key] ?? null);
    },

    async set(key: string, value: string): Promise<void> {
      assertEnvKey(key);
      return serialize(async () => {
        const content = await readText();
        if (content === null && value.length === 0) {
          // Deleting from a file that does not exist is a no-op, not a reason
          // to create an empty one.
          return;
        }
        const next = upsertEnvLine(content ?? '', key, value);
        if (next === content) {
          return;
        }
        await writeLines(next, content);
      });
    },
  };
}

/**
 * Parses `KEY=value` lines into a map.
 *
 * Later assignments win, matching how `dotenv` treats duplicate keys.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const match = KEY_LINE_PATTERN.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1];
    if (key === undefined) {
      continue;
    }
    result[key] = parseEnvValue(line.slice(match[0].length));
  }
  return result;
}

/** Keys present in the file, in first-seen order, without their values. */
export function parseEnvFileKeys(content: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const line of content.split('\n')) {
    const match = KEY_LINE_PATTERN.exec(line);
    const key = match?.[1];
    if (key === undefined || seen.has(key)) {
      continue;
    }
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/**
 * Masks a secret for display.
 *
 * Long values keep a short prefix/suffix so operators can tell two tokens
 * apart, short values are fully hidden, and empty values are "not configured".
 */
export function maskEnvValue(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.length === 0) {
    return null;
  }
  if (value.length >= 8) {
    return `${value.slice(0, 4)}…${value.slice(-4)}`;
  }
  if (value.length >= 3) {
    return '••••';
  }
  return '••';
}

/**
 * Writes `key` into the raw file content.
 *
 * Only the matching line is replaced, so comments, blank lines and unrelated
 * keys keep their original position; an empty value deletes the line.
 */
function upsertEnvLine(content: string, key: string, value: string): string {
  const lines = content.split('\n');
  const next: string[] = [];
  // Keep CRLF files CRLF instead of mixing line endings mid-file.
  const newlineSuffix = content.includes('\r\n') ? '\r' : '';
  let replaced = false;

  for (const rawLine of lines) {
    const carriageReturn = rawLine.endsWith('\r');
    const line = carriageReturn ? rawLine.slice(0, -1) : rawLine;
    const match = KEY_LINE_PATTERN.exec(line);
    if (match?.[1] !== key) {
      next.push(rawLine);
      continue;
    }
    if (replaced) {
      // Drop stale duplicates so the file keeps a single definition.
      continue;
    }
    replaced = true;
    if (value.length > 0) {
      next.push(`${key}=${quoteEnvValue(value)}${carriageReturn ? '\r' : ''}`);
    }
  }

  if (!replaced && value.length > 0) {
    const line = `${key}=${quoteEnvValue(value)}${newlineSuffix}`;
    if (next.length > 0 && next[next.length - 1] === '') {
      // Append before the trailing newline sentinel.
      next.splice(next.length - 1, 0, line);
    } else {
      next.push(line);
    }
  }

  return next.join('\n');
}

/** Serialises a value as `"…"` with `\`, `"` and newlines escaped. */
function quoteEnvValue(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

/** Reads the value part of a `KEY=…` line, unescaping quoted forms. */
function parseEnvValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return '';
  }
  if (trimmed.startsWith('"')) {
    return unescapeDoubleQuoted(readQuotedValue(trimmed.slice(1), '"'));
  }
  if (trimmed.startsWith("'")) {
    // Single-quoted values are literal apart from an escaped quote.
    return readQuotedValue(trimmed.slice(1), "'").replace(/\\'/g, "'");
  }
  // Unquoted values run to the end of the line, minus an inline comment.
  return stripInlineComment(trimmed).trim();
}

/**
 * Cuts at the closing quote, honouring backslash escapes.
 *
 * Trailing whitespace and comments after the closing quote are discarded; an
 * unterminated quote yields the remainder verbatim rather than losing data.
 */
function readQuotedValue(rest: string, quote: '"' | "'"): string {
  let index = 0;
  while (index < rest.length) {
    const char = rest[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) {
      return rest.slice(0, index);
    }
    index += 1;
  }
  return rest;
}

/** Removes a ` # comment` suffix from an unquoted value. */
function stripInlineComment(value: string): string {
  const index = value.search(/\s#/);
  return index === -1 ? value : value.slice(0, index);
}

/** Expands the escapes produced by {@link quoteEnvValue}. */
function unescapeDoubleQuoted(value: string): string {
  return value.replace(/\\(["\\nrt])/g, (_match, token: string) => {
    switch (token) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case '\\':
        return '\\';
      case 't':
        return '\t';
      default:
        return '"';
    }
  });
}

/** Rejects keys that could break out of the `KEY=` line format. */
function assertEnvKey(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`invalid env key: ${key}`);
  }
}

/** True for ENOENT/ENOTDIR, i.e. "the file is simply not there yet". */
function isMissingFile(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** `YYYYMMDDHHmmssSSS` in local time, used for backup ordering. */
function timestampFor(date: Date): string {
  const pad = (value: number, width: number): string => String(value).padStart(width, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1, 2)}${pad(date.getDate(), 2)}` +
    `${pad(date.getHours(), 2)}${pad(date.getMinutes(), 2)}${pad(date.getSeconds(), 2)}` +
    `${pad(date.getMilliseconds(), 3)}`
  );
}

/** Random suffix so two writes never collide on the temp file name. */
function randomSuffix(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}
