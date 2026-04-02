type Environment = {
  TELEGRAM_BOT_API_KEY: string;
};

export function validateEnvironment(config: Record<string, unknown>): Environment {
  const telegramBotApiKey = config.TELEGRAM_BOT_API_KEY;

  if (typeof telegramBotApiKey !== 'string' || telegramBotApiKey.trim().length === 0) {
    throw new Error('Missing required environment variable: TELEGRAM_BOT_API_KEY');
  }

  return {
    TELEGRAM_BOT_API_KEY: telegramBotApiKey,
  };
}
