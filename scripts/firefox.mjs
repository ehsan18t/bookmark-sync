// Signs the Firefox build with Mozilla: `unlisted` saves a signed .xpi, `listed` submits it to addons.mozilla.org.
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import webExt from 'web-ext';

const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: { notes: { type: 'string' } } });
const channel = positionals[0];
if (channel !== 'unlisted' && channel !== 'listed') throw new Error('Usage: node scripts/firefox.mjs unlisted|listed [--notes "What changed"]');

const env = Object.assign({}, ...['.env', '.env.local'].filter((f) => existsSync(f)).map((f) => parseEnv(readFileSync(f, 'utf8'))));
const apiKey = env.WEB_EXT_API_KEY?.trim();
const apiSecret = env.WEB_EXT_API_SECRET?.trim();
if (!apiKey || !apiSecret) throw new Error('Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET in .env. See docs/firefox-publishing.md.');

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const sourceDir = '.output/firefox-mv3';
const built = existsSync(`${sourceDir}/manifest.json`) && JSON.parse(readFileSync(`${sourceDir}/manifest.json`, 'utf8')).version;
if (built !== version) throw new Error(`The Firefox build is ${built || 'missing'}, but package.json says ${version}. Run pnpm zip first.`);
const sources = `.output/bookmark-sync-${version}-sources.zip`;

const tmp = mkdtempSync(join(tmpdir(), 'bsync-amo-'));
try {
  let amoMetadata;
  if (channel === 'listed') {
    if (!existsSync(sources)) throw new Error(`${sources} is missing. Run pnpm zip first.`);
    // Reviewers rebuild from the source zip, which needs the same settings. Only Mozilla's reviewers see these notes.
    const settings = Object.entries(env)
      .filter(([k]) => k.startsWith('WXT_'))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const notes = `Build with Node 24 and pnpm 10: pnpm install, then pnpm zip. The Firefox package is .output/bookmark-sync-${version}-firefox.zip.

The build reads its settings from a .env file in the project root (.env.example lists them). Create .env with the values below to reproduce this build.

To test, choose Google Drive or any WebDAV server. For a local WebDAV server, run rclone serve webdav REMOTE: --addr 127.0.0.1:8080 --user me --pass secret and use http://127.0.0.1:8080/ with user "me" and password "secret".

Bookmarks are sent only to the storage the user chooses (their own Google Drive app folder or their own WebDAV server), which is why bookmarksInfo is declared. Nothing is sent to the developer, and there are no analytics.

.env used for this build:
${settings}`;
    amoMetadata = join(tmp, 'metadata.json');
    writeFileSync(amoMetadata, JSON.stringify({ version: { approval_notes: notes, ...(opt.notes ? { release_notes: { 'en-US': opt.notes } } : {}) } }));
  }

  const artifactsDir = join(tmp, 'signed');
  const result = await webExt.cmd.sign(
    {
      sourceDir,
      artifactsDir,
      apiKey,
      apiSecret,
      channel,
      amoMetadata,
      uploadSourceCode: channel === 'listed' ? sources : undefined,
      // A listed version waits for a human review, which takes days.
      approvalTimeout: channel === 'listed' ? 0 : undefined,
    },
    { shouldExitProgram: false },
  );
  if (channel === 'unlisted') {
    const [xpi] = existsSync(artifactsDir) ? readdirSync(artifactsDir).filter((f) => f.endsWith('.xpi')) : [];
    if (!xpi) throw new Error(`Mozilla didn't return a signed file: ${JSON.stringify(result)}`);
    const out = `.output/bookmark-sync-${version}-firefox.xpi`;
    copyFileSync(join(artifactsDir, xpi), out);
    console.log(`\nSigned: ${out}`);
  } else {
    console.log(`\nSubmitted ${version} for review. Mozilla emails you when it's approved or needs changes.`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
