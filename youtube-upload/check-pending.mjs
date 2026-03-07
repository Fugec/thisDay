import 'dotenv/config';
import { getPostIndex } from './lib/kv.js';
import { kvPut } from './lib/kv.js';

// ── New March 7 post: Bell patents the telephone ────────────────────────────
const newPost = {
  slug:        '7-march-2026',
  title:       'Bell Patents the Telephone - March 7, 1876',
  description: 'Alexander Graham Bell receives US Patent 174,465 for the telephone, changing human communication forever.',
  imageUrl:    'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9c/Alexander_Graham_Bell_1895_NPG_77_363.jpg/330px-Alexander_Graham_Bell_1895_NPG_77_363.jpg',
  publishedAt: '2026-03-07T06:00:00.000Z',
};

const posts = await getPostIndex();
const exists = posts.find(p => p.slug === newPost.slug);

// Upsert — update if exists, add if not
const idx = posts.findIndex(p => p.slug === newPost.slug);
if (idx >= 0) posts[idx] = newPost;
else posts.unshift(newPost);
await kvPut('index', JSON.stringify(posts));
console.log('Post saved:', newPost.slug);
