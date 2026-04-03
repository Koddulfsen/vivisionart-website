import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN,
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '***REMOVED***';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // GET — public, returns all artworks ordered by sort_order
  if (req.method === 'GET') {
    try {
      const result = await db.execute('SELECT * FROM artworks ORDER BY sort_order ASC, id ASC');
      return res.status(200).json(result.rows);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // POST, PUT, DELETE need auth
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // POST — add artwork
  if (req.method === 'POST') {
    const { title, image_url, status } = req.body;
    if (!image_url) {
      return res.status(400).json({ error: 'image_url is required' });
    }
    try {
      // Get max sort_order
      const maxResult = await db.execute('SELECT MAX(sort_order) as max_order FROM artworks');
      const nextOrder = (maxResult.rows[0]?.max_order || 0) + 1;
      await db.execute({
        sql: 'INSERT INTO artworks (title, image_url, status, sort_order) VALUES (?, ?, ?, ?)',
        args: [title || '', image_url, status || 'for_sale', nextOrder],
      });
      return res.status(201).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // PUT — update artwork
  if (req.method === 'PUT') {
    const { id, title, image_url, status, sort_order } = req.body;
    if (!id) {
      return res.status(400).json({ error: 'ID is required' });
    }
    try {
      const fields = [];
      const args = [];
      if (title !== undefined) { fields.push('title = ?'); args.push(title); }
      if (image_url !== undefined) { fields.push('image_url = ?'); args.push(image_url); }
      if (status !== undefined) { fields.push('status = ?'); args.push(status); }
      if (sort_order !== undefined) { fields.push('sort_order = ?'); args.push(sort_order); }
      if (fields.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }
      args.push(id);
      await db.execute({
        sql: `UPDATE artworks SET ${fields.join(', ')} WHERE id = ?`,
        args,
      });
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // DELETE — remove artwork
  if (req.method === 'DELETE') {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ error: 'ID is required' });
    }
    try {
      await db.execute({ sql: 'DELETE FROM artworks WHERE id = ?', args: [id] });
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
