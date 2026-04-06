# Shadow Save Bot

Built with 💜 by aluminate

Shadow Save Bot is a NestJS Telegram bot with provider-based multi-social media support. It currently supports TikTok, Twitter/X, and Instagram media extraction and sends content directly in Telegram without saving files to disk.

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
- If the link is unsupported or provider processing fails, it replies with a friendly error message.

The app does not write downloaded media to disk.

## Features

- Telegram bot built with NestJS
- `@start` welcome message
- Platform-aware URL validation via provider matching
- TikWM metadata lookup
- Direct video streaming to Telegram (single video, Twitter/X quality fallbacks, or multi-video batching)
- Slideshow support with batched media groups
- In-memory cache for TikWM results
- Provider registry to support multiple social media backends
- Twitter/X provider implementation using FixTweet status endpoint
- Twitter/X quality fallback selection by bitrate with Telegram-safe retry ordering
- Instagram provider implementation with response normalization (`resources` payload and normalized `url_list/media_details` payload)
- URL-first extraction fallback for Instagram media delivery
- Auto-expiring cache cleanup to avoid memory growth
- Friendly error handling for invalid or private links
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
7. If the provider returns videos, the bot sends one or many video URLs depending on the result payload.
8. On successful video downloads, the bot adds a "Share with friends" button that opens the bot invite link.
9. The temporary downloading message is deleted after the media is sent.

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
- Adds a share button to successful video responses
- Retries Twitter/X videos through fallback URLs in quality order when Telegram rejects the first attempt
- Keeps non-Twitter multi-video batching behavior intact
- Replies with a friendly error when download fails

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
}
```

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
  config/
    env.validation.ts
```

## Environment variables

Create a local `.env` file or set environment variables before starting the app.

| Variable                | Required | Description                                    |
| ----------------------- | -------- | ---------------------------------------------- |
| `TELEGRAM_BOT_API_KEY`  | Yes      | Telegram bot token from BotFather              |
| `TELEGRAM_BOT_USERNAME` | Yes      | Bot username used for the share button invite  |
| `PORT`                  | No       | HTTP port for the Nest app, defaults to `3000` |

## Setup

Install dependencies:

```bash
pnpm install
```

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

## Error handling

The bot returns a friendly error message when:

- the URL is not a supported platform link
- provider returns an error code
- provider backend cannot be reached
- the source link is private, expired, or otherwise unavailable
- Telegram cannot send the final media payload

## Current limitations

- Cache is process-local only
- Cache is cleared on restart
- Media URLs returned by TikWM can expire, so cached results are intentionally short-lived
- The app is optimized for a single bot instance

## Development notes

- The bot handler keeps all Telegram-specific behavior in `BotUpdate`
- Twitter/X retry handling is exclusive to `BotUpdate` and does not affect non-Twitter batching
- Download and cache logic stays in the download layer
- Environment validation fails fast at startup if the bot token is missing
- Environment validation fails fast at startup if the bot username is missing
- The app avoids writing temporary media files to disk

## Future improvements

- Add unit tests for cache hit/miss behavior
- Add tests for slideshow batching
- Add a small health endpoint or startup log for easier deployment checks
- Replace the in-memory cache with Redis if the app ever needs horizontal scaling
- Add richer metadata replies, such as title, author, or music info
- Add a configurable share button title or share text if you want more control over the invite flow

## License

MIT

Built with 💜 by aluminate
