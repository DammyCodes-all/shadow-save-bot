export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = url.searchParams.get('url');

    if (!target) {
      return new Response(
        JSON.stringify({ code: -1, msg: 'Missing url param' }),
        {
          status: 400,
          headers: { 'content-type': 'application/json' },
        },
      );
    }

    const tikwmUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(target)}`;

    try {
      const response = await fetch(tikwmUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
        },
      });

      const body = await response.text();
      return new Response(body, {
        status: response.status,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        },
      });
    } catch {
      return new Response(
        JSON.stringify({ code: -1, msg: 'Proxy failed to reach TikWM' }),
        {
          status: 502,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
  },
};