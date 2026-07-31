// Vercel serverless function: /api/verify-payment
// Verifies a Paystack transaction server-side using the secret key,
// so bookings are only confirmed after a real, verified payment.
//
// Requires an environment variable PAYSTACK_SECRET_KEY to be set on the
// Vercel project (Project Settings -> Environment Variables).

async function recordBooking(roomType, checkin, checkout, reference, source, req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  await fetch(proto + '://' + host + '/api/book', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomType, checkin, checkout, reference, source })
  });
}

module.exports = async (req, res) => {
  let reference = null;
  if (req.query && req.query.reference) {
    reference = req.query.reference;
  } else if (req.url) {
    const match = req.url.match(/[?&]reference=([^&]+)/);
    if (match) reference = decodeURIComponent(match[1]);
  }

  if (!reference) {
    res.status(400).json({ success: false, message: 'Missing reference' });
    return;
  }

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    res.status(500).json({
      success: false,
      message: 'Server is not configured with a Paystack secret key yet. Add PAYSTACK_SECRET_KEY in Vercel project settings.'
    });
    return;
  }

  try {
    const response = await fetch(
      'https://api.paystack.co/transaction/verify/' + encodeURIComponent(reference),
      { headers: { Authorization: 'Bearer ' + secretKey } }
    );
    const data = await response.json();

    if (data && data.status === true && data.data && data.data.status === 'success') {
      try {
        const meta = data.data.metadata || {};
        if (meta.room && meta.checkin && meta.checkout) {
          await recordBooking(meta.room, meta.checkin, meta.checkout, data.data.reference, 'paystack', req);
        }
      } catch (bookingErr) {
        // Never fail the payment confirmation because of an inventory-write hiccup.
        console.error('Failed to record booking after Paystack payment:', bookingErr);
      }
      res.status(200).json({
        success: true,
        status: data.data.status,
        amount: data.data.amount,
        currency: data.data.currency,
        reference: data.data.reference,
        gateway_response: data.data.gateway_response
      });
    } else {
      res.status(200).json({
        success: false,
        status: (data && data.data && data.data.status) || 'unknown',
        message: (data && data.data && data.data.gateway_response) || (data && data.message) || 'Verification failed'
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error verifying payment', error: String(err) });
  }
};
