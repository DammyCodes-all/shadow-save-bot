export type FixTweetVariant = {
  url?: string;
  bitrate?: number;
  content_type?: string;
  size_bytes?: number;
};

export type FixTweetFormat = {
  url?: string;
  bitrate?: number;
  container?: string;
  codec?: string;
};

export type FixTweetMediaItem = {
  id?: string;
  url?: string;
  type?: 'video' | 'photo' | string;
  duration?: number;
  variants?: FixTweetVariant[];
  formats?: FixTweetFormat[];
};

export type FixTweetTweet = {
  id?: string;
  text?: string;
  author?: {
    screen_name?: string;
    name?: string;
  };
  media?: {
    all?: FixTweetMediaItem[];
    videos?: FixTweetMediaItem[];
    photos?: FixTweetMediaItem[];
  };
};

export type FixTweetResponse = {
  code?: number;
  message?: string;
  tweet?: FixTweetTweet;
};
