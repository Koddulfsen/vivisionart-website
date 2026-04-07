import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN,
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Ensure time columns exist
  try { await db.execute('ALTER TABLE events ADD COLUMN time_start TEXT DEFAULT ""'); } catch(e) {}
  try { await db.execute('ALTER TABLE events ADD COLUMN time_end TEXT DEFAULT ""'); } catch(e) {}

  // GET — public, no auth needed
  if (req.method === 'GET') {
    try {
      const result = await db.execute('SELECT * FROM events ORDER BY date ASC');
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
    const { title, date, location, time_start, time_end } = req.body;
    if (!title || !date) {
      return res.status(400).json({ error: 'Title and date are required' });
    }
    try {
      await db.execute({
        sql: 'INSERT INTO events (title, date, location, time_start, time_end) VALUES (?, ?, ?, ?, ?)',
        args: [title, date, location || '', time_start || '', time_end || ''],
      });
      return res.status(201).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // PUT — update event
  if (req.method === 'PUT') {
    const { id, title, date, location } = req.body;
    if (!id) {
      return res.status(400).json({ error: 'ID is required' });
    }
    try {
      const fields = [];
      const args = [];
      if (title !== undefined) { fields.push('title = ?'); args.push(title); }
      if (date !== undefined) { fields.push('date = ?'); args.push(date); }
      if (location !== undefined) { fields.push('location = ?'); args.push(location); }
      if (req.body.time_start !== undefined) { fields.push('time_start = ?'); args.push(req.body.time_start); }
      if (req.body.time_end !== undefined) { fields.push('time_end = ?'); args.push(req.body.time_end); }
      if (fields.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }
      args.push(id);
      await db.execute({
        sql: `UPDATE events SET ${fields.join(', ')} WHERE id = ?`,
        args,
      });
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // DELETE — remove event
  if (req.method === 'DELETE') {
    const id = req.query?.id || req.body?.id;
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
