// Starts a Stripe Checkout session for a Pro plan — Chatwillow Pro ($5/mo) or Alicia
// Pro ($10/mo, Job-Assistant), selected by `product` in the request body. The caller
// must be signed in (Supabase access token in the Authorization header) so we know
// which user to attach the Stripe customer/subscription to.

import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const SUPABASE_URL = 'https://boleszqdqphfxxwizyoo.supabase.co'
const supabaseAdmin = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'Sign in required.' })

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token)
  if (userErr || !userData?.user) return res.status(401).json({ error: 'Sign in required.' })
  const user = userData.user

  // product 'alicia' = Job-Assistant (Alicia) Pro, a separate Stripe price. Checkout
  // opened from the extension has a chrome-extension:// origin, which Stripe rejects
  // as a redirect target — send those users back to the Chatwillow site instead.
  const product = req.body?.product === 'alicia' ? 'alicia' : 'chatwillow'
  const priceId = product === 'alicia'
    ? process.env.STRIPE_ALICIA_PRICE_ID
    : process.env.STRIPE_PRICE_ID
  if (!priceId) return res.status(500).json({ error: 'Billing not configured for this product.' })

  const rawOrigin = req.headers.origin || `https://${req.headers.host}`
  const origin = /^https?:\/\//i.test(rawOrigin) ? rawOrigin : 'https://chatwillow.com'

  try {
    // Reuse the Stripe customer we already created for this user, if any — product-
    // agnostic, so a user buying their second product (Chatwillow or Alicia) still
    // lands on the same Stripe Customer object instead of creating a duplicate.
    const { data: existing } = await supabaseAdmin
      .from('stripe_customers')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle()

    let customerId = existing?.stripe_customer_id
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { supabase_user_id: user.id },
      })
      customerId = customer.id
      await supabaseAdmin
        .from('stripe_customers')
        .upsert({ user_id: user.id, stripe_customer_id: customerId, created_at: Date.now() }, { onConflict: 'user_id' })
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: user.id,
      line_items: [{ price: priceId, quantity: 1 }],
      // Stamped onto the Subscription object too, so every subscription.* webhook
      // event carries the Supabase user id and product without a customer-id lookup.
      subscription_data: { metadata: { supabase_user_id: user.id, product } },
      allow_promotion_codes: true,
      success_url: `${origin}/?checkout=success&product=${product}`,
      cancel_url: `${origin}/?checkout=cancel`,
    })

    res.status(200).json({ url: session.url })
  } catch (err) {
    console.error('Checkout session failed:', err.message)
    res.status(500).json({ error: 'Could not start checkout.' })
  }
}
