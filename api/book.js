// Vercel serverless function: /api/book
//
// Public endpoint used by the website's "I've Paid" (bank transfer) button.
// It can ONLY place a temporary hold: nobody has verified the money yet, so
// the room is held for HOLD_TTL_HOURS and staff confirm or cancel it in
// admin.html. Card / Google Pay bookings are never written here; they are
// recorded by /api/verify-payment and /api/verify-flutterwave after the
// payment provider confirms the payment server-side. Any "source" sent by the
// browser is ignored.
//
// POST body: { roomType, checkin, checkout, reference, guestName, guestEmail, guestPhone }
//   roomType  - display name, e.g. "Executive Superior" (matches room cards)
//   checkin   - YYYY-MM-DD (today or later, Africa/Lagos)
//   checkout  - YYYY-MM-DD, after checkin, at most 60 nights
//   reference - 6-64 characters: letters, numbers, - or _ ; must be new
//
// Responses: 200 { success, status:'pending', holdHours, holdExpiresAt, ... }
//            400 bad input · 409 { code:'no-availability' | 'duplicate-reference' }

const { getRedisConfig, readBody, createBankHold } = require('./_booking');

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

  const body = (await readBody(req)) || {};
  if (!body.roomType || !body.checkin || !body.checkout) {
    res.status(400).json({ success: false, message: 'roomType, checkin and checkout are required' });
    return;
  }

  try {
    const result = await createBankHold(redisConfig, {
      roomType: body.roomType,
      checkin: body.checkin,
      checkout: body.checkout,
      reference: body.reference,
      guest: { guestName: body.guestName, guestEmail: body.guestEmail, guestPhone: body.guestPhone }
    });
    if (!result.ok) {
      res.status(result.httpStatus).json({ success: false, code: result.code, message: result.message, fullNights: result.fullNights });
      return;
    }
    res.status(200).json({
      success: true,
      status: 'pending',
      roomType: result.record.roomType,
      checkin: result.record.checkin,
      checkout: result.record.checkout,
      nights: result.nights,
      reference: result.record.reference,
      holdHours: result.holdHours,
      holdExpiresAt: new Date(result.record.expiresAt * 1000).toISOString()
    });
  } catch (err) {
    console.error('Failed to record bank-transfer hold:', err);
    res.status(500).json({ success: false, message: 'Failed to record booking' });
  }
};
