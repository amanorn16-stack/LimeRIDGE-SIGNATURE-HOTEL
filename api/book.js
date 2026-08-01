// Vercel serverless function: /api/book
//
// Records a booking against room inventory in Upstash Redis, so
// /api/availability reflects it immediately for every visitor.
//
// Two kinds of writes:
//   - Verified payments (Paystack/Flutterwave): PERMANENT. We only get here
//     after the payment has already been confirmed server-side, so the room
//     is immediately and permanently taken.
//   - Bank transfer claims: TEMPORARY HOLD. Nobody has verified the money
//     actually moved yet, so this is a soft hold that auto-expires after
//     HOLD_TTL_HOURS unless staff confirms it via /api/admin (which converts
//     it into a permanent booking). This stops a no-show or fake "I've Paid"
//     click from blocking the room forever.
//
// POST body: { roomType, checkin, checkout, reference, source, guestName, guestEmail, guestPhone }
//   roomType  - display name, e.g. "Executive Superior" (matches room cards)
//   checkin   - YYYY-MM-DD
//   checkout  - YYYY-MM-DD
//   reference - unique booking/payment reference (for the audit record)
//   source    - "paystack" | "flutterwave" | "bank_transfer"
//   guestName, guestEmail, guestPhone - optional guest contact info, stored
//     on the booking record so staff can identify who a booking belongs to.

const ROOM_INVENTORY = {
  'classic': 50,
  'executive': 14,
  'superior': 8,
  'executive-superior': 15,
  'signature-suite': 3,
  'apartment': 4,
  'city-view': 1
};

// How long a bank-transfer "I've Paid" claim holds the room before it
// auto-releases if staff hasn't confirmed it. Edit this single number to
// change the window.
const HOLD_TTL_HOURS = 4;

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
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, message: 'Use POST' });
    return;
  }

  const redisConfig = getRedisConfig();
  if (!redisConfig) {
    res.status(500).json({
      success: false,
      message: 'Storage not configured yet. Connect an Upstash for Redis integration to this Vercel project (Storage tab).'
    });
    return;
  }

  const body = await readBody(req);
  const { roomType, checkin, checkout, reference, source, guestName, guestEmail, guestPhone } = body || {};

  if (!roomType || !checkin || !checkout) {
    res.status(400).json({ success: false, message: 'roomType, checkin and checkout are required' });
    return;
  }

  const slug = slugify(roomType);
  if (!ROOM_INVENTORY.hasOwnProperty(slug)) {
    res.status(400).json({ success: false, message: 'Unknown room type: ' + roomType });
    return;
  }

  const allDates = datesBetween(checkin, checkout);
  const nights = allDates.slice(0, -1);
  if (nights.length === 0) {
    res.status(400).json({ success: false, message: 'checkout must be after checkin' });
    return;
  }

  const ref = reference || (slug + ':' + Date.now());
  const isVerifiedPayment = source === 'paystack' || source === 'flutterwave';
  const now = Math.floor(Date.now() / 1000);
  const guest = {
    guestName: guestName || '',
    guestEmail: guestEmail || '',
    guestPhone: guestPhone || ''
  };

  try {
    const commands = [];

    if (isVerifiedPayment) {
      nights.forEach(d => commands.push(['INCR', 'booked:' + slug + ':' + d]));
      const bookingRecord = {
        roomType, checkin, checkout, reference: ref, source, ...guest,
        status: 'confirmed', recordedAt: new Date().toISOString()
      };
      commands.push(['SET', 'booking:' + ref, JSON.stringify(bookingRecord)]);
    } else {
      const expiresAt = now + HOLD_TTL_HOURS * 3600;
      nights.forEach(d => commands.push(['ZADD', 'hold:' + slug + ':' + d, expiresAt, ref]));
      commands.push(['ZADD', 'pending-bookings', now, ref]);
      const bookingRecord = {
        roomType, checkin, checkout, reference: ref, source: source || 'bank_transfer', ...guest,
        status: 'pending', recordedAt: new Date().toISOString(), expiresAt
      };
      commands.push(['SET', 'booking:' + ref, JSON.stringify(bookingRecord)]);
    }

    // Global index of every booking (confirmed + pending) so staff tooling
    // can list/search all bookings without scanning every date key.
    commands.push(['ZADD', 'all-bookings', now, ref]);

    await redisPipeline(redisConfig, commands);

    const response = { success: true, roomType, checkin, checkout, nights: nights.length, reference: ref };
    if (!isVerifiedPayment) {
      response.status = 'pending';
      response.holdExpiresAt = new Date((now + HOLD_TTL_HOURS * 3600) * 1000).toISOString();
      response.holdHours = HOLD_TTL_HOURS;
    }
    res.status(200).json(response);
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to record booking', detail: String(err) });
  }
};
