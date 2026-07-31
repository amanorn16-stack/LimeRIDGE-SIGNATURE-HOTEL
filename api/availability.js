// Vercel serverless function: /api/availability
//
// Reads real booking counts from Upstash Redis (connected via Vercel Storage
// marketplace) to report live room availability and per-night pricing.
//
// TWO MODES:
//  1. Calendar mode: GET /api/availability?start=YYYY-MM-DD&end=YYYY-MM-DD
//     -> { "2026-08-05": { price: 145000, soldOut: false }, ... }
//     Price shown per date is the lowest nightly rate among room types that
//     still have at least one room free that night.
//
//  2. Single-room range check: GET /api/availability?roomType=Classic&checkin=YYYY-MM-DD&checkout=YYYY-MM-DD
//     -> { available: true/false }
//     Used to gray out "Book Now" on a specific room card once dates are chosen.
//
// ROOM_INVENTORY below reflects the hotel's actual room counts per type.

const ROOM_INVENTORY = {
  'classic': 50,
  'executive': 14,
  'superior': 8,
  'executive-superior': 15,
  'signature-suite': 3,
  'apartment': 4,
  'city-view': 1
};

const ROOM_RATES = {
  'classic': 145000,
  'executive': 160000,
  'superior': 180000,
  'executive-superior': 200000,
  'signature-suite': 250000,
  'apartment': 450000,
  'city-view': 550000
};

const MAX_RANGE_DAYS = 95;

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

module.exports = async (req, res) => {
  const reqUrl = new URL(req.url, 'http://localhost');
  const params = reqUrl.searchParams;

  const redisConfig = getRedisConfig();
  if (!redisConfig) {
    res.status(500).json({
      error: 'Storage not configured yet. Connect an Upstash for Redis integration to this Vercel project (Storage tab) so live availability has somewhere to read/write bookings.'
    });
    return;
  }

  const roomType = params.get('roomType');
  const checkin = params.get('checkin');
  const checkout = params.get('checkout');
  const start = params.get('start');
  const end = params.get('end');

  try {
    // Mode 2: single room, range availability check
    if (roomType && checkin && checkout) {
      const slug = slugify(roomType);
      if (!ROOM_INVENTORY.hasOwnProperty(slug)) {
        res.status(400).json({ error: 'Unknown room type' });
        return;
      }
      const allDates = datesBetween(checkin, checkout);
      const nights = allDates.slice(0, -1);
      if (nights.length === 0) {
        res.status(200).json({ available: true, remaining: ROOM_INVENTORY[slug] });
        return;
      }
      const nowEpoch = Math.floor(Date.now() / 1000);
      const commands = [];
      nights.forEach(d => {
        commands.push(['GET', 'booked:' + slug + ':' + d]);
        commands.push(['ZCOUNT', 'hold:' + slug + ':' + d, nowEpoch, '+inf']);
      });
      const results = await redisPipeline(redisConfig, commands);
      let available = true;
      let minRemaining = ROOM_INVENTORY[slug];
      for (let i = 0; i < nights.length; i++) {
        const booked = parseInt(results[i * 2] && results[i * 2].result, 10) || 0;
        const activeHolds = parseInt(results[i * 2 + 1] && results[i * 2 + 1].result, 10) || 0;
        const remainingForNight = ROOM_INVENTORY[slug] - booked - activeHolds;
        if (remainingForNight < minRemaining) minRemaining = remainingForNight;
        if (booked + activeHolds >= ROOM_INVENTORY[slug]) {
          available = false;
        }
      }
      res.status(200).json({ available, remaining: Math.max(0, minRemaining) });
      return;
    }

    // Mode 1: calendar price/availability for a date range
    if (start && end) {
      const dates = datesBetween(start, end);
      if (dates.length > MAX_RANGE_DAYS) {
        res.status(400).json({ error: 'Range too large' });
        return;
      }
      const slugs = Object.keys(ROOM_INVENTORY);
      const nowEpoch = Math.floor(Date.now() / 1000);
      const commands = [];
      dates.forEach(d => {
        slugs.forEach(slug => {
          commands.push(['GET', 'booked:' + slug + ':' + d]);
          commands.push(['ZCOUNT', 'hold:' + slug + ':' + d, nowEpoch, '+inf']);
        });
      });
      const results = commands.length ? await redisPipeline(redisConfig, commands) : [];

      const out = {};
      let cursor = 0;
      dates.forEach(d => {
        let lowestPrice = null;
        let anyAvailable = false;
        slugs.forEach(slug => {
          const bookedR = results[cursor]; cursor += 1;
          const holdsR = results[cursor]; cursor += 1;
          const booked = parseInt(bookedR && bookedR.result, 10) || 0;
          const activeHolds = parseInt(holdsR && holdsR.result, 10) || 0;
          const remaining = ROOM_INVENTORY[slug] - booked - activeHolds;
          if (remaining > 0) {
            anyAvailable = true;
            if (lowestPrice === null || ROOM_RATES[slug] < lowestPrice) {
              lowestPrice = ROOM_RATES[slug];
            }
          }
        });
        out[d] = {
          price: lowestPrice,
          soldOut: !anyAvailable
        };
      });

      res.status(200).json(out);
      return;
    }

    res.status(400).json({ error: 'Provide either (start & end) or (roomType & checkin & checkout)' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read availability', detail: String(err) });
  }
};
