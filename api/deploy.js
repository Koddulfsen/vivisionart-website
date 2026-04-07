const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DEPLOY_HOOK_URL = process.env.DEPLOY_HOOK_URL;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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

  if (!DEPLOY_HOOK_URL) {
    return res.status(500).json({ error: 'Deploy hook not configured' });
  }

  try {
    const response = await fetch(DEPLOY_HOOK_URL, { method: 'POST' });
    if (response.ok) {
      return res.status(200).json({ ok: true });
    } else {
      return res.status(502).json({ error: 'Deploy hook returned ' + response.status });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
