// node promo/music.mjs && node promo/render.mjs  → promo/bookmark-sync-promo.mp4
// node promo/render.mjs 1000,9000  → promo/stills/<ms>.png for review
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const FPS = 60;
const SCALE = 2; // 1920×1080 layout drawn at 2× gives 3840×2160
const stills = process.argv[2]?.split(',').map(Number);

const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: SCALE });
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(pathToFileURL(resolve('promo/video.html')).href);
await page.evaluate(() => window.ready);
const duration = await page.evaluate(() => window.DURATION);

if (stills) {
  mkdirSync('promo/stills', { recursive: true });
  for (const t of stills) {
    await page.evaluate((t) => window.seek(t), t);
    await page.screenshot({ path: `promo/stills/${t}.png` });
  }
} else {
  const ffmpeg = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-', '-i', 'promo/music.wav', '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-c:v', 'libx264', '-preset', 'slow', '-crf', '15', '-profile:v', 'high', '-level', '5.2', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', 'promo/bookmark-sync-promo.mp4'], { stdio: ['pipe', 'inherit', 'inherit'] });
  const frames = Math.round((duration / 1000) * FPS);
  for (let i = 0; i < frames; i++) {
    await page.evaluate((t) => window.seek(t), (i * 1000) / FPS);
    const png = await page.screenshot();
    if (!ffmpeg.stdin.write(png)) await new Promise((r) => ffmpeg.stdin.once('drain', r));
    if (i % 300 === 0) console.log(`frame ${i}/${frames}`);
  }
  ffmpeg.stdin.end();
  await new Promise((r) => ffmpeg.on('close', r));
}
await browser.close();
