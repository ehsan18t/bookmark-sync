# Promo video

The 40-second demo video is built from code, so it can be changed and rendered again at any time.

| File | What it is |
|---|---|
| `video.html` | The animated scenes, as one timeline. Open it in a browser with `?t=15000` to see the frame at 15 seconds. |
| `music.mjs` | The soundtrack and sound effects, synthesized into `music.wav`. Its event times match `video.html`. |
| `render.mjs` | Renders `video.html` frame by frame and encodes it with the soundtrack into `bookmark-sync-promo.mp4`. |
| `capture.mjs` | Takes the real extension screenshots in `shots/`, and the click positions in `shots/boxes.json`. |

The rendered video and `music.wav` are not committed. Render them yourself.

## Render

```bash
pnpm promo
```

This writes `promo/bookmark-sync-promo.mp4`: 2560×1440, 60 fps, H.264, which every browser plays. If Playwright's browsers live outside the default folder, set `PLAYWRIGHT_BROWSERS_PATH` first.

Options go after `--`, for example `pnpm promo -- --height 2160 --start 12 --end 20`:

| Option | Default | What it does |
|---|---|---|
| `--height` | `1440` | Output height: `1440` is 1440p, `2160` is 4K, `1080` is 1080p. |
| `--fps` | `60` | Frame rate. |
| `--codec` | `h264` | `h264` (8-bit, plays in every browser) or `hevc` (10-bit, smaller, but Firefox and many Windows browsers can't play it). |
| `--quality` | `16` | Lower is better and larger. 16 to 20 is a good range. |
| `--start`, `--end` | whole video | Render only part, in seconds. |
| `--encoder` | `auto` | `gpu` or `cpu`. `auto` uses the NVIDIA GPU when ffmpeg supports it. |
| `--workers` | `4` | Browser processes capturing frames in parallel. More is faster and uses more CPU and memory. |
| `--priority` | `low` | `low` keeps the computer responsive while rendering. `normal` renders a little faster. |
| `--out` | `promo/bookmark-sync-promo.mp4` | Output file. |
| `--stills` | | Instead of a video, save single frames, for example `--stills 5000,13800`, into `promo/stills/`. |

On an NVIDIA GPU the frames are decoded, converted and encoded on the GPU (NVDEC, CUDA filters, NVENC). Without one, the same video is encoded on the CPU, which is slower.

## Make a copy for GitHub

GitHub plays a video in a README only when it is uploaded through its editor, and the upload limit is 100 MB on paid accounts (10 MB on free ones). The render above is larger, so make a two-pass H.264 copy of about 95 MB that looks the same:

```bash
ffmpeg -y -i promo/bookmark-sync-promo.mp4 -c:v libx264 -preset slow -tune animation -b:v 18500k -maxrate 40M -bufsize 60M -pix_fmt yuv420p -pass 1 -an -f mp4 NUL
```

```bash
ffmpeg -y -i promo/bookmark-sync-promo.mp4 -c:v libx264 -preset slow -tune animation -b:v 18500k -maxrate 40M -bufsize 60M -pix_fmt yuv420p -pass 2 -c:a aac -b:a 256k -movflags +faststart promo/bookmark-sync-promo-web.mp4
```

On macOS and Linux, write `/dev/null` instead of `NUL`. Drag `promo/bookmark-sync-promo-web.mp4` into the README editor on GitHub and use the link it gives.

To change only the music, edit `music.mjs` and run `node promo/music.mjs`, then render again. If you move a moment in `video.html`, move its sound in `music.mjs` too.

## Retake the screenshots

```bash
pnpm promo:capture
```

This builds a test copy of the extension, runs it in two Chromium profiles syncing through a local WebDAV server, and saves the screens to `shots/`. If the pages' layout changed, copy the new numbers from `shots/boxes.json` into `BOXES` in `video.html` so the cursor still clicks the right places.

## Background design

The background is flat colour with thin lines and small dots, with no large soft gradients. Dark, smooth gradients break into visible steps (banding) when a video is compressed, especially at the low bitrates of web uploads. Keep new backgrounds flat for the same reason.
