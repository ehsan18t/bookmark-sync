import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

export function extensionId(publicKeyBase64) {
  const hex = createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = ['.env', '.env.local'].filter((f) => existsSync(f)).map((f) => parseEnv(readFileSync(f, 'utf8')));
  const key = Object.assign({}, ...files).WXT_CHROMIUM_KEY;
  if (!key) throw new Error('WXT_CHROMIUM_KEY is not set in .env');
  const id = extensionId(key);
  console.log(`Extension ID:  ${id}`);
  console.log(`Redirect URI:  https://${id}.chromiumapp.org/`);
}
