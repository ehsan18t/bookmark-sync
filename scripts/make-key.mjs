import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { extensionId } from './extension-id.mjs';

const out = '.keys/extension-key.pem';
if (existsSync(out) && !process.argv.includes('--force')) throw new Error(`${out} already exists. Pass --force to replace it, which changes the extension ID.`);
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
mkdirSync('.keys', { recursive: true });
writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }));
console.log(`Private key saved to ${out}. Keep a copy somewhere safe.\n`);
console.log('Put this line in .env:\n');
console.log(`WXT_CHROMIUM_KEY=${key}\n`);
console.log(`The extension ID becomes ${extensionId(key)}.`);
