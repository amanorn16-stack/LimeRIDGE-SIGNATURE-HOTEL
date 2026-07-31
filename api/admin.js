// Vercel serverless function: /api/admin
//
// Lets hotel staff manage pending bank-transfer holds: list them, confirm
// one (converts the temporary hold into a permanent booking once staff has
// verified the transfer really came in), or cancel one (releases the room
// immediately instead of waiting for it to auto-expire).
//
// Protected by a shared secret. Requires an environment variable ADMIN_KEY
// to be set on the Vercel project (Project Settings -> Environment Variables)
// -- pick any private passphrase. Pass it as ?key=... or header x-admin-key.
//
// GET  /api/admin?action=list&key=...
// POST /api/admin?action=confirm&key=...   body: { reference }
// POST /api/admin?action=cancel&key=...    body: { reference }

function slugify(name) {
  return String(name).trim().toLowerCase().replace(/\s+/g, '-');
}

function getRedisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

async function redisPipeline(config, commands) {
  const response = await fetch(config.url + '/pipeline', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + config.token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(commands)
  });
  if (!response.ok) {
    throw new Error('Redis pipeline request failed with status ' + response.status);
  }
  return response.json();
}

function datesBetween(startStr, endStr) {
  const dates = [];
  const start = new Date(startStr + 'T00:00:00Z');
  const end = new Date(endStr + 'T00:00:00Z');
  const cursor = new Date(start);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

async function readBody(req) {
  if (req.body) {
    if (typeof req.body === 'string') {
      try { return JSON.parse(req.body); } catch (e) { return {}; }
    }
    return req.body;
  }
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); }
    });
  });
}

module.exports = async (req, res) => {
  const reqUrl = new URL(req.url, 'http://localhost');
  const params = reqUrl.searchParams;
  const action = params.get('action');

  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    res.status(500).json({ success: false, message: 'Server is not configured with an ADMIN_KEY yet. Add ADMIN_KEY in Vercel project settings.' });
    return;
  }
  const providedKey = params.get('key') || req.headers['x-admin-key'];
  if (providedKey !== adminKey) {
    res.status(401).json({ success: false, message: 'Invalid or missing admin key' });
    return;
  }

  const redisConfig = getRedisConfig();
  if (!redisConfig) {
    res.status(500).json({ success: false, message: 'Storage not configured yet. Connect an Upstash for Redis integration to this Vercel project (Storage tab).' });
    return;
  }

  try {
    if (action === 'list' && req.method === 'GET') {
      const refsRes = await redisPipeline(redisConfig, [['ZREVRANGE', 'pending-bookings', 0, 199]]);
      const refs = (refsRes[0] && refsRes[0].result) || [];
      if (refs.length === 0) {
        res.status(200).json({ success: true, bookings: [] });
        return;
      }
      const commands = refs.map(ref => ['GET', 'booking:' + ref]);
      const results = await redisPipeline(redisConfig, commands);
      const bookings = results
        .map(r => {
          if (!r || !r.result) return null;
          try { return JSON.parse(r.result); } catch (e) { return null; }
        })
        .filter(Boolean);
      res.status(200).json({ success: true, bookings });
      return;
    }

    if (action === 'confirm' && req.method === 'POST') {
      const body = await readBody(req);
      const reference = body && body.reference;
      if (!reference) {
        res.status(400).json({ success: false, message: 'reference is required' });
        return;
      }
      const recRes = await redisPipeline(redisConfig, [['GET', 'booking:' + reference]]);
      const raw = recRes[0] && recRes[0].result;
      if (!raw) {
        res.status(404).json({ success: false, message: 'Booking not found' });
        return;
      }
      const record = JSON.parse(raw);
      if (record.status !== 'pending') {
        res.status(400).json({ success: false, message: 'Booking is not pending (status: ' + record.status + ')' });
        return;
      }
      const slug = slugify(record.roomType);
      const nights = datesBetween(record.checkin, record.checkout).slice(0, -1);
      const commands = [];
      nights.forEach(d => {
        commands.push(['INCR', 'booked:' + slug + ':' + d]);
        commands.push(['ZREM', 'hold:' + slug + ':' + d, reference]);
      });
      commands.push(['ZREM', 'pending-bookings', reference]);
      record.status = 'confirmed';
      record.confirmedAt = new Date().toISOString();
      commands.push(['SET', 'booking:' + reference, JSON.stringify(record)]);
      await redisPipeline(redisConfig, commands);
      res.status(200).json({ success: true, reference, status: 'confirmed' });
      return;
    }

    if (action === 'cancel' && req.method === 'POST') {
      const body = await readBody(req);
      const reference = body && body.reference;
      if (!reference) {
        res.status(400).json({ success: false, message: 'reference is required' });
        return;
      }
      const recRes = await redisPipeline(redisConfig, [['GET', 'booking:' + reference]]);
      const raw = recRes[0] && recRes[0].result;
      if (!raw) {
        res.status(404).json({ success: false, message: 'Booking not found' });
        return;
      }
      const record = JSON.parse(raw);
      const slug = slugify(record.roomType);
      const nights = datesBetween(record.checkin, record.checkout).slice(0, -1);
      const commands = [];
      nights.forEach(d => {
        commands.push(['ZREM', 'hold:' + slug + ':' + d, reference]);
      });
      commands.push(['ZREM', 'pending-bookings', reference]);
      record.status = 'cancelled';
      record.cancelledAt = new Date().toISOString();
      commands.push(['SET', 'booking:' + reference, JSON.stringify(record)]);
      await redisPipeline(redisConfig, commands);
      res.status(200).json({ success: true, reference, status: 'cancelled' });
      return;
    }

    res.status(400).json({ success: false, message: 'Unknown action. Use list (GET), confirm (POST) or cancel (POST).' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Admin action failed', detail: String(err) });
  }
};
