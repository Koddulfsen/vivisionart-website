// One-off migration: re-encode existing Vercel Blob images as WebP and update DB rows.
//
// Run locally with env vars from Vercel:
//   vercel env pull .env.local
//   node --env-file=.env.local scripts/migrate-blobs.js
//
// Idempotent: skips URLs already ending in .webp. Originals are NOT deleted,
// only superseded in the DB. If the migration fails partway, re-running picks
// up where it left off.

import { createClient } from '@libsql/client';
import { put } from '@vercel/blob';
import sharp from 'sharp';

const MAX_DIMENSION = 1600;
const WEBP_QUALITY = 82;

const db = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN,
});

const isBlobUrl = (s) =>
  typeof s === 'string' && s.includes('.public.blob.vercel-storage.com');
const isAlreadyWebp = (s) => typeof s === 'string' && /\.webp(\?|$)/i.test(s);

async function fetchBuffer(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function optimizeAndUpload(originalUrl) {
  const buf = await fetchBuffer(originalUrl);
  const optimized = await sharp(buf)
    .rotate()
    .resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();

  const stem = decodeURIComponent(originalUrl.split('/').pop().split('?')[0])
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  const filename = `${stem}.webp`;

  const blob = await put(filename, optimized, {
    access: 'public',
    addRandomSuffix: true,
    contentType: 'image/webp',
  });

  return {
    url: blob.url,
    originalSize: buf.length,
    newSize: optimized.length,
  };
}

const cache = new Map(); // originalUrl -> newUrl (within this run)

async function migrateOne(originalUrl) {
  if (cache.has(originalUrl)) return cache.get(originalUrl);
  const result = await optimizeAndUpload(originalUrl);
  cache.set(originalUrl, result.url);
  console.log(
    `  ${(result.originalSize / 1024).toFixed(0)} KB -> ${(result.newSize / 1024).toFixed(0)} KB  (${Math.round((1 - result.newSize / result.originalSize) * 100)}% smaller)  ${result.url}`
  );
  return result.url;
}

// Walk a value looking for blob URLs; return new value with URLs replaced.
async function transformValue(value) {
  // Direct string blob URL
  if (typeof value === 'string') {
    if (isBlobUrl(value) && !isAlreadyWebp(value)) {
      return await migrateOne(value);
    }
    // Try parse as JSON (settings stores JSON-encoded arrays as strings)
    if (value.startsWith('[') || value.startsWith('{')) {
      try {
        const parsed = JSON.parse(value);
        const transformed = await transformValue(parsed);
        return JSON.stringify(transformed);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) out.push(await transformValue(item));
    return out;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = await transformValue(v);
    }
    return out;
  }
  return value;
}

async function migrateSettings() {
  console.log('\n=== Settings ===');
  const result = await db.execute('SELECT key, value FROM settings');
  let updated = 0;
  for (const row of result.rows) {
    const newValue = await transformValue(row.value);
    if (newValue !== row.value) {
      console.log(`[settings] ${row.key}`);
      await db.execute({
        sql: 'UPDATE settings SET value = ? WHERE key = ?',
        args: [String(newValue), row.key],
      });
      updated++;
    }
  }
  console.log(`Updated ${updated} settings rows.`);
}

async function migrateArtworks() {
  console.log('\n=== Artworks ===');
  const result = await db.execute('SELECT id, title, image_url FROM artworks');
  let updated = 0;
  for (const row of result.rows) {
    if (!isBlobUrl(row.image_url) || isAlreadyWebp(row.image_url)) continue;
    console.log(`[artwork ${row.id}] ${row.title || '(untitled)'}`);
    const newUrl = await migrateOne(row.image_url);
    await db.execute({
      sql: 'UPDATE artworks SET image_url = ? WHERE id = ?',
      args: [newUrl, row.id],
    });
    updated++;
  }
  console.log(`Updated ${updated} artwork rows.`);
}

(async () => {
  if (!process.env.TURSO_URL || !process.env.TURSO_TOKEN) {
    console.error('Missing TURSO_URL or TURSO_TOKEN env vars.');
    process.exit(1);
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('Missing BLOB_READ_WRITE_TOKEN env var.');
    process.exit(1);
  }

  await migrateSettings();
  await migrateArtworks();

  console.log(`\nDone. Migrated ${cache.size} unique blob(s).`);
  console.log('Originals were NOT deleted from Vercel Blob. To free that storage,');
  console.log('delete them manually from the Vercel dashboard once verified.');
})().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
