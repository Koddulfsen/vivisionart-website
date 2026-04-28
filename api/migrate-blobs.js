// One-off migration endpoint: re-encodes Vercel Blob images as WebP and updates DB.
//
// Auth: Bearer ADMIN_PASSWORD
// POST /api/migrate-blobs            -> processes up to 3 images (default batch)
// POST /api/migrate-blobs?limit=5    -> processes up to 5
// GET  /api/migrate-blobs            -> dry run: lists remaining work, no changes
//
// Idempotent: skips URLs already ending in .webp. Originals are NOT deleted from
// Vercel Blob. Call repeatedly until { remaining: 0 }.

import { createClient } from '@libsql/client';
import { put } from '@vercel/blob';
import sharp from 'sharp';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const MAX_DIMENSION = 1600;
const WEBP_QUALITY = 82;
const DEFAULT_BATCH = 3;

const db = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN,
});

export const config = {
  maxDuration: 60,
};

const isBlobUrl = (s) =>
  typeof s === 'string' && s.includes('.public.blob.vercel-storage.com');
const isAlreadyWebp = (s) => typeof s === 'string' && /\.webp(\?|$)/i.test(s);

// Find every blob URL (not yet webp) referenced by a string value, including JSON-encoded.
function extractTargets(value) {
  const out = [];
  const visit = (v) => {
    if (typeof v === 'string') {
      if (isBlobUrl(v) && !isAlreadyWebp(v)) out.push(v);
      else if (v.startsWith('[') || v.startsWith('{')) {
        try {
          visit(JSON.parse(v));
        } catch {
          /* not JSON */
        }
      }
    } else if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(visit);
    }
  };
  visit(value);
  return out;
}

// Replace blob URLs in a value tree using a url->newUrl map. Mirrors extractTargets.
function rewriteValue(value, urlMap) {
  if (typeof value === 'string') {
    if (urlMap.has(value)) return urlMap.get(value);
    if (value.startsWith('[') || value.startsWith('{')) {
      try {
        const parsed = JSON.parse(value);
        const rewritten = rewriteValue(parsed, urlMap);
        return JSON.stringify(rewritten);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => rewriteValue(v, urlMap));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewriteValue(v, urlMap);
    return out;
  }
  return value;
}

async function gatherWork() {
  const settings = await db.execute('SELECT key, value FROM settings');
  const artworks = await db.execute(
    'SELECT id, image_url FROM artworks WHERE image_url IS NOT NULL'
  );

  // Set of unique blob URLs that need migration
  const urls = new Set();
  // Map of which rows reference which urls — needed for selective updates
  const settingsByKey = new Map(); // key -> { value, urls: [] }
  const artworksById = new Map(); // id -> { url }

  for (const row of settings.rows) {
    const targets = extractTargets(row.value);
    if (targets.length) {
      settingsByKey.set(row.key, { value: row.value, urls: targets });
      targets.forEach((u) => urls.add(u));
    }
  }
  for (const row of artworks.rows) {
    if (isBlobUrl(row.image_url) && !isAlreadyWebp(row.image_url)) {
      artworksById.set(row.id, { url: row.image_url });
      urls.add(row.image_url);
    }
  }

  return { urls: [...urls], settingsByKey, artworksById };
}

async function optimizeAndUpload(originalUrl) {
  const res = await fetch(originalUrl, { redirect: 'follow' });
  if (!res.ok) throw new Error(`fetch ${originalUrl}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

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

  const blob = await put(`${stem}.webp`, optimized, {
    access: 'public',
    addRandomSuffix: true,
    contentType: 'image/webp',
  });

  return {
    originalUrl,
    newUrl: blob.url,
    originalSize: buf.length,
    newSize: optimized.length,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.headers.authorization !== `Bearer ${ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { urls, settingsByKey, artworksById } = await gatherWork();

    if (req.method === 'GET') {
      return res.status(200).json({
        remaining: urls.length,
        settings_keys_affected: settingsByKey.size,
        artworks_affected: artworksById.size,
        sample: urls.slice(0, 5),
      });
    }

    const limit = Math.max(
      1,
      Math.min(20, parseInt(req.query?.limit, 10) || DEFAULT_BATCH)
    );

    const batch = urls.slice(0, limit);
    if (batch.length === 0) {
      return res.status(200).json({
        processed: 0,
        remaining: 0,
        done: true,
        message: 'Nothing to migrate.',
      });
    }

    // Process batch sequentially (parallel uploads can hit Vercel Blob rate limits).
    const results = [];
    const urlMap = new Map();
    for (const url of batch) {
      try {
        const r = await optimizeAndUpload(url);
        urlMap.set(r.originalUrl, r.newUrl);
        results.push({
          status: 'ok',
          original: url,
          new: r.newUrl,
          before_kb: Math.round(r.originalSize / 1024),
          after_kb: Math.round(r.newSize / 1024),
        });
      } catch (err) {
        results.push({ status: 'error', original: url, error: err.message });
      }
    }

    // Update DB rows that reference any migrated URL.
    let settingsUpdated = 0;
    for (const [key, info] of settingsByKey) {
      if (!info.urls.some((u) => urlMap.has(u))) continue;
      const newValue = rewriteValue(info.value, urlMap);
      if (newValue !== info.value) {
        await db.execute({
          sql: 'UPDATE settings SET value = ? WHERE key = ?',
          args: [String(newValue), key],
        });
        settingsUpdated++;
      }
    }
    let artworksUpdated = 0;
    for (const [id, info] of artworksById) {
      if (urlMap.has(info.url)) {
        await db.execute({
          sql: 'UPDATE artworks SET image_url = ? WHERE id = ?',
          args: [urlMap.get(info.url), id],
        });
        artworksUpdated++;
      }
    }

    return res.status(200).json({
      processed: results.filter((r) => r.status === 'ok').length,
      errors: results.filter((r) => r.status === 'error').length,
      remaining: urls.length - batch.length,
      done: urls.length - batch.length === 0,
      settings_rows_updated: settingsUpdated,
      artworks_rows_updated: artworksUpdated,
      results,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
