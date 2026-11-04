#!/usr/bin/env node
/**
 * Generates a scrypt password hash for WEB_ADMIN_PASSWORD_HASH.
 *
 * Usage:
 *   npm run hash-password -- "your-password"
 *   # or pipe it in (avoids shell history):
 *   node scripts/hash-password.mjs
 *
 * The output format matches `apps/server/src/auth.ts`:
 *   scrypt$16384$8$1$<saltBase64Url>$<hashBase64Url>
 */
import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

const argument = process.argv.slice(2).join(' ').trim();

const password = argument.length > 0 ? argument : await readPasswordFromStdin();
if (password.length === 0) {
  process.stderr.write('密码不能为空\n');
  process.exit(1);
}
if (password.length < 8) {
  process.stderr.write('警告：密码长度小于 8 个字符，建议使用更长的密码\n');
}

const salt = randomBytes(16);
const derived = scryptSync(password, salt, KEY_LENGTH, {
  N: SCRYPT_N,
  r: SCRYPT_R,
  p: SCRYPT_P,
  maxmem: 64 * 1024 * 1024,
});

const encoded = [
  'scrypt',
  String(SCRYPT_N),
  String(SCRYPT_R),
  String(SCRYPT_P),
  salt.toString('base64url'),
  derived.toString('base64url'),
].join('$');

process.stdout.write('\n把下面这行写入环境变量（不要提交到仓库）：\n\n');
process.stdout.write(`WEB_ADMIN_PASSWORD_HASH='${encoded}'\n\n`);
process.stdout.write('然后生成会话密钥：\n\n');
process.stdout.write(`WEB_SESSION_SECRET='${randomBytes(32).toString('base64url')}'\n\n`);

async function readPasswordFromStdin() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('请输入控制台管理密码（输入内容会回显）：');
    return answer.trim();
  } finally {
    rl.close();
  }
}
