import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

const out = process.argv[2] ?? '.output/site';
const fromFiles = Object.assign({}, ...['.env.example', '.env', '.env.local'].filter((f) => existsSync(f)).map((f) => parseEnv(readFileSync(f, 'utf8'))));
const value = (name) => (process.env[name] ?? fromFiles[name] ?? '').trim();

const vars = {};
for (const name of Object.keys(fromFiles)) if (name.startsWith('WXT_')) vars[name.slice(4)] = value(name);
vars.STORE_URLS = [vars.CHROME_STORE_URL, vars.EDGE_STORE_URL, vars.FIREFOX_STORE_URL].some(Boolean) ? 'yes' : '';
vars.ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 10v11l-5 -3l-5 3v-11a3 3 0 0 1 3 -3h4a3 3 0 0 1 3 3" /><path d="M11 3h5a3 3 0 0 1 3 3v11" /></svg>';
if (!vars.SUPPORT_EMAIL && !vars.SOURCE_URL) console.warn('Warning: set WXT_SUPPORT_EMAIL or WXT_SOURCE_URL in .env, or the privacy policy has no contact.');

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function render(html) {
  let prev;
  do {
    prev = html;
    html = html.replace(/<!-- if (!?)(\w+) -->([\s\S]*?)<!-- end \1\2 -->/g, (_, not, name, body) => (Boolean(vars[name]) !== Boolean(not) ? body : ''));
  } while (html !== prev);
  return html.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (!(name in vars)) throw new Error(`site uses {{${name}}}, which isn't in .env`);
    return name === 'ICON' ? vars.ICON : escapeHtml(vars[name]);
  });
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync('site', out, { recursive: true });
copyFileSync('public/icon/128.png', join(out, 'icon.png'));
for (const file of readdirSync(out).filter((f) => f.endsWith('.html'))) {
  writeFileSync(join(out, file), render(readFileSync(join(out, file), 'utf8')));
}
console.log(`Site written to ${out}`);
