// FirstPromoter referral tracking.
//
// Two halves make attribution work:
//   1. This file (client) — loads FirstPromoter's tracking script and reports a
//      signup with the user's email + Supabase user id.
//   2. api/stripe-checkout.js (server) — stamps `fp_uid` onto the Stripe
//      customer metadata so FirstPromoter can match the paying customer back to
//      the referral even if the email later changes.
//
// Everything here no-ops safely when VITE_FIRSTPROMOTER_ID is unset, so the app
// behaves identically before FirstPromoter is switched on.

const FP_ID = import.meta.env.VITE_FIRSTPROMOTER_ID

let loadPromise = null

/** Inject FirstPromoter's tracking script exactly once. Safe to call repeatedly. */
export function loadFirstPromoter() {
  if (!FP_ID) return Promise.resolve(false)
  if (typeof window === 'undefined') return Promise.resolve(false)
  if (loadPromise) return loadPromise

  loadPromise = new Promise((resolve) => {
    // Already present (e.g. injected in index.html) — nothing to do.
    if (window.$FPROM) return resolve(true)

    const s = document.createElement('script')
    s.src = 'https://cdn.firstpromoter.com/fpr.js'
    s.async = true
    s.dataset.fpr = FP_ID
    // fpr.js reads this global for its account id.
    window.$FPROM = window.$FPROM || []
    s.onload = () => resolve(true)
    s.onerror = () => {
      console.warn('[fp] tracking script failed to load; referrals will not be attributed')
      resolve(false)
    }
    document.head.appendChild(s)
  })
  return loadPromise
}

/**
 * Report a new signup so FirstPromoter can bind the visitor's referral cookie
 * to this account. Call once, right after a user first signs in/registers.
 *
 * Never throws and never blocks auth — a broken analytics call must not stop
 * someone from using the app.
 */
export async function trackSignup(user) {
  if (!FP_ID || !user?.email) return
  try {
    await loadFirstPromoter()
    if (typeof window.$FPROM?.trackSignup === 'function') {
      window.$FPROM.trackSignup({ email: user.email, uid: user.id })
    }
  } catch (err) {
    console.warn('[fp] trackSignup failed (non-fatal):', err?.message || err)
  }
}

/**
 * The current referral tracking id, if this visitor arrived via an affiliate
 * link. Useful for debugging attribution; not required for the flow above.
 */
export function getTrackingId() {
  try {
    return window.$FPROM?.data?.tid || null
  } catch {
    return null
  }
}
