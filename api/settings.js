import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN,
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // GET — public, returns all settings as {key: value}
  if (req.method === 'GET') {
    try {
      const result = await db.execute('SELECT key, value FROM settings');
      const settings = {};
      result.rows.forEach(row => {
        settings[row.key] = row.value;
      });
      return res.status(200).json(settings);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // POST needs auth
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // POST — upsert setting {key, value}
  if (req.method === 'POST') {
    const { key, value } = req.body;
    if (!key || value === undefined || value === null) {
      return res.status(400).json({ error: 'Key and value are required' });
    }
    try {
      await db.execute({
        sql: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
        args: [key, String(value)],
      });
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
