import { createClient } from '@supabase/supabase-js'

// The anon key is public by design — Row Level Security in the database is
// what protects the data, not this string.
const SUPABASE_URL = 'https://yrgbnyoqyurtrisgbvai.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlyZ2JueW9xeXVydHJpc2didmFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzNzY0MTEsImV4cCI6MjEwMTk1MjQxMX0.ZXfDJtOX0s5avbBfPMMDZuBU2s3KG7pWgJnbWcwgrf4'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
})

// One anonymous session per device. No emails, no passwords —
// friends tap the link, type a team name, they're in.
export async function ensureSession() {
  const { data: { session } } = await supabase.auth.getSession()
  if (session) return session
  const { data, error } = await supabase.auth.signInAnonymously()
  if (error) throw new Error('Sign-in failed: ' + error.message)
  return data.session
}

/* ---------- surviving a lost session ----------
   An anonymous session lives in browser storage, and iOS clears that on
   its own schedule — after which signInAnonymously() quietly hands back a
   BRAND NEW user who owns no teams. The app then looks empty and the
   manager is told to type their recovery code again. That is what Aidan
   hit every single time he opened it.

   So: remember the recovery codes on this device, and if we ever wake up
   as a new user with no teams, re-claim them silently. The code the user
   was told to write down is now also the app's own repair kit. */
const VAULT = 'blitz-teams'

const readVault = () => {
  try { return JSON.parse(localStorage.getItem(VAULT) || '[]') } catch { return [] }
}
export function rememberTeam(joinCode, claimCode) {
  if (!joinCode || !claimCode) return
  try {
    const v = readVault().filter(x => x.join_code !== joinCode)
    v.push({ join_code: joinCode, claim_code: claimCode })
    localStorage.setItem(VAULT, JSON.stringify(v.slice(-25)))
  } catch {}
}
export function forgetTeam(joinCode) {
  try {
    localStorage.setItem(VAULT, JSON.stringify(readVault().filter(x => x.join_code !== joinCode)))
  } catch {}
}

/* Returns how many teams were reclaimed. Safe to call any time: claiming
   a team you already own is a no-op. */
export async function restoreTeams(uid) {
  const saved = readVault()
  if (!saved.length) return 0

  const { data: mine } = await supabase.from('teams').select('id').eq('owner_uid', uid).limit(1)
  if (mine && mine.length) return 0        // session is fine, nothing to repair

  let restored = 0
  for (const t of saved) {
    const { error } = await supabase.rpc('claim_team', {
      p_join_code: t.join_code, p_claim_code: t.claim_code,
    })
    if (!error) restored++
    // a league that was deleted will error forever — drop it so we don't
    // retry it on every launch
    else if (/not found|no such|deleted/i.test(error.message || '')) forgetTeam(t.join_code)
  }
  return restored
}

/* PostgREST caps a single select at 1000 rows, and the player pool is
   bigger than that. Page through it so nobody silently disappears. */
export async function fetchAllPlayers() {
  const PAGE = 1000
  let from = 0, all = []
  for (;;) {
    const { data, error } = await supabase
      .from('players').select('*')
      .order('ppr', { ascending: false })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    all = all.concat(data)
    if (!data || data.length < PAGE) break
    from += PAGE
  }
  return all
}
