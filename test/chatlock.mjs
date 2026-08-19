/* Chat + the real lineup lock.

   The lock test temporarily rewinds ONE team's week-1 kickoff into the
   past, checks that a swap involving that team's player is refused, then
   puts the real kickoff back — in a finally, so a crash still restores it. */

const API = 'https://yrgbnyoqyurtrisgbvai.supabase.co'
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlyZ2JueW9xeXVydHJpc2didmFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzNzY0MTEsImV4cCI6MjEwMTk1MjQxMX0.ZXfDJtOX0s5avbBfPMMDZuBU2s3KG7pWgJnbWcwgrf4'

let pass = 0, fail = 0
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function fr(u, o, t = 5) {
  for (let i = 0; i < t; i++) { try { return await fetch(u, o) } catch (e) { if (i === t - 1) throw e; await sleep(1500 * (i + 1)) } }
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
let restore = null

try {
  console.log('\n=== a drafted league ===')
  const mk = await rpc(A, 'create_league', {
    p_name: 'Chat Lock Test', p_num_teams: 2, p_rounds: 15, p_scoring: 'ppr',
    p_pick_seconds: 600, p_team_name: 'Alpha', p_draft_at: null })
  ok('league created', mk.ok, em(mk))
  if (!mk.ok) process.exit(1)
  const L = mk.body.league_id
  await rpc(B, 'join_league', { p_join_code: mk.body.join_code, p_team_name: 'Bravo' })
  await rpc(A, 'start_draft', { p_league_id: L })
  const teams = await sel(A, `teams?league_id=eq.${L}&select=id,name,draft_slot`)
  const draft = (await sel(A, `drafts?league_id=eq.${L}&select=id`))[0]
  for (let pk = 1; pk <= 30; pk++) {
    const t = teams.find(x => x.draft_slot === slotFor(pk, 2))
    const c = await rpc(A, 'autopick_choice', { p_draft_id: draft.id, p_team_id: t.id })
    await rpc(A, 'make_pick', { p_draft_id: draft.id, p_team_id: t.id, p_player_id: c.body })
  }
  const tA = teams.find(t => t.name === 'Alpha'), tB = teams.find(t => t.name === 'Bravo')

  console.log('\n=== chat ===')
  let r = await rpc(A, 'post_chat', { p_league_id: L, p_body: 'anyone want a RB?' })
  ok('a member can post', r.ok, em(r))
  r = await rpc(B, 'post_chat', { p_league_id: L, p_body: 'depends who' })
  ok('so can the other guy', r.ok, em(r))
  const msgs = await sel(B, `league_chat?league_id=eq.${L}&select=body,team_id&order=id`)
  ok('both messages are readable in the league', msgs.length === 2, JSON.stringify(msgs).slice(0, 90))
  ok('...and attributed to the right teams',
     msgs[0]?.team_id === tA.id && msgs[1]?.team_id === tB.id)

  r = await rpc(A, 'post_chat', { p_league_id: L, p_body: '   ' })
  ok('an empty message is refused', !r.ok, em(r))
  r = await rpc(A, 'post_chat', { p_league_id: L, p_body: 'x'.repeat(501) })
  ok('a 501-character message is refused', !r.ok, em(r))

  const OUT = await su()
  r = await rpc(OUT, 'post_chat', { p_league_id: L, p_body: 'let me in' })
  ok('an outsider cannot post', !r.ok && /not in this league/i.test(em(r)), em(r))
  const spy = await sel(OUT, `league_chat?league_id=eq.${L}&select=body`)
  ok('an outsider cannot read the chat', Array.isArray(spy) && spy.length === 0, JSON.stringify(spy).slice(0, 60))

  console.log('\n=== the lineup lock ===')
  await rpc(A, 'autofill_lineup', { p_team_id: tA.id, p_week: 1 })
  const lineup = await sel(A, `lineups?team_id=eq.${tA.id}&week=eq.1&select=player_id,slot`)
  ok('a week-1 lineup exists', lineup.length > 0, `${lineup.length} slots`)

  const starter = lineup.find(l => l.slot !== 'BN')
  const bench = lineup.find(l => l.slot === 'BN')
  const pl = (await sel(A, `players?id=eq.${starter.player_id}&select=id,name,team,pos`))[0]
  console.log(`  using ${pl.name} (${pl.team}) — starting in ${starter.slot}`)

  // nothing has kicked off yet, so a swap must be allowed
  r = await rpc(A, 'swap_lineup', { p_team_id: tA.id, p_week: 1, p_a: starter.player_id, p_b: bench.player_id })
  ok('before kickoff a swap is allowed', r.ok, em(r))
  // put it back
  await rpc(A, 'swap_lineup', { p_team_id: tA.id, p_week: 1, p_a: starter.player_id, p_b: bench.player_id })

  // rewind that team's week-1 kickoff into the past
  const real = (await sel(A, `nfl_games?season=eq.2026&week=eq.1&team=eq.${pl.team}&select=team,opp,kickoff`))[0]
  ok('found the real kickoff to rewind', !!real, JSON.stringify(real))
  restore = real
  await rpc(A, 'import_nfl_games', { p_rows: [{
    season: 2026, week: 1, team: pl.team, opp: real.opp,
    kickoff: new Date(Date.now() - 3600e3).toISOString() }] })

  const lk = await rpc(A, 'player_locked', { p_player_id: pl.id, p_season: 2026, p_week: 1 })
  ok('the database now says that player is locked', lk.body === true, JSON.stringify(lk.body))

  r = await rpc(A, 'swap_lineup', { p_team_id: tA.id, p_week: 1, p_a: starter.player_id, p_b: bench.player_id })
  ok('AFTER kickoff the swap is REFUSED', !r.ok && /already started/i.test(em(r)), em(r))

  const after = await sel(A, `lineups?team_id=eq.${tA.id}&week=eq.1&select=player_id,slot`)
  const stillStarting = after.find(l => l.player_id === starter.player_id)?.slot
  ok('...and the lineup did not move', stillStarting === starter.slot, `${stillStarting} vs ${starter.slot}`)

  console.log('\n=== the unattended sweep ===')
  r = await rpc(A, 'sweep_all_leagues', {})
  ok('sweep runs across every league', r.ok && r.body && 'waivers_settled' in r.body, em(r))

  await rpc(A, 'delete_league', { p_league_id: L })
} finally {
  if (restore) {
    await rpc(A, 'import_nfl_games', { p_rows: [{
      season: 2026, week: 1, team: restore.team, opp: restore.opp, kickoff: restore.kickoff }] })
    const back = (await sel(A, `nfl_games?season=eq.2026&week=eq.1&team=eq.${restore.team}&select=kickoff`))[0]
    ok('real kickoff restored', back?.kickoff === restore.kickoff, `${back?.kickoff} vs ${restore.kickoff}`)
  }
}

console.log(`\n${'='.repeat(52)}\n${pass} passed, ${fail} failed\n${'='.repeat(52)}`)
process.exit(fail ? 1 : 0)
