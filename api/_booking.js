// Shared booking logic for the serverless functions. The leading underscore
// keeps Vercel from exposing this file as its own /api route.
//
// Two ways a booking can be written:
//   recordVerifiedPayment() - called ONLY from verify-payment / verify-flutterwave
//     after the provider has confirmed the payment server-side. Checks the
//     amount paid against the room rate before treating the room as sold.
//   createBankHold() - called from /api/book for bank-transfer "I've paid"
//     claims. Always a temporary hold that staff confirm in admin.html.
//
// Every write first claims booking:<reference> with SET NX, so a reference can
// never overwrite an existing booking and a payment verified twice (for example
// after a page refresh) is only counted once.

const ROOM_INVENTORY = {
  'classic': 50,
  'executive': 14,
  'superior': 8,
  'executive-superior': 15,
  'signature-suite': 3,
  'apartment': 4,
  'city-view': 1
};

// Nightly rates in naira. Keep in sync with the room cards in index.html.
const ROOM_RATES = {
  'classic': 145000,
  'executive': 160000,
  'superior': 180000,
  'executive-superior': 200000,
  'signature-suite': 250000,
  'apartment': 450000,
  'city-view': 550000
};

// Bank-transfer claim: how long the room is held before it auto-releases.
const HOLD_TTL_HOURS = 4;
// Paid online but the amount or currency didn't match: hold longer, since the
// guest has paid something and staff need time to sort it out.
const REVIEW_HOLD_HOURS = 24;
const MAX_NIGHTS = 60;

const REF_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, '-');
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

// Africa/Lagos is UTC+1 with no DST.
function lagosToday() {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
}

function clean(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function cleanGuest(g) {
  g = g || {};
  return {
    guestName: clean(g.guestName, 100),
    guestEmail: clean(g.guestEmail, 160),
    guestPhone: clean(g.guestPhone, 40)
  };
}

// Returns { ok: true, slug, roomType, nights, expected } or { ok: false, message }.
function validateStay(roomType, checkin, checkout) {
  const slug = slugify(roomType);
  if (!Object.prototype.hasOwnProperty.call(ROOM_INVENTORY, slug)) {
    return { ok: false, message: 'Unknown room type' };
  }
  if (!DATE_PATTERN.test(String(checkin)) || !DATE_PATTERN.test(String(checkout))) {
    return { ok: false, message: 'checkin and checkout must be YYYY-MM-DD' };
  }
  const a = Date.parse(checkin + 'T00:00:00Z');
  const b = Date.parse(checkout + 'T00:00:00Z');
  if (!isFinite(a) || !isFinite(b) || new Date(a).toISOString().slice(0, 10) !== checkin || new Date(b).toISOString().slice(0, 10) !== checkout) {
    return { ok: false, message: 'Invalid date' };
  }
  const nights = datesBetween(checkin, checkout).slice(0, -1);
  if (nights.length === 0) return { ok: false, message: 'checkout must be after checkin' };
  if (nights.length > MAX_NIGHTS) return { ok: false, message: 'Stays longer than ' + MAX_NIGHTS + ' nights must be booked with the hotel directly' };
  return { ok: true, slug, nights, expected: ROOM_RATES[slug] * nights.length };
}

// Nights on which no unit of this room type is free (counting confirmed
// bookings plus holds that haven't expired).
async function fullNights(config, slug, nights) {
  const nowSec = Math.floor(Date.now() / 1000);
  const commands = [];
  nights.forEach(d => {
    commands.push(['GET', 'booked:' + slug + ':' + d]);
    commands.push(['ZCOUNT', 'hold:' + slug + ':' + d, nowSec, '+inf']);
  });
  const results = await redisPipeline(config, commands);
  const full = [];
  nights.forEach((d, i) => {
    const booked = parseInt((results[i * 2] && results[i * 2].result) || '0', 10) || 0;
    const held = parseInt((results[i * 2 + 1] && results[i * 2 + 1].result) || '0', 10) || 0;
    if (ROOM_INVENTORY[slug] - booked - held < 1) full.push(d);
  });
  return full;
}

// Atomically claims booking:<ref>. Returns true if this call created it.
async function claimReference(config, reference, record) {
  const res = await redisPipeline(config, [['SET', 'booking:' + reference, JSON.stringify(record), 'NX']]);
  return !!(res[0] && res[0].result === 'OK');
}

async function readBooking(config, reference) {
  const res = await redisPipeline(config, [['GET', 'booking:' + reference]]);
  const raw = res[0] && res[0].result;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function holdCommands(slug, nights, reference, expiresAt, nowSec) {
  const commands = nights.map(d => ['ZADD', 'hold:' + slug + ':' + d, expiresAt, reference]);
  commands.push(['ZADD', 'pending-bookings', nowSec, reference]);
  commands.push(['ZADD', 'all-bookings', nowSec, reference]);
  return commands;
}

/**
 * Record a booking for a payment the provider has already verified.
 * amountPaid is in naira (convert kobo before calling). Returns
 * { status: 'confirmed' | 'pending' | 'duplicate' | 'invalid', ... }.
 */
async function recordVerifiedPayment(config, opts) {
  const reference = String(opts.reference || '');
  if (!REF_PATTERN.test(reference)) return { status: 'invalid', message: 'Bad reference' };
  const stay = validateStay(opts.roomType, opts.checkin, opts.checkout);
  if (!stay.ok) return { status: 'invalid', message: stay.message };

  const nowSec = Math.floor(Date.now() / 1000);
  const guest = cleanGuest(opts.guest);
  const currency = String(opts.currency || '').toUpperCase();
  const paid = Number(opts.amountPaid) || 0;
  const amountOk = currency === 'NGN' && paid + 1 >= stay.expected; // ₦1 rounding tolerance

  const base = {
    roomType: opts.roomType, checkin: opts.checkin, checkout: opts.checkout,
    reference, source: opts.source, ...guest,
    amountPaid: paid, currency, expectedAmount: stay.expected,
    recordedAt: new Date().toISOString()
  };

  if (amountOk) {
    const full = await fullNights(config, stay.slug, stay.nights);
    const record = Object.assign({}, base, { status: 'confirmed' });
    if (full.length) record.note = 'Paid online, but this room type was already full on ' + full.join(', ') + '. Check room allocation.';
    if (!(await claimReference(config, reference, record))) {
      return { status: 'duplicate', booking: await readBooking(config, reference) };
    }
    const commands = stay.nights.map(d => ['INCR', 'booked:' + stay.slug + ':' + d]);
    commands.push(['ZADD', 'all-bookings', nowSec, reference]);
    await redisPipeline(config, commands);
    return { status: 'confirmed', booking: record };
  }

  // Paid, but less than the room costs (or in another currency): hold the
  // room for staff to review rather than treating it as sold.
  const expiresAt = nowSec + REVIEW_HOLD_HOURS * 3600;
  const record = Object.assign({}, base, {
    status: 'pending', expiresAt,
    note: 'Paid ' + (currency || '?') + ' ' + paid.toLocaleString('en-NG') + ' online, expected NGN ' + stay.expected.toLocaleString('en-NG') + '. Check before confirming.'
  });
  if (!(await claimReference(config, reference, record))) {
    return { status: 'duplicate', booking: await readBooking(config, reference) };
  }
  await redisPipeline(config, holdCommands(stay.slug, stay.nights, reference, expiresAt, nowSec));
  return { status: 'pending', booking: record };
}

/**
 * Bank-transfer claim from the website. Never confirms anything: it places a
 * short hold that staff confirm or cancel in admin.html.
 * Returns { ok: true, record, holdHours } or { ok: false, httpStatus, code, message }.
 */
async function createBankHold(config, opts) {
  const reference = String(opts.reference || '');
  if (!REF_PATTERN.test(reference)) {
    return { ok: false, httpStatus: 400, code: 'bad-reference', message: 'reference must be 6-64 letters, numbers, - or _' };
  }
  const stay = validateStay(opts.roomType, opts.checkin, opts.checkout);
  if (!stay.ok) return { ok: false, httpStatus: 400, code: 'bad-request', message: stay.message };
  if (opts.checkin < lagosToday()) {
    return { ok: false, httpStatus: 400, code: 'bad-request', message: 'checkin cannot be in the past' };
  }

  const full = await fullNights(config, stay.slug, stay.nights);
  if (full.length) {
    return { ok: false, httpStatus: 409, code: 'no-availability', fullNights: full, message: 'Sorry, this room is fully booked on ' + full.join(', ') + '.' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = nowSec + HOLD_TTL_HOURS * 3600;
  const record = {
    roomType: opts.roomType, checkin: opts.checkin, checkout: opts.checkout,
    reference, source: 'bank_transfer', ...cleanGuest(opts.guest),
    expectedAmount: stay.expected,
    status: 'pending', recordedAt: new Date().toISOString(), expiresAt
  };
  if (!(await claimReference(config, reference, record))) {
    return { ok: false, httpStatus: 409, code: 'duplicate-reference', message: 'That booking reference is already in use' };
  }
  await redisPipeline(config, holdCommands(stay.slug, stay.nights, reference, expiresAt, nowSec));
  return { ok: true, record, holdHours: HOLD_TTL_HOURS, nights: stay.nights.length };
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
    req.on('data', chunk => { data += chunk; if (data.length > 20000) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); }
    });
  });
}

module.exports = {
  ROOM_INVENTORY, ROOM_RATES, HOLD_TTL_HOURS, REVIEW_HOLD_HOURS,
  getRedisConfig, redisPipeline, readBody, validateStay,
  recordVerifiedPayment, createBankHold
};
