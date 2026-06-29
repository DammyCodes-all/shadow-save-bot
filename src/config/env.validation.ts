type Environment = {
  TELEGRAM_BOT_API_KEY: string;
  TELEGRAM_BOT_USERNAME: string;
  DATABASE_URL: string;
  REDIS_URL: string;
  ADMIN_IDS: number[];
};

export function validateEnvironment(config: Record<string, unknown>): Environment {
  const telegramBotApiKey = config.TELEGRAM_BOT_API_KEY;
  const telegramBotUsername = config.TELEGRAM_BOT_USERNAME;
  const databaseUrl = config.DATABASE_URL;
  const redisUrl = config.REDIS_URL;
  const adminIds = config.ADMIN_IDS;

  if (typeof telegramBotApiKey !== 'string' || telegramBotApiKey.trim().length === 0) {
    throw new Error('Missing required environment variable: TELEGRAM_BOT_API_KEY');
  }

  if (typeof telegramBotUsername !== 'string' || telegramBotUsername.trim().length === 0) {
    throw new Error('Missing required environment variable: TELEGRAM_BOT_USERNAME');
  }

  if (typeof databaseUrl !== 'string' || databaseUrl.trim().length === 0) {
    throw new Error('Missing required environment variable: DATABASE_URL');
  }

  if (typeof redisUrl !== 'string' || redisUrl.trim().length === 0) {
    throw new Error('Missing required environment variable: REDIS_URL');
  }

  if (typeof adminIds !== 'string' || adminIds.trim().length === 0) {
    throw new Error('Missing required environment variable: ADMIN_IDS');
  }

  const parsedAdminIds = adminIds
    .split(',')
    .map((id) => parseInt(id.trim(), 10))
    .filter((id) => !Number.isNaN(id));

  if (parsedAdminIds.length === 0) {
    throw new Error('ADMIN_IDS must contain at least one valid numeric Telegram user ID');
  }

  return {
    TELEGRAM_BOT_API_KEY: telegramBotApiKey,
    TELEGRAM_BOT_USERNAME: telegramBotUsername,
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    ADMIN_IDS: parsedAdminIds,
  };
}
