// Renders promo/video.html to an MP4 with promo/music.wav as its soundtrack. Usage: see promo/README.md.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism, constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const { values: opt } = parseArgs({
  options: {
    height: { type: 'string', default: '1440' },
    fps: { type: 'string', default: '60' },
    workers: { type: 'string', default: String(Math.min(4, Math.max(1, availableParallelism() >> 2))) },
    encoder: { type: 'string', default: 'auto' },
    priority: { type: 'string', default: 'low' },
    codec: { type: 'string', default: 'h264' },
    start: { type: 'string', default: '0' },
    end: { type: 'string' },
    quality: { type: 'string', default: '16' },
    out: { type: 'string', default: 'promo/bookmark-sync-promo.mp4' },
    stills: { type: 'string' },
  },
});
const FPS = Number(opt.fps), HEIGHT = Number(opt.height), WORKERS = Number(opt.workers), Q = opt.quality;
// The page is laid out at 1920×1080 and drawn at a higher pixel density, so text stays sharp at any height.
const SCALE = HEIGHT / 1080;
const PAGE_URL = pathToFileURL(resolve('promo/video.html')).href;
// Windows hands a below-normal priority class down to child processes, so Chromium and ffmpeg yield to the desktop too.
if (opt.priority === 'low') setPriority(constants.priority.PRIORITY_BELOW_NORMAL);

const ffmpegLists = (flag) => spawnSync('ffmpeg', ['-hide_banner', flag], { encoding: 'utf8' }).stdout;
const tenBit = opt.codec === 'hevc';
const nvenc = `${tenBit ? 'hevc' : 'h264'}_nvenc`;
// GPU path: Chromium sends JPEG (2× cheaper than PNG), and decoding, conversion and encoding all stay on the GPU.
const gpu = opt.encoder === 'gpu' || (opt.encoder === 'auto' && ffmpegLists('-encoders').includes(` ${nvenc} `) && ffmpegLists('-decoders').includes(' mjpeg_cuvid ') && ffmpegLists('-filters').includes(' colorspace_cuda '));
// Without an explicit clip scale, the DevTools capture ignores the page's device scale factor and returns 1080p.
const clip = { x: 0, y: 0, width: 1920, height: 1080, scale: SCALE };
const CAPTURE = gpu ? { format: 'jpeg', quality: 100, optimizeForSpeed: true, clip } : { format: 'png', optimizeForSpeed: true, clip };

async function openPage() {
  const browser = await chromium.launch({ channel: 'chromium' });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: SCALE });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(PAGE_URL);
  await page.evaluate(() => window.ready);
  const cdp = await page.context().newCDPSession(page);
  // Playwright's screenshot() takes ~8× longer per 4K frame than this fast-compression PNG capture.
  const frame = async (t) => {
    await page.evaluate((t) => window.seek(t), t);
    const { data } = await cdp.send('Page.captureScreenshot', CAPTURE);
    return Buffer.from(data, 'base64');
  };
  return { browser, page, frame };
}

if (opt.stills) {
  const { browser, frame } = await openPage();
  mkdirSync('promo/stills', { recursive: true });
  for (const t of opt.stills.split(',').map(Number)) writeFileSync(`promo/stills/${t}.${CAPTURE.format}`, await frame(t));
  await browser.close();
  process.exit(0);
}

const input = gpu ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-c:v', 'mjpeg_cuvid'] : ['-c:v', 'png', '-threads', '0'];
const video = gpu
  ? ['-c:v', nvenc, '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-cq', Q, '-b:v', '0', '-maxrate', '150M', '-bufsize', '300M', '-spatial-aq', '1', '-temporal-aq', '1', '-bf', '3', '-b_ref_mode', 'middle']
  : ['-c:v', tenBit ? 'libx265' : 'libx264', '-preset', 'slow', '-crf', Q];
const profile = tenBit ? ['-profile:v', 'main10', '-tag:v', 'hvc1'] : ['-profile:v', 'high', '-level', HEIGHT > 1440 ? '5.2' : '5.1'];
// Colour tags go on the frames: as output options they make ffmpeg insert a CPU conversion after the CUDA filters.
// The JPEG frames are BT.601 YCbCr, hence smpte170m; the PNG path converts to BT.709 itself.
const filters = gpu
  ? `colorspace_cuda=range=tv,scale_cuda=format=${tenBit ? 'p010le' : 'nv12'},setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=smpte170m`
  : `scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=${tenBit ? 'yuv420p10le' : 'yuv420p'},setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709`;

const pages = await Promise.all(Array.from({ length: WORKERS }, openPage));
const duration = await pages[0].page.evaluate(() => window.DURATION);
const first = Math.round(Number(opt.start) * FPS);
const frames = Math.round(((opt.end ? Number(opt.end) * 1000 : duration) / 1000) * FPS);
console.log(`${Math.round(1920 * SCALE)}×${HEIGHT} at ${FPS} fps, ${frames - first} frames, ${WORKERS} workers, ${gpu ? 'GPU (NVDEC, CUDA, NVENC)' : 'CPU'} ${tenBit ? '10-bit HEVC' : 'H.264'}`);

const ffmpeg = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), ...input, '-i', '-', '-ss', opt.start, '-i', 'promo/music.wav', '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '256k', '-vf', filters, ...video, ...profile, '-shortest', '-movflags', '+faststart', opt.out], { stdio: ['pipe', 'inherit', 'inherit'] });
const done = new Promise((ok, fail) => ffmpeg.on('close', (code) => (code ? fail(new Error(`ffmpeg exited with ${code}`)) : ok())));

// Workers take interleaved frames; the writer feeds ffmpeg strictly in order, and workers stay a bounded distance ahead of it.
const ready = new Map();
let next = first;
let wake = () => {};
const AHEAD = WORKERS * 3;
const started = performance.now();
await Promise.all([
  ...pages.map(async ({ frame }, k) => {
    for (let i = first + k; i < frames; i += WORKERS) {
      while (i - next > AHEAD) await new Promise((r) => setTimeout(r, 5));
      ready.set(i, await frame((i * 1000) / FPS));
      wake();
    }
  }),
  (async () => {
    while (next < frames) {
      if (!ready.has(next)) {
        await new Promise((r) => (wake = r));
        continue;
      }
      const image = ready.get(next);
      ready.delete(next);
      if (!ffmpeg.stdin.write(image)) await new Promise((r) => ffmpeg.stdin.once('drain', r));
      next++;
      const n = next - first;
      if (n % 240 === 0 || next === frames) {
        const s = (performance.now() - started) / 1000;
        process.stdout.write(`\r${n}/${frames - first} frames, ${(n / s).toFixed(1)} fps, ${Math.round(((frames - next) * s) / n)} s left   `);
      }
    }
  })(),
]);
ffmpeg.stdin.end();
await done;
await Promise.all(pages.map((p) => p.browser.close()));
console.log(`\nwrote ${opt.out} in ${Math.round((performance.now() - started) / 1000)} s`);
