// Vercel serverless function: /api/verify-flutterwave
// Verifies a Flutterwave transaction server-side using the secret key,
// so Google Pay bookings are only confirmed after a real, verified payment.
//
// Requires an environment variable FLUTTERWAVE_SECRET_KEY to be set on the
// Vercel project (Project Settings -> Environment Variables).
//
// The booking is written directly from here (not via the public /api/book),
// using the room, dates and amount Flutterwave reports for the verified
// transaction. If the amount paid is less than the stay costs, the room is
// held for staff review instead of being marked as sold.

const { getRedisConfig, recordVerifiedPayment } = require('./_booking');
module.exports = async (req, res) => {
  let transactionId = null;
  if (req.query && req.query.transaction_id) {
    transactionId = req.query.transaction_id;
  } else if (req.url) {
    const match = req.url.match(/[?&]transaction_id=([^&]+)/);
    if (match) transactionId = decodeURIComponent(match[1]);
  }

  if (!transactionId) {
    res.status(400).json({ success: false, message: 'Missing transaction_id' });
    return;
  }

  const secretKey = process.env.FLUTTERWAVE_SECRET_KEY;
  if (!secretKey) {
    res.status(500).json({
      success: false,
      message: 'Server is not configured with a Flutterwave secret key yet. Add FLUTTERWAVE_SECRET_KEY in Vercel project settings.'
    });
    return;
  }

  try {
    const response = await fetch(
      'https://api.flutterwave.com/v3/transactions/' + encodeURIComponent(transactionId) + '/verify',
      { headers: { Authorization: 'Bearer ' + secretKey } }
    );
    const data = await response.json();

    if (data && data.status === 'success' && data.data && data.data.status === 'successful') {
      let bookingStatus = 'not-recorded';
      try {
        const meta = data.data.meta || data.data.meta_data || data.data.metadata || {};
        const customer = data.data.customer || {};
        const redisConfig = getRedisConfig();
        if (redisConfig && meta.room && meta.checkin && meta.checkout) {
          const result = await recordVerifiedPayment(redisConfig, {
            roomType: meta.room,
            checkin: meta.checkin,
            checkout: meta.checkout,
            reference: data.data.tx_ref,
            source: 'flutterwave',
            amountPaid: Number(data.data.amount) || 0, // Flutterwave reports naira
            currency: data.data.currency,
            guest: {
              guestName: customer.name || meta.guest_name || '',
              guestEmail: customer.email || '',
              guestPhone: customer.phone_number || meta.guest_phone || ''
            }
          });
          bookingStatus = result.status === 'duplicate' ? ((result.booking && result.booking.status) || 'confirmed') : result.status;
        }
      } catch (bookingErr) {
        console.error('Failed to record booking after Flutterwave payment:', bookingErr);
      }
      res.status(200).json({
        success: true,
        booking: bookingStatus,
        status: data.data.status,
        amount: data.data.amount,
        currency: data.data.currency,
        reference: data.data.tx_ref,
        processor_response: data.data.processor_response
      });
    } else {
      res.status(200).json({
        success: false,
        status: (data && data.data && data.data.status) || 'unknown',
        message: (data && data.data && data.data.processor_response) || (data && data.message) || 'Verification failed'
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error verifying payment', error: String(err) });
  }
};
