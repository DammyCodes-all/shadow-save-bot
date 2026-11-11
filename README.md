# Shadow Save Bot

Built with 💜 by aluminate

Shadow Save Bot is a NestJS Telegram bot with provider-based multi-social media support. It currently supports TikTok, Twitter/X, and Instagram media extraction and sends content directly in Telegram. Images and videos are streamed without saving files to disk, except for the optional slideshow video export, which temporarily uses the OS temp directory during rendering and deletes files after upload.

It uses:

- NestJS for application structure and dependency injection
- `nestjs-telegraf` for Telegram bot integration
- Provider-based social media integration (extensible by platform)
- TikWM for TikTok media extraction
- FixTweet API for Twitter/X media extraction
- `instagram-url-direct` for Instagram media extraction
- `cache-manager` for in-memory caching with automatic expiration
- Telegram media groups for slideshow responses

## What it does

The bot accepts supported social media URLs in Telegram and responds in one of three ways:

- If the link is valid and points to a video, it sends the video back to the chat.
- For Twitter/X videos, it sends the highest-quality MP4 variant first and retries lower-quality fallbacks if Telegram rejects the initial file.
- If the link is a slideshow, it sends the images as Telegram media groups.
- For TikTok slideshows and Instagram carousels with 2+ images — plus single-image TikTok posts that have music — it can optionally render a slideshow MP4 when the user taps the inline "🎬 Make video" button. Images remain the default.
- If the link is unsupported or provider processing fails, it replies with a friendly error message.

Images and videos are streamed without writing downloaded media to disk, except for video export, which temporarily writes files under the OS temp directory and deletes them after upload.

## Features

- Telegram bot built with NestJS
- `@start` welcome message
- Platform-aware URL validation via provider matching
- TikWM metadata lookup
- Direct video streaming to Telegram (single video, Twitter/X quality fallbacks, or multi-video batching)
- Slideshow support with batched media groups
- Optional slideshow video export for TikTok and Instagram (on-demand "🎬 Make video" button; images remain the default)
- In-memory cache for TikWM results
- Provider registry to support multiple social media backends
- Twitter/X provider implementation using FixTweet status endpoint
- Twitter/X quality fallback selection by bitrate with Telegram-safe retry ordering
- Instagram provider implementation with response normalization (`resources` payload and normalized `url_list/media_details` payload)
- URL-first extraction fallback for Instagram media delivery
- Auto-expiring cache cleanup to avoid memory growth
- Friendly error handling for invalid or private links
- User-initiated error reports with automatic context capture, Postgres storage, and admin Telegram alerts
- A "Share with friends" button that shares the bot itself after successful video downloads

## Architecture

The app is organized by feature and keeps the Telegram layer separate from the provider-driven download layer.

### High-level flow

1. The user sends a text message in Telegram.
2. `BotUpdate` asks `DownloadService` to detect the matching provider from the URL.
3. The bot replies with `⏳ Downloading...`.
4. `DownloadService` delegates media lookup to the matched provider.
5. `MediaCacheService` returns a cached result when possible.
6. If the provider returns a slideshow, the bot sends the images in groups of 10.
7. If the slideshow has 2+ images from TikTok or Instagram (or a single TikTok image with music) and video export is available, the bot sends a control message with an inline "🎬 Make video" button.
8. If the user taps "🎬 Make video", the callback renders an MP4 (TikTok photos timed to the original sound, Instagram carousel as a vertical auto-scroll) and uploads it.
9. If the provider returns videos, the bot sends one or many video URLs depending on the result payload.
10. On successful video downloads, the bot adds a "Share with friends" button that opens the bot invite link.
11. The temporary downloading message is deleted after the media is sent.

### Module breakdown

#### `AppModule`

Root application module.

- Loads `ConfigModule` globally
- Validates environment variables
- Imports the bot and download feature modules

#### `BotModule`

Telegram integration module.

- Configures `nestjs-telegraf`
- Registers `BotUpdate`
- Registers `BotService`
- Imports `DownloadModule` so the bot can access media lookup logic

#### `DownloadModule`

Provider-based media lookup and cache module.

- Provides `DownloadService`
- Provides `MediaCacheService`
- Registers platform providers (`TiktokProvider`, `TwitterProvider`, `InstagramProvider`)
- Registers `CacheModule` in memory with TTL support

#### `DownloadService`

Provider orchestrator for media fetching.

- Resolves which provider can handle an incoming URL
- Delegates media fetch to the selected provider
- Caches successful responses through `MediaCacheService`
- Exposes supported platforms and URL platform detection for the bot layer

#### Providers (`src/download/providers`)

- `SocialMediaProvider` interface defines a platform contract
- `TiktokProvider` contains TikWM-specific logic and response mapping
- `TwitterProvider` extracts tweet media from FixTweet and maps videos/photos into the shared `MediaInfo` model
- `InstagramProvider` extracts post/reel media with `instagram-url-direct` and normalizes output into the shared `MediaInfo` model

#### `MediaCacheService`

Owns cache behavior.

- Stores `MediaInfo` entries in memory
- Deletes expired entries lazily on read
- Runs periodic cleanup
- Enforces a maximum entry count
- Clears the cache on module shutdown

#### `BotUpdate`

Telegram update handler.

- Handles `/start`
- Handles text messages
- Sends the downloading status message
- Sends video or slideshow output
- After slideshow image batches, offers an inline "🎬 Make video" button for TikTok/Instagram slideshows with 2+ images (and single-image TikTok posts with music)
- Handles the `slideshow:video:` callback: acknowledges immediately, queues the render, uploads the MP4, and cleans up temp files
- Adds a share button to successful video responses
- Retries Twitter/X videos through fallback URLs in quality order when Telegram rejects the first attempt
- Keeps non-Twitter multi-video batching behavior intact
- Replies with a friendly error when download fails
- Adds a "Report this problem" button to genuine download failures
- Handles `/report`, `/reports`, `/resolve`, `/cancel`, and `/skip`

#### `VideoModule`

Slideshow-to-MP4 export module (`src/video/`). `BotModule` imports it; it exports the render service and request store.

- `video-render.service.ts` — orchestrator: creates a temp job dir, downloads images (+ music), normalizes with sharp, computes timing, builds ffmpeg args, runs ffmpeg, applies the size guard, and returns the file path with cleanup
- `video-render-queue.ts` — global concurrency limit (max 2 by default), pending-queue cap, one active render per user, per-user cooldown
- `video-request.store.ts` — short-lived callback tokens mapping to a slideshow snapshot (user, platform, images, music, durations, title/author); owner-checked, 2-hour TTL
- `ffmpeg.runner.ts` — spawns ffmpeg with a timeout, probes output duration, checks binary availability
- `slideshow.downloader.ts` — safe HTTPS download with SSRF guard, redirect re-validation, byte limits, retries, and limited concurrency
- `image.normalizer.ts` — sharp normalization to a consistent 720×1280 frame
- `slideshow.timing.ts` — pure timing math (TikTok even spread across the sound, Instagram per-slide/transition/total)
- `slideshow.args.ts` — pure ffmpeg argument builders (concat slideshow vs. slide-up transition chain)
- `video.types.ts` / `video.config.ts` — shared types and environment-backed config with defaults

#### `ReportModule`

User error reports and admin triage.

- `ReportService` creates, lists, and resolves reports
- `ReportNotifierService` sends new reports to every `ADMIN_IDS` admin with a Resolve button
- `ReportPresenter` formats the admin alert, report list, and report detail
- Enforces a one-per-minute cooldown and a five-per-day limit per user
- Stores a sanitized snapshot of the reporter, link, platform, error code, and description

## Data model

`DownloadService.getMediaInfo(url)` returns:

```ts
{
  platform: 'tiktok' | 'twitter' | 'instagram';
  isSlideshow: boolean;
  title: string;
  videoUrl: string | null;
  videoUrls: string[] | null;
  images: string[] | null;
  music: string;
  author: string;
  musicDurationSec?: number | null;
  musicTitle?: string | null;
}
```

`musicDurationSec` and `musicTitle` support slideshow video timing and captions. The TikTok provider maps them from the TikWM `music_info` payload (`duration`, `title`); when missing or zero, the renderer falls back to probing the downloaded audio. Instagram sets both to `null`.

### TikWM result behavior

- `isSlideshow` is `true` when `data.images` exists and has items
- `videoUrl` is used for normal videos
- `videoUrls` can include multiple provider-returned video URLs (for example, top Twitter/X MP4 variants)
- `images` is used for slideshow posts
- `music` and `author` are kept for future metadata handling

### Twitter/X result behavior

- The provider extracts the tweet id and calls `https://api.fxtwitter.com/status/{tweetId}`
- Reads media from `tweet.media.all`, `tweet.media.videos`, and `tweet.media.photos`
- For videos, filters variants to `content_type = video/mp4`
- Sorts MP4 variants by bitrate descending
- Returns a deduplicated, highest-quality-first `videoUrls` array so retries can step down safely
- If no compatible videos exist, returns photo URLs (up to 4) as slideshow media
- Logs a warning when the API returns code `200` but media is empty (possible sensitive-content case)

### Telegram delivery behavior

- Twitter/X video responses use ordered fallback retries across `videoUrls`
- Non-Twitter multi-video responses still use Telegram media-group batching
- Retry-on-failure logic is exclusive to Twitter/X so Instagram carousel batching still works as before

### Slideshow video export behavior

- Video export is on-demand: images are sent first, then the bot offers an inline "🎬 Make video" button for TikTok/Instagram slideshows with 2+ images (plus single-image TikTok posts with music).
- TikTok style: photos swipe in from the right with a hard edge on the beat of the original sound (even spread across the audio duration, looped or trimmed with a fade), with TikTok-style progress dots at the bottom tracking the current photo (fixed-size, truncated to a sliding window when there are more photos than fit). A single image is held as a still over the full sound (up to the 60s cap).
- Instagram style: 2 seconds per slide by default with a short `slideup` transition between images (no tall-strip decoding), silent because the carousel payload has no audio.
- Output: 720×1280 by default, H.264/AAC, `yuv420p`, `+faststart`, capped at 60 seconds and under Telegram's 50 MB bot-upload limit (with automatic step-down: on render failure it retries faster and smaller, down to ultrafast 480p, without changing your config).
- Concurrency: max 2 simultaneous renders by default (1 on 1–3 vCPU, 2 on 4+ vCPU), with a bounded queue, one active render per user, and a 30-second per-user cooldown.
- Temp files are written under the OS temp directory and deleted after upload.
- The renderer is intentionally modest for small/free servers: 720×1280, CRF 26, `veryfast`, one Sharp worker, capped ffmpeg threads, one `slideup` chain for Instagram, and a 60-second ceiling.

### Instagram result behavior

- Calls `instagramGetUrl(url)` from `instagram-url-direct`
- Accepts two payload variants:
  - raw package payload (`resources`, `owner`, `caption`)
  - normalized payload (`results_number`, `post_info`, `url_list`, `media_details`)
- Normalizes both variants to a common `InstagramResponse` shape before mapping to `MediaInfo`
- Extracts videos from `media_details` when `type = video`
- Falls back to URL pattern detection (`.mp4`, `.m3u8`, image extensions) from `url_list` if type metadata is missing
- Uses first available URL as a safety fallback when media metadata is incomplete
- Returns:
  - `videoUrl/videoUrls` for videos
  - `images` for image-only posts
  - `title` from caption and `author` from owner username

## Cache strategy

The bot uses an in-memory cache because the app is currently single-process and does not need Redis.

### Why cache TikWM responses

TikWM requests are the slowest part of the flow. Caching the normalized media metadata reduces repeated upstream requests when users resend the same TikTok URL.

### Cache rules

- TTL: 2 hours
- Maximum cache entries: 1000
- Cleanup interval: every 15 minutes
- Expiration strategy: lazy delete on read plus periodic pruning

### Why this matters

- Prevents unbounded memory growth
- Keeps stale media data from hanging around too long
- Avoids repeated TikWM requests for duplicate URLs
- Remains simple enough to swap to Redis later if the app grows

## Project structure

```text
src/
  app.module.ts
  app.controller.ts
  app.service.ts
  main.ts
  bot/
    bot.module.ts
    bot.service.ts
    bot.update.ts
  download/
    download.module.ts
    download.service.ts
    download.types.ts
    media-cache.service.ts
    providers/
      provider.constants.ts
      social-media-provider.interface.ts
      tiktok.provider.ts
      twitter.provider.ts
      instagram.provider.ts
      twitter.types.ts
  report/
    report.module.ts
    report.service.ts
    report-notifier.service.ts
    report.presenter.ts
    entities/
      error-report.entity.ts
  video/
    video.module.ts
    video.config.ts
    video.types.ts
    video-render.service.ts
    video-render-queue.ts
    video-request.store.ts
    ffmpeg.runner.ts
    slideshow.downloader.ts
    image.normalizer.ts
    slideshow.timing.ts
    slideshow.args.ts
  config/
    env.validation.ts
migrations/
  001_create_shadow_save_error_reports.sql
```

## Environment variables

Create a local `.env` file or set environment variables before starting the app.

| Variable                | Required | Description                                                            |
| ----------------------- | -------- | ---------------------------------------------------------------------- |
| `TELEGRAM_BOT_API_KEY`  | Yes      | Telegram bot token from BotFather                                      |
| `TELEGRAM_BOT_USERNAME` | Yes      | Bot username used for the share button invite                          |
| `DATABASE_URL`          | Yes      | Postgres connection string used by TypeORM                             |
| `ADMIN_IDS`             | Yes      | Comma-separated Telegram user IDs for admin commands and report alerts |
| `PORT`                  | No       | HTTP port for the Nest app, defaults to `3000`                         |

### Video export variables

| Variable                       | Default       | Description                              |
| ------------------------------ | ------------- | ---------------------------------------- |
| `VIDEO_EXPORT_ENABLED`           | `true`        | Feature flag for slideshow video export  |
| `FFMPEG_PATH`                    | bundled `ffmpeg-static` | Optional ffmpeg binary override; set this to prefer a system binary |
| `VIDEO_WIDTH`                    | `720`         | Output width                             |
| `VIDEO_HEIGHT`                   | `1280`        | Output height                            |
| `VIDEO_FPS`                      | `30`          | Output frame rate                        |
| `VIDEO_CRF`                      | `26`          | x264 quality                             |
| `VIDEO_PRESET`                   | `superfast`   | x264 preset (fast + low-RAM default)     |
| `VIDEO_MAX_DURATION_SEC`         | `60`          | Hard duration cap                        |
| `VIDEO_MAX_CONCURRENCY`          | CPU-based     | Simultaneous renders (1 vCPU → 1, 4+ vCPU → 2) |
| `VIDEO_MAX_QUEUE`                | `20`          | Pending renders                          |
| `VIDEO_TIKTOK_MIN_SLIDE_SEC`     | `1.5`         | TikTok minimum per image                 |
| `VIDEO_TIKTOK_MAX_SLIDE_SEC`     | `3.0`         | TikTok maximum per image                 |
| `VIDEO_IG_SECONDS_PER_SLIDE`     | `2.0`         | Instagram time per slide                 |
| `VIDEO_IG_HOLD_START_SEC`        | `0.5`         | Instagram initial hold                   |
| `VIDEO_MAX_IMAGE_BYTES`          | `12582912`    | 12 MB per image                          |
| `VIDEO_MAX_AUDIO_BYTES`          | `26214400`    | 25 MB audio                              |
| `VIDEO_MAX_JOB_BYTES`            | `157286400`   | 150 MB per job                           |
| `VIDEO_DOWNLOAD_TIMEOUT_MS`      | `20000`       | Per-request download timeout (images)    |
| `VIDEO_AUDIO_DOWNLOAD_TIMEOUT_MS`| `90000`       | Per-request download timeout (audio)     |
| `VIDEO_RENDER_TIMEOUT_MS`        | `120000`      | ffmpeg timeout                           |
| `VIDEO_TEMP_DIR`                 | OS temp       | Temp workspace root                      |
| `VIDEO_USER_COOLDOWN_SEC`        | `30`          | Per-user cooldown between renders        |

## Setup

Install dependencies:

```bash
pnpm install
```

`pnpm install` also downloads a static ffmpeg binary through `ffmpeg-static`, so local development and Docker do not need a system ffmpeg. Set `FFMPEG_PATH` if you prefer the system binary, or if the bundled binary cannot run on the target platform. The Docker runtime image uses the bundled binary and does not run `apk add ffmpeg`.

Run the app in development mode:

```bash
pnpm run dev
```

Build the app:

```bash
pnpm run build
```

Run tests:

```bash
pnpm run test
```

Video export has pure unit tests for timing math (`slideshow.timing`) and ffmpeg arg builders (`slideshow.args`), plus store/queue/downloader and TikTok `music_info` mapping tests. The ffmpeg integration test (local solid-color JPEGs + generated audio, no network) runs only when ffmpeg is available and skips otherwise.

Manual QA checklist:

- TikTok 1 (with music, full-sound still), 3, 10, 35 images, with and without music; verify audio sync and fade
- Instagram 2, 10, 20 images; verify the 2 s-per-slide slide-up transition with no cropping/stretching
- Verify playback on iOS, Android, and Telegram Desktop
- Verify file size stays under 50 MB and the fallback path works
- Verify expired token, double-tap, and concurrent-user behavior
- Verify the temp directory is empty after success and failure
- Verify image-only flow is unchanged and the button hides when ffmpeg is missing

## How to use the bot

1. Start the bot from [Telegram here](https://t.me/shadow_save_bot).
2. Send `/start`.
3. Send a public TikTok, Twitter/X, or Instagram URL.
4. Wait for the bot to reply with the video or slideshow.

### Example URLs

- `https://vm.tiktok.com/XXXXXXX/`
- `https://www.tiktok.com/@user/video/1234567890`
- `https://vt.tiktok.com/XXXXXXX/`
- `https://x.com/<username>/status/<tweetId>`
- `https://twitter.com/<username>/status/<tweetId>`
- `https://www.instagram.com/reel/<shortcode>/`
- `https://www.instagram.com/p/<shortcode>/`

## Notes on slideshow handling

Telegram media groups support a maximum of 10 items per group. For that reason, slideshow images are sent in batches of 10 so larger TikTok albums can still be delivered correctly.

## How video export works

After the image batches, the bot sends a control message with a "🎬 Make video" button (TikTok: "Want this slideshow as a video with the original sound?"; Instagram: "Want this carousel as an auto-scroll video?"). The button stays valid for 24 hours. Tapping it re-resolves the original link into fresh image/audio URLs (stored CDN links expire quickly), then queues the render, downloads and normalizes the images with sharp, computes timing, runs ffmpeg, and uploads the MP4 with `supports_streaming: true`. Temp job directories are deleted after upload, even on failure.

- TikTok: `xfade` swipe chain (new photo slides in from the right with a hard edge, no blending — even per-slide spread across the sound duration, clamped to 1.5–3.0 s, 60 s cap, audio looped/trimmed with fade, or `-an` when silent). Progress dots are per-slide overlay strips (fixed 14px circles, sliding-window truncation, current dot bright) following the same time windows. Single stills use a plain loop with no dots or transitions.
- Instagram: an `xfade` `slideup` chain (2 s per slide plus a 0.5 s start hold, short transitions between images), silent by default. This decodes one normalized image per frame instead of repeatedly decoding a tall strip, which keeps renders fast on small servers.

## Error handling

The bot returns a friendly error message when:

- the URL is not a supported platform link
- provider returns an error code
- provider backend cannot be reached
- the source link is private, expired, or otherwise unavailable
- Telegram cannot send the final media payload

## Error reports

When a genuine download failure happens, the failure message includes a **"🛠 Report this problem"** button. The bot already knows the link, platform, and error details, so the user only has to add a short description (or tap Skip).

Users can also send `/report` at any time. The next text message becomes the report.

### What a report contains

- Telegram ID, username, and first name (snapshot at report time)
- The URL and detected platform
- A short error code (`DOWNLOAD_FAILED`, `NO_MEDIA`, `TELEGRAM_FETCH_FAILED`, `USER_REPORT`)
- A sanitized one-line error detail
- The user's description
- Timestamps and resolution status

Reports never include media files, chat history, or other users' messages. Bot tokens are redacted from error text before it is stored or shown.

### Where reports go

1. The `shadow_save_error_reports` table in Postgres is the permanent record.
2. A formatted alert is sent as a Telegram DM to every ID in `ADMIN_IDS`, with a **"✅ Mark resolved"** button.
3. If the DM cannot be delivered, the report is still saved and visible through `/reports`.

### Admin commands

| Command         | Description                                              |
| --------------- | -------------------------------------------------------- |
| `/reports`      | List the 10 most recent open reports                     |
| `/reports all`  | List the 10 most recent reports, including resolved ones |
| `/reports <id>` | Show one report in full                                  |
| `/resolve <id>` | Mark a report as resolved                                |

The Resolve button on an admin alert does the same thing as `/resolve`: it changes the report from `open` to `resolved`, records who closed it and when, and removes it from the default `/reports` list. It does not delete the report or message the user who filed it.

### Rate limits

- One report per minute per user
- Five reports per day per user
- Banned users cannot file reports

### Database migration

Local development uses TypeORM `synchronize`, so the table is created automatically. Production runs with `synchronize: false`; apply the migration once before deploying:

```bash
psql "$DATABASE_URL" -f migrations/001_create_shadow_save_error_reports.sql
```

## Current limitations

- Cache is process-local only
- Cache is cleared on restart
- Media URLs returned by TikWM can expire, so cached results are intentionally short-lived
- The app is optimized for a single bot instance
- Report drafts and failure-button contexts are process-local and expire after 30 minutes; a restart clears them
- Instagram carousels have no audio in the current provider, so the auto-scroll video is silent
- TikTok timing is an even spread across the sound, not beat detection (TikWM does not expose per-slide timestamps)
- Video export is capped at 60 seconds and Telegram's 50 MB bot-upload limit
- Video export writes temporary files under the OS temp directory and deletes them after upload

## Development notes

- The bot handler keeps all Telegram-specific behavior in `BotUpdate`
- Twitter/X retry handling is exclusive to `BotUpdate` and does not affect non-Twitter batching
- Download and cache logic stays in the download layer
- Environment validation fails fast at startup if the bot token is missing
- Environment validation fails fast at startup if the bot username is missing
- The app streams images/videos without writing downloaded media to disk, except for video export, which temporarily uses a temp directory and deletes files after upload

## Future improvements

- Add unit tests for cache hit/miss behavior
- Add tests for slideshow batching
- Add a small health endpoint or startup log for easier deployment checks
- Replace the in-memory cache with Redis if the app ever needs horizontal scaling
- Add richer metadata replies, such as title, author, or music info
- Add a configurable share button title or share text if you want more control over the invite flow
- Optional Instagram music picker (carousel payload has no audio today)
- Optional 1080p output via `VIDEO_WIDTH`/`VIDEO_HEIGHT`
- LRU render cache for repeated video requests
- Crossfades/Ken Burns transitions for TikTok slideshows

## License

MIT

Built with 💜 by aluminate
