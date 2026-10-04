import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const keyPath = process.env.MASTER_KEY_PATH || '/data/keys/master.key';
function master(hasCipher: boolean) {
  if (!existsSync(keyPath)) {
    if (hasCipher) throw new Error('MASTER_KEY_MISSING');
    mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
    writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
  }
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error('MASTER_KEY_INVALID');
  return key;
}
export function encrypt(value: string, hasCipher = false) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', master(hasCipher), iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
export function decrypt(value: string) {
  const raw = Buffer.from(value, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', master(true), raw.subarray(0,12));
  decipher.setAuthTag(raw.subarray(12,28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
