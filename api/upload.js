import { put } from '@vercel/blob';
import sharp from 'sharp';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const MAX_DIMENSION = 1600;
const WEBP_QUALITY = 82;

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Filename');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = req.headers.authorization;
  if (auth !== `Bearer ${ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const rawName = req.headers['x-filename'] || `image-${Date.now()}`;
    const stem = rawName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = `${stem}.webp`;

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);

    if (body.length === 0) {
      return res.status(400).json({ error: 'No file data received' });
    }

    const optimized = await sharp(body)
      .rotate()
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();

    const blob = await put(filename, optimized, {
      access: 'public',
      addRandomSuffix: true,
      contentType: 'image/webp',
    });

    return res.status(200).json({
      url: blob.url,
      size: optimized.length,
      original_size: body.length,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
