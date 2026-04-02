# Shadow Save Bot

Built with 💜 by aluminate

Shadow Save Bot is a NestJS Telegram bot that downloads TikTok media and sends it directly back to the user without saving files to disk.

It uses:

- NestJS for application structure and dependency injection
- `nestjs-telegraf` for Telegram bot integration
- TikWM for TikTok media extraction
- `cache-manager` for in-memory caching with automatic expiration
- Telegram media groups for slideshow responses

## What it does

The bot accepts a TikTok URL in Telegram and responds in one of three ways:

- If the link is valid and points to a video, it sends the video back to the chat.
- If the link is a slideshow, it sends the images as Telegram media groups.
- If the link is invalid or TikWM fails, it replies with a friendly error message.

The app does not write downloaded media to disk.

## Features

- Telegram bot built with NestJS
- `@start` welcome message
- TikTok URL validation
- TikWM metadata lookup
- Direct video streaming to Telegram
- Slideshow support with batched media groups
- In-memory cache for TikWM results
- Auto-expiring cache cleanup to avoid memory growth
- Friendly error handling for invalid or private links
- A "Share with friends" button that shares the bot itself after successful video downloads

## Architecture

The app is organized by feature and keeps the Telegram layer separate from the TikTok download layer.

### High-level flow

1. The user sends a text message in Telegram.
2. `BotUpdate` validates that the message looks like a TikTok URL.
3. The bot replies with `⏳ Downloading...`.
4. `DownloadService` looks up the media information from TikWM.
5. `MediaCacheService` returns a cached result when possible.
6. If TikWM returns a slideshow, the bot sends the images in groups of 10.
7. If TikWM returns a video, the bot sends the video URL directly.
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

Media lookup and cache module.

- Provides `DownloadService`
- Provides `MediaCacheService`
- Registers `CacheModule` in memory with TTL support

#### `DownloadService`

Responsible for talking to TikWM.

- Fetches media metadata with native `fetch`
- Converts the TikWM response into a strict `MediaInfo` shape
- Caches successful responses through `MediaCacheService`

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
- Replies with a friendly error when download fails

## Data model

`DownloadService.getMediaInfo(url)` returns:

```ts
{
  isSlideshow: boolean;
  title: string;
  videoUrl: string | null;
  images: string[] | null;
  music: string;
  author: string;
}
```

### TikWM result behavior

- `isSlideshow` is `true` when `data.images` exists and has items
- `videoUrl` is used for normal videos
- `images` is used for slideshow posts
- `music` and `author` are kept for future metadata handling

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
  config/
    env.validation.ts
```

## Environment variables

Create a local `.env` file or set environment variables before starting the app.

| Variable               | Required | Description                                    |
| ---------------------- | -------- | ---------------------------------------------- |
| `TELEGRAM_BOT_API_KEY` | Yes      | Telegram bot token from BotFather              |
| `TELEGRAM_BOT_USERNAME`| Yes      | Bot username used for the share button invite   |
| `PORT`                 | No       | HTTP port for the Nest app, defaults to `3000` |

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
3. Send a public TikTok URL.
4. Wait for the bot to reply with the video or slideshow.

### Example URLs

- `https://vm.tiktok.com/XXXXXXX/`
- `https://www.tiktok.com/@user/video/1234567890`
- `https://vt.tiktok.com/XXXXXXX/`

## Notes on slideshow handling

Telegram media groups support a maximum of 10 items per group. For that reason, slideshow images are sent in batches of 10 so larger TikTok albums can still be delivered correctly.

## Error handling

The bot returns a friendly error message when:

- the URL is not a supported TikTok link
- TikWM returns an error code
- TikWM cannot be reached
- the TikTok link is private, expired, or otherwise unavailable
- Telegram cannot send the final media payload

## Current limitations

- Cache is process-local only
- Cache is cleared on restart
- Media URLs returned by TikWM can expire, so cached results are intentionally short-lived
- The app is optimized for a single bot instance

## Development notes

- The bot handler keeps all Telegram-specific behavior in `BotUpdate`
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
