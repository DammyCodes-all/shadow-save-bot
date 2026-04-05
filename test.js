import { instagramGetUrl } from 'instagram-url-direct';
let data = await instagramGetUrl(
  'https://www.instagram.com/reel/DWug2uIDdK8/?igsh=bnJxeGFidmw4ejNx',
);
console.log(data);
