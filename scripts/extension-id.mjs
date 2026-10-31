import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

export function extensionId(publicKeyBase64) {
  const hex = createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/** Firefox names the redirect host after the SHA-1 of the add-on ID, and offers this loopback form of it. */
export function firefoxRedirect(geckoId) {
  return `http://127.0.0.1/mozoauth2/${createHash('sha1').update(geckoId).digest('hex')}`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = ['.env', '.env.local'].filter((f) => existsSync(f)).map((f) => parseEnv(readFileSync(f, 'utf8')));
  const env = Object.assign({}, ...files);
  if (!env.WXT_CHROMIUM_KEY) throw new Error('WXT_CHROMIUM_KEY is not set in .env');
  const id = extensionId(env.WXT_CHROMIUM_KEY);
  console.log(`Chromium extension ID:   ${id}`);
  console.log(`Chromium redirect URI:   https://${id}.chromiumapp.org/`);
  if (env.WXT_GECKO_ID) console.log(`Firefox redirect URI:    ${firefoxRedirect(env.WXT_GECKO_ID)}`);
  else console.log('Firefox redirect URI:    set WXT_GECKO_ID in .env to see it');
}
