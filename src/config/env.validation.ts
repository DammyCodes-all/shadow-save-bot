type Environment = {
  TELEGRAM_BOT_API_KEY: string;
  TELEGRAM_BOT_USERNAME: string;
};

export function validateEnvironment(config: Record<string, unknown>): Environment {
  const telegramBotApiKey = config.TELEGRAM_BOT_API_KEY;
  const telegramBotUsername = config.TELEGRAM_BOT_USERNAME;

  if (typeof telegramBotApiKey !== 'string' || telegramBotApiKey.trim().length === 0) {
    throw new Error('Missing required environment variable: TELEGRAM_BOT_API_KEY');
  }

  if (typeof telegramBotUsername !== 'string' || telegramBotUsername.trim().length === 0) {
    throw new Error('Missing required environment variable: TELEGRAM_BOT_USERNAME');
  }

  return {
    TELEGRAM_BOT_API_KEY: telegramBotApiKey,
    TELEGRAM_BOT_USERNAME: telegramBotUsername,
  };
}
