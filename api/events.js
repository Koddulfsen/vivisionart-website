import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN,
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '***REMOVED***';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // GET — public, no auth needed
  if (req.method === 'GET') {
    try {
      const result = await db.execute('SELECT * FROM events ORDER BY id DESC');
      return res.status(200).json(result.rows);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // POST and DELETE need auth
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // POST — add event
  if (req.method === 'POST') {
    const { title, date, location } = req.body;
    if (!title || !date) {
      return res.status(400).json({ error: 'Title and date are required' });
    }
    try {
      await db.execute({
        sql: 'INSERT INTO events (title, date, location) VALUES (?, ?, ?)',
        args: [title, date, location || ''],
      });
      return res.status(201).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // DELETE — remove event
  if (req.method === 'DELETE') {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ error: 'ID is required' });
    }
    try {
      await db.execute({ sql: 'DELETE FROM events WHERE id = ?', args: [id] });
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
