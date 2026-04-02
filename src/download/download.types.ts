export type TikwmResponse = {
  code: number;
  msg?: string;
  data?: {
    title?: string;
    play?: string;
    images?: string[];
    music?: string;
    author?: {
      nickname?: string;
    };
  };
};

export type MediaInfo = {
  isSlideshow: boolean;
  title: string;
  videoUrl: string | null;
  images: string[] | null;
  music: string;
  author: string;
};
