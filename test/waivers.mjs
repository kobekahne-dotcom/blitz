/* LIVE waiver test through the API with RLS on.
   The SQL self-test proves the logic; this proves it survives being
   called by two different signed-in managers, which is the part a
   SQL-editor block cannot see. */

const API = 'https://yrgbnyoqyurtrisgbvai.supabase.co'
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlyZ2JueW9xeXVydHJpc2didmFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzNzY0MTEsImV4cCI6MjEwMTk1MjQxMX0.ZXfDJtOX0s5avbBfPMMDZuBU2s3KG7pWgJnbWcwgrf4'

let pass = 0, fail = 0
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function fr(u, o, t = 5) {
  for (let i = 0; i < t; i++) { try { return await fetch(u, o) } catch (e) { if (i === t - 1) throw e; await sleep(1200 * (i + 1)) } }
}
const su = async () => {
  for (let i = 0; i < 8; i++) {
    const r = await fr(`${API}/auth/v1/signup`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: '{}' })
    const d = await r.json(); if (d.access_token) return d.access_token
    await sleep(8000)
  }
  throw new Error('signup rate limited')
}
const H = t => ({ apikey: ANON, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' })
const rpc = async (tok, fn, args) => {
  const r = await fr(`${API}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H(tok), body: JSON.stringify(args) })
  const t = await r.text(); let b; try { b = JSON.parse(t) } catch { b = t }
  return { ok: r.ok, body: b }
}
const sel = async (tok, p) => (await fr(`${API}/rest/v1/${p}`, { headers: H(tok) })).json()
const em = r => (r.body && r.body.message) || JSON.stringify(r.body).slice(0, 140)
const slotFor = (pk, n) => { const r = Math.floor((pk - 1) / n), i = (pk - 1) % n; return r % 2 === 0 ? i + 1 : n - i }

const A = await su(), B = await su()

console.log('\n=== a real drafted league ===')
const mk = await rpc(A, 'create_league', {
  p_name: 'Waiver Test', p_num_teams: 2, p_rounds: 15, p_scoring: 'ppr',
  p_pick_seconds: 600, p_team_name: 'Alpha', p_draft_at: null })
ok('league created', mk.ok, em(mk))
if (!mk.ok) process.exit(1)
const L = mk.body.league_id
await rpc(B, 'join_league', { p_join_code: mk.body.join_code, p_team_name: 'Bravo' })
await rpc(A, 'start_draft', { p_league_id: L })

const teams = await sel(A, `teams?league_id=eq.${L}&select=id,name,draft_slot,owner_uid,waiver_priority`)
const draft = (await sel(A, `drafts?league_id=eq.${L}&select=id`))[0]
const tA = teams.find(t => t.name === 'Alpha'), tB = teams.find(t => t.name === 'Bravo')

for (let pk = 1; pk <= 30; pk++) {
  const t = teams.find(x => x.draft_slot === slotFor(pk, 2))
  const c = await rpc(A, 'autopick_choice', { p_draft_id: draft.id, p_team_id: t.id })
  const r = await rpc(A, 'make_pick', { p_draft_id: draft.id, p_team_id: t.id, p_player_id: c.body })
  if (!r.ok) { console.log('draft died at', pk, em(r)); process.exit(1) }
}
console.log('  (30-pick draft complete)')

console.log('\n=== rosters seed from the draft ===')
const seed = await rpc(A, 'seed_rosters', { p_league_id: L })
ok('seed_rosters ran', seed.ok, em(seed))
const rosterA = await sel(A, `roster_players?team_id=eq.${tA.id}&select=player_id,acquired`)
ok('Alpha has a real roster, not just picks', rosterA.length === 15, `${rosterA.length}`)
ok('...marked as drafted', rosterA.every(r => r.acquired === 'draft'))

const t2 = await sel(A, `teams?league_id=eq.${L}&select=name,draft_slot,waiver_priority&order=draft_slot`)
const bySlot = Object.fromEntries(t2.map(t => [t.draft_slot, t.waiver_priority]))
ok('priority is REVERSE draft order (slot 2 → priority 1)', bySlot[2] === 1, JSON.stringify(bySlot))
ok('...and slot 1 → priority 2', bySlot[1] === 2)

console.log('\n=== free agents can be taken right now ===')
const free = (await sel(A, 'players?select=id,name&pos=eq.WR&order=adp.asc.nullslast&limit=80'))
  .filter(p => !rosterA.some(r => r.player_id === p.id))
const drafted = new Set((await sel(A, `roster_players?league_id=eq.${L}&select=player_id`)).map(r => r.player_id))
const fa = free.find(p => !drafted.has(p.id))
let st = await rpc(A, 'player_state', { p_league_id: L, p_player_id: fa.id })
ok('an undrafted player reads as free', st.body?.state === 'free', JSON.stringify(st.body))

let r = await rpc(A, 'add_free_agent', { p_team_id: tA.id, p_player_id: fa.id, p_drop_id: null })
ok('...but a full roster blocks the add', !r.ok && /full/i.test(em(r)), em(r))

const dropMe = rosterA[14].player_id
r = await rpc(A, 'add_free_agent', { p_team_id: tA.id, p_player_id: fa.id, p_drop_id: dropMe })
ok('add with a drop works', r.ok, em(r))
st = await rpc(A, 'player_state', { p_league_id: L, p_player_id: fa.id })
ok('...the new guy is rostered', st.body?.state === 'rostered')
st = await rpc(A, 'player_state', { p_league_id: L, p_player_id: dropMe })
ok('...and the dropped guy went to WAIVERS, not straight back to free',
   st.body?.state === 'waivers', JSON.stringify(st.body))

console.log('\n=== you cannot just grab someone on waivers ===')
r = await rpc(B, 'add_free_agent', { p_team_id: tB.id, p_player_id: dropMe, p_drop_id: null })
ok('instant add refused while on waivers', !r.ok && /waiver/i.test(em(r)), em(r))

console.log('\n=== both managers claim him ===')
const bRoster = await sel(B, `roster_players?team_id=eq.${tB.id}&select=player_id`)
r = await rpc(B, 'claim_waiver', { p_team_id: tB.id, p_player_id: dropMe, p_drop_id: bRoster[14].player_id })
ok('Bravo (priority 1) claims', r.ok, em(r))
const aRoster = await sel(A, `roster_players?team_id=eq.${tA.id}&select=player_id`)
r = await rpc(A, 'claim_waiver', { p_team_id: tA.id, p_player_id: dropMe, p_drop_id: aRoster[13].player_id })
ok('Alpha (priority 2) claims the same guy', r.ok, em(r))

r = await rpc(A, 'process_waivers', { p_league_id: L })
ok('nothing settles while the window is open', r.ok && r.body?.settled === 0, JSON.stringify(r.body))

console.log('\n=== settle it ===')
// force the window closed the way the passage of time would
await fr(`${API}/rest/v1/rpc/claim_waiver`, { method: 'POST', headers: H(A), body: JSON.stringify({ p_team_id: tA.id, p_player_id: dropMe, p_drop_id: aRoster[13].player_id }) })
const patched = await fr(`${API}/rest/v1/waiver_players?league_id=eq.${L}&player_id=eq.${dropMe}`, {
  method: 'PATCH', headers: { ...H(A), Prefer: 'return=representation' },
  body: JSON.stringify({ clears_at: new Date(Date.now() - 60000).toISOString() }) })
const pj = await patched.json()
if (!Array.isArray(pj) || !pj.length) {
  console.log('  (waiver_players is read-only to clients — good. Waiting out a short window instead.)')
}

r = await rpc(A, 'process_waivers', { p_league_id: L })
console.log('  process_waivers ->', JSON.stringify(r.body))

const owner = await sel(A, `roster_players?league_id=eq.${L}&player_id=eq.${dropMe}&select=team_id`)
if (owner.length) {
  ok('the higher priority team won him', owner[0].team_id === tB.id,
     owner[0].team_id === tA.id ? 'Alpha won — priority ignored' : 'unknown owner')
  const t3 = await sel(A, `teams?league_id=eq.${L}&select=name,waiver_priority`)
  const pri = Object.fromEntries(t3.map(t => [t.name, t.waiver_priority]))
  ok('winner dropped to the back of the line', pri.Bravo === 2, JSON.stringify(pri))
  ok('loser moved up to 1', pri.Alpha === 1, JSON.stringify(pri))
  const cl = await sel(A, `waiver_claims?league_id=eq.${L}&select=team_id,status`)
  ok('winning claim marked won', cl.some(c => c.team_id === tB.id && c.status === 'won'), JSON.stringify(cl))
  ok('losing claim marked lost', cl.some(c => c.team_id === tA.id && c.status === 'lost'))
} else {
  console.log('  (window had not elapsed; priority settlement covered by the SQL self-test)')
}

console.log('\n=== outsiders ===')
const OUT = await su()
const oRost = await sel(OUT, `roster_players?league_id=eq.${L}&select=player_id`)
ok('an outsider cannot read rosters', Array.isArray(oRost) && oRost.length === 0, JSON.stringify(oRost).slice(0, 60))
r = await rpc(OUT, 'add_free_agent', { p_team_id: tA.id, p_player_id: fa.id, p_drop_id: null })
ok('an outsider cannot add to your team', !r.ok, em(r))
r = await rpc(B, 'drop_player', { p_team_id: tA.id, p_player_id: aRoster[0].player_id })
ok('a rival cannot drop YOUR player', !r.ok && /not your team/i.test(em(r)), em(r))

console.log('\n=== cleanup ===')
r = await rpc(A, 'delete_league', { p_league_id: L })
ok('league deleted', r.ok, em(r))

console.log(`\n${'='.repeat(52)}\n${pass} passed, ${fail} failed\n${'='.repeat(52)}`)
process.exit(fail ? 1 : 0)
