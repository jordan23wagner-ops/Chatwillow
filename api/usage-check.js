// Checks + increments a signed-in user's monthly free-tier usage for one of
// Job-Assistant's metered AI features (LinkedIn scan/rank, résumé tailoring) before the
// caller does the actual AI call. Kept separate from api/chat.js on purpose: chat.js has
// its own unrelated time-based/daily quota system (usage_ledger) shared with Chatwillow's
// own web chat traffic, and these prompts are single-shot, not streamed conversation — a
// bug here shouldn't be able to take down live chat.
//
// Also owns the per-user burst/concurrency lock (in_flight_requests): at most one scan or
// tailor request in flight per user at a time, released by api/usage-release.js after the
// caller's AI call finishes, or self-clearing after 90s if that release call never happens.

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://boleszqdqphfxxwizyoo.supabase.co'
const supabaseAdmin = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const FREE_LIMITS = { scan: 5, tailor: 5 }
const FEATURE_LABEL = { scan: 'LinkedIn scans', tailor: 'résumé tailors' }
const LOCK_TTL_MS = 90000

function monthStart() {
  const d = new Date()
  d.setUTCDate(1)
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString().slice(0, 10)
}

async function acquireLock(userId, feature) {
  const now = Date.now()
  const { data: existing } = await supabaseAdmin
    .from('in_flight_requests')
    .select('started_at')
    .eq('user_id', userId)
    .eq('feature', feature)
    .maybeSingle()
  if (existing && now - existing.started_at < LOCK_TTL_MS) return false
  await supabaseAdmin
    .from('in_flight_requests')
    .upsert({ user_id: userId, feature, started_at: now }, { onConflict: 'user_id,feature' })
  return true
}

async function releaseLock(userId, feature) {
  await supabaseAdmin.from('in_flight_requests').delete().eq('user_id', userId).eq('feature', feature)
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { feature } = req.body || {}
  if (feature !== 'scan' && feature !== 'tailor') {
    return res.status(400).json({ error: 'Unknown feature.' })
  }

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'Sign in required to use this feature.' })

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token)
  if (userErr || !userData?.user) return res.status(401).json({ error: 'Sign in required to use this feature.' })
  const userId = userData.user.id

  const lockOk = await acquireLock(userId, feature)
  if (!lockOk) {
    return res.status(429).json({ error: 'Please wait for your current request to finish.' })
  }

  try {
    const { data: sub } = await supabaseAdmin
      .from('subscriptions_v2')
      .select('plan,status')
      .eq('user_id', userId)
      .eq('product', 'alicia')
      .maybeSingle()
    const isPro = !!sub && ['active', 'trialing'].includes(sub.status) && sub.plan === 'alicia_pro'

    const { data, error } = await supabaseAdmin.rpc('check_and_increment_usage', {
      p_user_id: userId,
      p_feature: feature,
      p_period_start: monthStart(),
      p_limit: isPro ? 0 : FREE_LIMITS[feature],
    })
    if (error) throw error
    const row = data[0]

    if (!row.allowed) {
      await releaseLock(userId, feature)
      return res.status(429).json({
        error: `You've used all ${FREE_LIMITS[feature]} free ${FEATURE_LABEL[feature]} this month. Upgrade to Alicia Pro in Tools → Account for unlimited.`,
        upgrade: true,
      })
    }

    return res.status(200).json({ allowed: true, count: row.count })
  } catch (err) {
    await releaseLock(userId, feature)
    console.error('usage-check failed:', err.message)
    return res.status(500).json({ error: 'Could not check usage — try again.' })
  }
}
