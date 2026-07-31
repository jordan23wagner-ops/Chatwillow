// Releases the per-user burst/concurrency lock acquired by api/usage-check.js, once the
// caller's AI call has finished (success or failure). Best-effort from the caller's side —
// if this never gets called (tab closed, crash), usage-check.js's 90s staleness check
// self-heals the lock on the next attempt.

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://boleszqdqphfxxwizyoo.supabase.co'
const supabaseAdmin = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { feature } = req.body || {}
  if (feature !== 'scan' && feature !== 'tailor') {
    return res.status(400).json({ error: 'Unknown feature.' })
  }

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'Sign in required.' })

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token)
  if (userErr || !userData?.user) return res.status(401).json({ error: 'Sign in required.' })

  await supabaseAdmin
    .from('in_flight_requests')
    .delete()
    .eq('user_id', userData.user.id)
    .eq('feature', feature)

  res.status(200).json({ released: true })
}
