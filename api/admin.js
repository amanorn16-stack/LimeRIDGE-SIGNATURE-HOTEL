// Vercel serverless function: /api/admin
//
// Lets hotel staff manage bookings and holds: list pending transfers,
// confirm/cancel a pending hold, list every booking, see today's
// check-ins/check-outs, and pull an availability grid.
//
// Protected by a shared secret. Requires an environment variable ADMIN_KEY
// to be set on the Vercel project (Project Settings -> Environment Variables)
// -- pick any private passphrase. Pass it as ?key=... or header x-admin-key.
//
// GET  /api/admin?action=list&key=...              pending holds only
// GET  /api/admin?action=list-all&key=...           every booking (confirmed+pending+cancelled)
// GET  /api/admin?action=today&key=...              today's arrivals & departures (Africa/Lagos)
// GET  /api/admin?action=grid&key=...&days=14       per-room-type remaining-inventory grid
// POST /api/admin?action=confirm&key=...   body: { reference }
// POST /api/admin?action=cancel&key=...    body: { reference }

const ROOM_INVENTORY = {
  'classic': 50,
  'executive': 14,
  'superior': 8,
  'executive-superior': 15,
  'signature-suite': 3,
  'apartment': 4,
  'city-view': 1
};

const ROOM_DISPLAY_NAMES = {
  'classic': 'Classic',
  'executive': 'Executive',
  'superior': 'Superior',
  'executive-superior': 'Executive Superior',
  'signature-suite': 'Signature Suite',
  'apartment': 'Apartment',
  'city-view': 'City View'
};

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

// Today's date string (YYYY-MM-DD) in Africa/Lagos, which is UTC+1 with no DST.
function lagosToday() {
  const now = new Date();
  const lagos = new Date(now.getTime() + 60 * 60 * 1000);
  return lagos.toISOString().slice(0, 10);
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

async function fetchBookingsByRefs(redisConfig, refs) {
  if (refs.length === 0) return [];
  const commands = refs.map(ref => ['GET', 'booking:' + ref]);
  const results = await redisPipeline(redisConfig, commands);
  return results
    .map(r => {
      if (!r || !r.result) return null;
      try { return JSON.parse(r.result); } catch (e) { return null; }
    })
    .filter(Boolean);
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
      const bookings = await fetchBookingsByRefs(redisConfig, refs);
      res.status(200).json({ success: true, bookings });
      return;
    }

    if (action === 'list-all' && req.method === 'GET') {
      const refsRes = await redisPipeline(redisConfig, [['ZREVRANGE', 'all-bookings', 0, 499]]);
      const refs = (refsRes[0] && refsRes[0].result) || [];
      const bookings = await fetchBookingsByRefs(redisConfig, refs);
      res.status(200).json({ success: true, bookings });
      return;
    }

    if (action === 'today' && req.method === 'GET') {
      const refsRes = await redisPipeline(redisConfig, [['ZREVRANGE', 'all-bookings', 0, 999]]);
      const refs = (refsRes[0] && refsRes[0].result) || [];
      const bookings = await fetchBookingsByRefs(redisConfig, refs);
      const today = lagosToday();
      const active = bookings.filter(b => b.status === 'confirmed' || b.status === 'pending');
      const arrivals = active.filter(b => b.checkin === today);
      const departures = active.filter(b => b.checkout === today);
      const inHouse = active.filter(b => b.checkin <= today && b.checkout > today);
      res.status(200).json({ success: true, date: today, arrivals, departures, inHouse });
      return;
    }

    if (action === 'grid' && req.method === 'GET') {
      const days = Math.min(Math.max(parseInt(params.get('days') || '14', 10) || 14, 1), 60);
      const today = lagosToday();
      const start = new Date(today + 'T00:00:00Z');
      const dateList = [];
      for (let i = 0; i < days; i++) {
        const d = new Date(start);
        d.setUTCDate(d.getUTCDate() + i);
        dateList.push(d.toISOString().slice(0, 10));
      }
      const slugs = Object.keys(ROOM_INVENTORY);
      const commands = [];
      slugs.forEach(slug => {
        dateList.forEach(d => {
          commands.push(['GET', 'booked:' + slug + ':' + d]);
          commands.push(['ZCOUNT', 'hold:' + slug + ':' + d, Math.floor(Date.now() / 1000), '+inf']);
        });
      });
      const results = await redisPipeline(redisConfig, commands);
      const grid = {};
      let idx = 0;
      slugs.forEach(slug => {
        grid[slug] = { roomType: ROOM_DISPLAY_NAMES[slug] || slug, total: ROOM_INVENTORY[slug], days: {} };
        dateList.forEach(d => {
          const bookedRes = results[idx++];
          const holdRes = results[idx++];
          const booked = parseInt((bookedRes && bookedRes.result) || '0', 10) || 0;
          const held = parseInt((holdRes && holdRes.result) || '0', 10) || 0;
          const remaining = Math.max(ROOM_INVENTORY[slug] - booked - held, 0);
          grid[slug].days[d] = { booked, held, remaining };
        });
      });
      res.status(200).json({ success: true, days: dateList, grid });
      return;
    }

    if (action === 'backfill-index' && req.method === 'GET') {
      // One-time maintenance action: scans for booking:* records created
      // before the all-bookings index existed and adds them to it, so
      // "All Bookings" / "Today" reflect historical data too. Safe to
      // re-run any time -- ZADD on an existing member just updates score.
      const keysRes = await redisPipeline(redisConfig, [['KEYS', 'booking:*']]);
      const keys = (keysRes[0] && keysRes[0].result) || [];
      if (keys.length === 0) {
        res.status(200).json({ success: true, scanned: 0, indexed: 0 });
        return;
      }
      const getCommands = keys.map(k => ['GET', k]);
      const getResults = await redisPipeline(redisConfig, getCommands);
      const addCommands = [];
      let indexed = 0;
      getResults.forEach((r, i) => {
        if (!r || !r.result) return;
        let record;
        try { record = JSON.parse(r.result); } catch (e) { return; }
        if (!record || !record.reference) return;
        const ts = record.recordedAt ? Math.floor(new Date(record.recordedAt).getTime() / 1000) : Math.floor(Date.now() / 1000);
        addCommands.push(['ZADD', 'all-bookings', ts, record.reference]);
        indexed++;
      });
      if (addCommands.length > 0) {
        await redisPipeline(redisConfig, addCommands);
      }
      res.status(200).json({ success: true, scanned: keys.length, indexed });
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

    res.status(400).json({ success: false, message: 'Unknown action. Use list, list-all, today, grid, backfill-index (GET), confirm or cancel (POST).' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Admin action failed', detail: String(err) });
  }
};
