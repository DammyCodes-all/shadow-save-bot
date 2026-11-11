# Slideshow Video Export — Full Implementation Plan

## 1. Goal

Add an on-demand **“Make video”** action for:

- TikTok photo/slideshow posts
- Instagram carousel posts

The existing image delivery stays exactly as it is. After the images are sent, the bot offers a button that renders an MP4 and sends it back.

Two rendering styles:

| Source | Video style | Audio |
| --- | --- | --- |
| TikTok slideshow | Photos shown in sequence, timed to the original sound | TikTok `music` URL |
| Instagram carousel | One continuous vertical auto-scroll, 2 seconds per slide, smooth | None by default (Instagram carousel payload has no audio) |

Output: H.264 + AAC MP4, `yuv420p`, `+faststart`, 720×1280 by default, under Telegram’s 50 MB bot-upload limit.

---

## 2. What already exists

- `DownloadService` returns `MediaInfo` with `platform`, `isSlideshow`, `images`, `music`, `title`, `author`.
- TikTok provider already captures `data.music` and `data.images`; it does **not** capture `music_info.duration`.
- Instagram provider already returns image URLs and caption/username.
- `BotUpdate.onText` sends slideshow images in batches of 10, then optionally sends a “🎧 Get audio” button.
- `BotUpdate` already has a short-lived in-memory request-token pattern for audio (`audioRequests` + `audio:` callback).
- The app currently avoids writing downloaded media to disk. Video export will temporarily write files under the OS temp directory and delete them after upload.

---

## 3. User experience

### 3.1 Slideshow flow

1. User sends a TikTok slideshow or Instagram carousel link.
2. Bot sends the images exactly as today.
3. After the last image batch, bot sends one small control message:
   - TikTok: **“🎬 Want this slideshow as a video with the original sound?”**
   - Instagram: **“🎬 Want this carousel as an auto-scroll video?”**
4. Inline buttons:
   - `🎬 Make video`
   - `🎧 Get audio` (TikTok only, if music exists)
5. User taps **Make video**:
   - Callback is acknowledged immediately.
   - Bot shows `🎬 Rendering your video…` and keeps the “uploading video” chat action alive.
   - Render is queued; max 2 concurrent renders by default.
   - Bot uploads the MP4 with caption and share/audio buttons.
   - Temporary files are deleted.

### 3.2 Rules

- Only offer video when `images.length >= 2`.
- Only TikTok and Instagram; not Twitter/X.
- Single-image posts keep current behavior (photo + optional audio/share).
- If ffmpeg is unavailable or video export is disabled, hide the video button.
- The request token is tied to the Telegram user; another user cannot use it.
- Tokens expire after 2 hours (same spirit as audio requests).
- Per-user cooldown (default 30 s) and one active render per user.

### 3.3 Failure messages

- Token expired: “This slideshow expired — send the link again to make a video.”
- Queue full/busy: “Lots of videos are rendering right now. Try again in a minute.”
- Render failed: “Couldn’t build the video. The images or audio may have expired. Try resending the link.”
- Output too large after fallback: reuse the existing “file too large” message.
- ffmpeg unavailable: “Video export is temporarily unavailable.”

---

## 4. Architecture

New feature module:

```text
src/video/
  video.module.ts
  video.types.ts
  video-render.service.ts        # orchestrator
  video-render-queue.ts          # concurrency + per-user guard
  video-request.store.ts         # callback tokens -> slideshow snapshot
  ffmpeg.runner.ts               # spawn, timeout, duration probe, availability
  slideshow.downloader.ts        # safe download + byte limits + retries
  image.normalizer.ts            # sharp normalization + Instagram strip
  slideshow.timing.ts            # pure timing math
  slideshow.args.ts              # pure ffmpeg argument builders
```

`BotModule` imports `VideoModule`. `VideoModule` exports `VideoRenderService` and `VideoRequestStore`.

### 4.1 High-level flow

```text
BotUpdate.onText
  -> DownloadService.getMediaInfo
  -> send images (unchanged)
  -> VideoRequestStore.create({ userId, platform, images, music, ... })
  -> send control message with video token

BotUpdate.onSlideshowVideoAction
  -> answerCbQuery immediately
  -> VideoRenderQueue.run(userId, job)
       -> create temp job dir
       -> download images (+ music)
       -> normalize images with sharp
       -> compute timing
       -> build ffmpeg args
       -> run ffmpeg
       -> size guard / optional small re-encode
       -> return file path + metadata + cleanup()
  -> replyWithVideo({ source: path })
  -> finally cleanup()
```

### 4.2 Why split it this way

- Timing math and ffmpeg args are pure and unit-testable without ffmpeg.
- Downloading, normalization, and encoding are separate failure domains.
- The queue is the only place that controls CPU; one queue for all video renders.
- `BotUpdate` only gets the button handler, not the rendering internals.

---

## 5. Data model changes

### 5.1 `MediaInfo`

Add optional fields:

```ts
musicDurationSec?: number | null;
musicTitle?: string | null;
```

### 5.2 TikWM response

```ts
data?: {
  // existing...
  music_info?: {
    title?: string;
    duration?: number;
  };
};
```

TikTok provider maps:

```ts
musicDurationSec: data.music_info?.duration ?? null,
musicTitle: data.music_info?.title ?? null,
```

Why: TikTok photo posts return `duration: 0`, and `play` may point at the audio. `music_info.duration` is the reliable audio length. If it is missing/zero, fall back to probing the downloaded audio with ffmpeg.

Instagram sets both fields to `null`. If a carousel mixes images and videos, we export the image slides only; using the video’s audio is a future enhancement.

---

## 6. Rendering pipeline

### 6.1 Temp workspace

- Root: `path.join(os.tmpdir(), 'shadow-save-video')` or `VIDEO_TEMP_DIR`.
- Each job: `fs.mkdtemp(path.join(root, 'job-'))`.
- Download to `img-000.jpg`, `img-001.jpg`, `music.mp3`, `concat.txt`, `strip.jpg`, `out.mp4`.
- `finally` deletes the job directory after Telegram upload.
- Startup sweep removes orphaned job dirs older than 2 hours.
- Periodic sweep every 30 minutes (unref timer).

### 6.2 Download

- Only `https:` URLs.
- Resolve hostname and reject localhost/private/link-local IP ranges (SSRF guard).
- Follow at most 3 redirects, re-validating each hop.
- Per-image max: 12 MB; per-job total max: 150 MB; audio max: 25 MB.
- Timeout: 20 s per request.
- Retry once on 429/5xx/network error with short jitter.
- Stream to `.part`, count bytes as they arrive, rename on success, delete on failure.
- Browser-like `User-Agent`; no cookies.
- Limit image downloads to 4 concurrent.
- If one image fails after retry:
  - Skip it if at least 2 images remain; log a warning.
  - Otherwise fail the render.
- Truncate to platform caps: TikTok 35 images, Instagram 20.

### 6.3 Normalize with sharp

Sharp is the right tool here: libvips is fast, low-RAM, and prebuilt for Linux/macOS/Alpine musl.

Settings:

```ts
sharp.cache(false);
sharp.concurrency(1);
```

Per image:

```ts
await sharp(input, {
  failOn: 'none',
  limitInputPixels: 50_000_000,
  sequentialRead: true,
})
  .rotate() // respect EXIF orientation
  .resize(720, 1280, {
    fit: 'contain',
    background: '#0B0B0F',
    withoutEnlargement: false,
  })
  .jpeg({ quality: 86, mozjpeg: true })
  .toFile(output);
```

Why normalize first:

- Concat demuxer requires consistent dimensions.
- Avoids ffmpeg re-initializing filters between different image sizes.
- Keeps ffmpeg memory and CPU low.
- Guarantees even dimensions for H.264.

For Instagram, build one tall strip:

```ts
const height = 1280 * images.length;
await sharp({
  create: {
    width: 720,
    height,
    channels: 3,
    background: '#0B0B0F',
  },
})
  .composite(images.map((input, i) => ({
    input,
    left: 0,
    top: i * 1280,
  })))
  .jpeg({ quality: 86, mozjpeg: true })
  .toFile(stripPath);
```

At 720p, 20 slides = 720×25,600 JPEG (~55 MB raw), safe. If 1080p is enabled, 20 slides = 1080×38,400; still under JPEG’s 65,535 px limit, but higher RAM; keep concurrency at 1 in that case.

### 6.4 Timing

#### TikTok

```ts
const target = audioDurationSec > 0
  ? audioDurationSec
  : imageCount * 2.5;

const perSlide = clamp(target / imageCount, 1.5, 3.0);
const total = Math.min(perSlide * imageCount, 60);
const finalPerSlide = total / imageCount;
```

- If the sound is 20 s and there are 10 images: 2 s each, 20 s total.
- If the sound is 60 s and there are 10 images: capped at 4 s each, 40 s total, audio trimmed with fade.
- If the sound is 5 s and there are 10 images: 1.5 s each, 15 s total, audio looped.
- If no sound: 2.5 s per image.
- Hard cap: 60 s (`VIDEO_MAX_DURATION_SEC`).

This mirrors the normal TikTok photo-post feel: photos follow the sound, with sensible minimum/maximum on-screen time. TikTok does not expose per-slide beat timestamps in the TikWM payload, so this is an even distribution, not beat detection. That keeps the render cheap and predictable; true beat sync would require audio analysis and is out of scope for v1.

#### Instagram scroll

- `secondsPerSlide = 2.0` (configurable).
- `holdStart = 0.5 s`.
- `total = holdStart + imageCount * secondsPerSlide` (capped at 60 s; reduce `secondsPerSlide` if needed).
- Scroll speed = `outputHeight / secondsPerSlide` px/s.
  - 720p: `1280 / 2 = 640 px/s`.
- Scroll starts after the 0.5 s hold and holds the last slide for 2 s.

For 10 slides: total 20.5 s, scroll from t=0.5 to t=18.5, then hold.

### 6.5 FFmpeg commands

All commands use:

- `-preset veryfast`
- `-crf 26` (modest quality/size)
- `-profile:v main -level 4.0`
- `-pix_fmt yuv420p`
- `-movflags +faststart`
- `-threads` limited by the queue
- `-nostdin`, `-hide_banner`, `-loglevel error`

#### TikTok with audio

```bash
ffmpeg -y -hide_banner -loglevel error -nostdin \
  -f concat -safe 0 -i concat.txt \
  -stream_loop -1 -i music.mp3 \
  -vf "fps=30,format=yuv420p,setsar=1" \
  -c:v libx264 -preset veryfast -crf 26 -profile:v main -level 4.0 \
  -threads 2 -pix_fmt yuv420p \
  -c:a aac -b:a 96k -ar 44100 -ac 2 \
  -map 0:v:0 -map 1:a:0 \
  -af "afade=t=in:st=0:d=0.25,afade=t=out:st=24.5:d=0.5" \
  -t 25.0 -movflags +faststart out.mp4
```

No audio: replace the audio input/map/`-c:a`/`-af` with `-an`.

`concat.txt`:

```text
file '/tmp/shadow-save-video/job-xxx/img-000.jpg'
duration 2.50
file '/tmp/shadow-save-video/job-xxx/img-001.jpg'
duration 2.50
...
file '/tmp/shadow-save-video/job-xxx/img-009.jpg'
duration 2.50
file '/tmp/shadow-save-video/job-xxx/img-009.jpg'
```

The last image is repeated because the concat demuxer ignores the final duration; `-t` trims any extra frame.

#### Instagram auto-scroll

```bash
ffmpeg -y -hide_banner -loglevel error -nostdin \
  -loop 1 -framerate 30 -i strip.jpg \
  -vf "crop=720:1280:0:'min(11520,max(0,(t-0.5)*640))',fps=30,format=yuv420p,setsar=1" \
  -c:v libx264 -preset veryfast -crf 26 -profile:v main -level 4.0 \
  -threads 2 -pix_fmt yuv420p \
  -an -t 20.5 -movflags +faststart out.mp4
```

Numbers in the expression:

- `11520 = stripHeight - outputHeight` (10 slides).
- `640 = outputHeight / 2 s`.
- `20.5 = 0.5 + 10 * 2`.

If audio exists (future/mixed carousel), add the same audio input/map/fade options and trim to total.

#### Why hard cuts for TikTok

TikTok photo mode is image-to-image; hard cuts with audio timing feel natural and cost almost nothing. Crossfades/Ken Burns are optional later; they add CPU and complexity. Instagram gets the continuous scroll effect because that is the requested carousel behavior.

### 6.6 Size guard

- After encode, `fs.stat`.
- If `size > 49 MB`, re-encode once:
  - `-crf 32`
  - `-vf scale=540:960` (keep aspect)
  - replace original
- If still > 49 MB, throw `VIDEO_TOO_LARGE`.

At 720p/CRF 26/60 s, expected size is roughly 10–25 MB, so this is only a safety net.

### 6.7 Output metadata

- Width: 720, height: 1280.
- Duration: rounded to integer for Telegram.
- `supports_streaming: true`.
- Filename: `shadowsave-<platform>-<token>.mp4`.
- Caption:
  - TikTok: `🎬 TikTok slideshow · original sound`
  - Instagram: `🎬 Instagram carousel · auto-scroll · silent`
  - Plus title/author, truncated to fit Telegram’s 1024-character caption limit.
- Reuse `getMediaReplyMarkup(audioCallback)` for share + audio buttons.

---

## 7. Queue, CPU, and memory controls

- `VIDEO_MAX_CONCURRENCY` default:
  - `Math.max(1, Math.min(2, Math.floor(cpus / 2)))`.
  - 1 vCPU → 1; 2 vCPU → 1; 4+ vCPU → 2.
- `VIDEO_MAX_QUEUE` default 20; when full, reject quickly.
- One active render per user.
- Optional 30 s per-user cooldown after a successful render.
- ffmpeg threads per job:
  - `Math.max(1, Math.min(4, Math.floor(cpus / maxConcurrency)))`.
  - 8 vCPU, 2 jobs → 4 threads each.
- `sharp.concurrency(1)` and `sharp.cache(false)`.
- Downloads are streamed; no image buffers held in memory.
- ffmpeg processes are tracked and killed on timeout/shutdown.
- Optionally lower process priority with `os.setPriority(pid, 10)` (catch failures).

Expected resource use per job:

- RAM: roughly 100–250 MB at 720p.
- CPU: a 20 s slideshow at `veryfast` should encode in a few seconds on a normal VPS.
- Disk: usually 10–40 MB per job, deleted immediately.

---

## 8. Bot integration details

### 8.1 `VideoRequestStore`

```ts
type VideoRequest = {
  userId: number;
  platform: 'tiktok' | 'instagram';
  url: string;
  images: string[];
  music: string | null;
  musicDurationSec: number | null;
  musicTitle: string | null;
  title: string;
  author: string;
  createdAt: number;
};
```

- Token: `randomBytes(4).toString('hex')` (8 chars).
- TTL: 2 hours, `setTimeout(...).unref()`.
- Max entries: 500; evict oldest when full.
- `get(token)` returns null if expired.
- Callback verifies `request.userId === ctx.from.id`.

### 8.2 `BotService` additions

- `getSlideshowActionsMessage(platform)`.
- `getSlideshowActionsMarkup(videoToken, audioCallbackData?)`.
- `getSlideshowVideoCaption(...)`.
- `getVideoRenderingMessage()`.
- `getVideoExpiredMessage()`.
- `getVideoBusyMessage()`.
- `getVideoFailedMessage()`.
- `getVideoUnavailableMessage()`.

### 8.3 `BotUpdate` changes

In the images branch, after all batches are sent:

```ts
const videoToken =
  mediaInfo.images.length >= 2 &&
  (mediaInfo.platform === 'tiktok' || mediaInfo.platform === 'instagram') &&
  this.videoRenderService.isAvailable()
    ? this.videoRequestStore.create({ ... })
    : null;

if (videoToken || audioCallback) {
  await ctx.reply(
    this.botService.getSlideshowActionsMessage(mediaInfo.platform),
    this.botService.getSlideshowActionsMarkup(videoToken, audioCallback) as never,
  );
}
```

New action:

```ts
@Action(/^slideshow:video:(.+)$/)
async onSlideshowVideoAction(@Ctx() ctx: Context) { ... }
```

Handler steps:

1. Banned check (reuse `rejectIfBanned`).
2. Parse token; verify owner.
3. If unavailable, answer callback and return.
4. `answerCbQuery('🎬 Rendering…')` immediately.
5. Run queue/render.
6. Send status message and start `sendChatAction('upload_video')` heartbeat every 4 s.
7. Upload MP4 via `replyWithVideo({ source: filePath, filename }, { caption, width, height, duration, supports_streaming: true, reply_markup })`.
8. Record `video_export` event.
9. Delete status message and temp file in `finally`.

### 8.4 Analytics

Record:

```ts
this.userService.recordEvent({
  userTelegramId: ctx.from.id,
  platform,
  mediaType: 'video_export',
  url,
  success: true/false,
});
```

Add `video_export` → “Video export” in `getStatsMessage`'s media-type label. This tracks feature adoption without confusing it with normal video downloads. Decide whether to also increment `totalDownloads`; recommendation: don’t, because the same link already counted an image download.

### 8.5 Welcome text

Add one line: “For slideshows, tap **🎬 Make video** to get an MP4.”

---

## 9. Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `VIDEO_EXPORT_ENABLED` | `true` | Feature flag |
| `FFMPEG_PATH` | `ffmpeg` on PATH | ffmpeg binary override |
| `VIDEO_WIDTH` | `720` | Output width |
| `VIDEO_HEIGHT` | `1280` | Output height |
| `VIDEO_FPS` | `30` | Output frame rate |
| `VIDEO_CRF` | `26` | x264 quality |
| `VIDEO_PRESET` | `superfast` | x264 preset |
| `VIDEO_MAX_DURATION_SEC` | `60` | Hard duration cap |
| `VIDEO_MAX_CONCURRENCY` | CPU-based | Simultaneous renders |
| `VIDEO_MAX_QUEUE` | `20` | Pending renders |
| `VIDEO_TIKTOK_MIN_SLIDE_SEC` | `1.5` | TikTok minimum per image |
| `VIDEO_TIKTOK_MAX_SLIDE_SEC` | `3.0` | TikTok maximum per image |
| `VIDEO_IG_SECONDS_PER_SLIDE` | `2.0` | Instagram scroll speed |
| `VIDEO_IG_HOLD_START_SEC` | `0.5` | Instagram initial hold |
| `VIDEO_MAX_IMAGE_BYTES` | `12582912` | 12 MB per image |
| `VIDEO_MAX_AUDIO_BYTES` | `26214400` | 25 MB audio |
| `VIDEO_MAX_JOB_BYTES` | `157286400` | 150 MB per job |
| `VIDEO_DOWNLOAD_TIMEOUT_MS` | `20000` | Per-request timeout |
| `VIDEO_RENDER_TIMEOUT_MS` | `120000` | ffmpeg timeout |
| `VIDEO_TEMP_DIR` | OS temp | Temp workspace |
| `VIDEO_USER_COOLDOWN_SEC` | `30` | Per-user cooldown |

Add parsing/validation with sensible defaults in `src/config/env.validation.ts`. Invalid numbers should fail fast or fall back to defaults with a warning; prefer fail fast for malformed explicit values.

---

## 10. Docker and deployment

- Add ffmpeg to the runtime image:

```dockerfile
FROM node:22-alpine AS runtime
RUN apk add --no-cache ffmpeg
ENV FFMPEG_PATH=/usr/bin/ffmpeg
```

- Add `sharp` to dependencies. Sharp ships prebuilt libvips binaries for Alpine musl; verify during the Docker build.
- No `ffmpeg-static`, `fluent-ffmpeg`, or `ffprobe-static` needed.
  - `ffmpeg-static` can be a local-dev convenience, but it duplicates the binary in production; system ffmpeg is preferred.
- The app must still boot if ffmpeg is missing: log a warning, disable the video button, keep image downloads working.
- Video export needs a persistent process with CPU; it is not suitable for serverless/edge deployment.
- Temp disk should have at least a few hundred MB free; add a deployment note.

---

## 11. Security and cleanup

- SSRF guard on every download URL and redirect hop.
- Only `https:`, ports 443 (or default), no private IPs.
- Enforce byte limits while streaming, not only `Content-Length`.
- Never use remote filenames for local paths; use `img-000.jpg`.
- Pass all paths as argv; no shell interpolation.
- Escape single quotes when writing concat list paths.
- Sanitize log output: log host/platform/counts, not full signed URLs.
- Delete job directories in `finally`.
- Sweep stale directories at startup and periodically.
- On module destroy: kill active ffmpeg children, reject queued jobs, remove temp root.

---

## 12. Testing

### Unit tests

- `slideshow.timing.spec.ts`
  - 5/10/35 images with 5/20/60/120 s audio.
  - no audio fallback.
  - min/max slide clamp.
  - 60 s cap.
  - Instagram total and scroll speed.
- `slideshow.args.spec.ts`
  - TikTok with/without audio.
  - `-stream_loop -1` when audio is shorter.
  - `-an` when silent.
  - Instagram crop expression values.
  - preset/CRF/fps/maps.
- `video-request.store.spec.ts`
  - create/get, expiry, max-entry eviction, owner mismatch.
- `video-render-queue.spec.ts`
  - concurrency limit, queue full, per-user guard, slot release on error.
- `slideshow.downloader.spec.ts`
  - rejects private hosts, enforces byte limit, retries 5xx, deletes partial file.
- Provider mapping test for `music_info.duration` / `music_info.title`.

### Integration tests (optional, gated on ffmpeg)

- Generate 3 solid-color JPEGs and a 6 s sine-wave MP3 locally.
- Run the composer directly (no network).
- Assert output exists, has video + audio streams, expected duration ±0.5 s, expected dimensions.
- Run the Instagram strip path and assert output dimensions.
- Skip automatically if ffmpeg is unavailable.

### Manual QA

- TikTok 3, 10, 35 images; with and without music.
- Instagram 2, 10, 20 images.
- Verify audio sync and fade; no clicks at loop seam.
- Verify smooth scroll, 2 s per slide, no cropping/stretching.
- Verify video plays on iOS, Android, and Telegram Desktop.
- Verify file size < 50 MB and fallback works with an artificially low limit.
- Verify expired token, double-tap, banned user, three concurrent users.
- Verify temp directory is empty after success and failure.
- Verify image-only flow is unchanged.
- Verify no ffmpeg → button hidden, bot still works.

### Commands

```bash
pnpm lint
pnpm build
pnpm test
```

---

## 13. Implementation phases and estimate

| Phase | Work | Estimate |
| --- | --- | --- |
| 0. Spike | Prototype both ffmpeg commands with sample images/audio; measure time, CPU, size | 0.5–1 day |
| 1. Core | `FfmpegRunner`, downloader, sharp normalizer, timing, args, orchestrator | 2–3 days |
| 2. Bot UX | Request store, button, callback handler, messages, event recording | 1–1.5 days |
| 3. Hardening | Queue, cooldown, SSRF guard, size fallback, timeouts, cleanup | 1–1.5 days |
| 4. Tests/docs | Unit tests, integration test, Docker, README, QA | 1–1.5 days |

Total: roughly **5–7 developer days**. The ffmpeg spike is worth doing first because it validates output quality and encode time on the actual deployment host.

---

## 14. Acceptance criteria

- TikTok slideshow with 2+ images shows a **Make video** button.
- Result is an MP4 with the images in order and the original TikTok audio.
- Duration follows the timing rules; audio is trimmed or looped cleanly with a fade.
- Instagram carousel with 2+ images shows a **Make video** button.
- Result is a 720×1280 vertical MP4 that scrolls smoothly at 2 s per slide.
- Instagram output is silent unless source audio is explicitly added later; caption says so.
- Both outputs are H.264/AAC, `yuv420p`, `+faststart`, and under 50 MB.
- Existing image delivery, audio button, Twitter/X behavior, reports, and stats still work.
- Max 2 concurrent renders by default; queue rejects gracefully when full.
- Temp files are always deleted; no media is retained after upload.
- If ffmpeg is missing or the feature flag is off, the bot behaves exactly as before.
- `pnpm lint`, `pnpm build`, and `pnpm test` pass.

---

## 15. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| ffmpeg/Sharp native issues on Alpine | Use system ffmpeg and prebuilt sharp; verify in Docker build; disable feature gracefully if missing |
| TikTok CDN URLs expire before tap | Render immediately; 2 h token TTL; clear “resend link” error |
| TikTok sound is longer than the post | Cap at 60 s and fade; document limitation |
| Instagram carousel has no audio | Silent by default; say so in caption; music picker is a future feature |
| CPU spikes | Global queue, thread cap, per-user cooldown, 720p default |
| Telegram 50 MB limit | 60 s cap, CRF 26, 720p default, automatic 540p/CRF 32 fallback |
| IG strip uses too much RAM at 1080p | 720p default; cap 20 slides; concurrency 1 for 1080p |
| Disk leak on crash | Startup + periodic sweep; `finally` cleanup |
| Callback token abuse | Owner check, TTL, max entries, banned check |
| Last image flashes/extra frame | Repeat last concat entry and trim with `-t` |
| Upload timeout on slow hosts | Keep files small; send chat action heartbeat; log upload failures |

---

## 16. Open decisions (recommended defaults in bold)

1. **720×1280 default**, with `VIDEO_WIDTH`/`VIDEO_HEIGHT` for 1080p. 720p keeps CPU and upload size low.
2. **Instagram silent by default.** The carousel payload has no audio. A music picker/default track is a separate feature.
3. **Hard cuts for TikTok**, continuous scroll for Instagram. Crossfades/Ken Burns can be added later.
4. **On-demand button**, not automatic video for every slideshow. Avoids doubling work and bandwidth.
5. **No finished-file cache in v1.** Add an LRU temp cache only if repeat renders become common.
6. **No `/video` command in v1.** The button is enough; a command can be added later.
7. **60 s maximum duration.** Keeps files small and renders fast.

---

## 17. Documentation updates

- README features: slideshow video export.
- README architecture: `VideoModule`, renderer, queue.
- README data model: `musicDurationSec`, `musicTitle`.
- README environment table: new variables.
- README setup: install ffmpeg locally; Docker includes it.
- README limitations: Instagram silent, TikTok sound duration approximation, 60 s cap, 50 MB limit.
- Replace “The app does not write downloaded media to disk” with a qualified statement about temporary video-export files.
- Add a short “How video export works” section with the two styles.
