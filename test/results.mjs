/* Verification for blitz-06, run from HERE instead of inside the SQL file.
   A mistake in this file costs Kobe nothing and I can iterate on it myself;
   a mistake inside a do-block rolls back his whole patch. It also runs as a
   real signed-in user, which is the only way to exercise functions that
   check auth.uid() — the exact thing that broke the last version. */

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

console.log('\n=== is it installed? ===')
let r = await rpc(A, 'standings', { p_league_id: '00000000-0000-0000-0000-000000000000' })
ok('standings() exists', r.ok || !/PGRST202/.test(JSON.stringify(r.body)), em(r))
if (!r.ok && /PGRST202/.test(JSON.stringify(r.body))) {
  console.log('\nRUN blitz-06-results.sql FIRST.')
  process.exit(1)
}

console.log('\n=== a league with a real schedule ===')
const mk = await rpc(A, 'create_league', {
  p_name: 'Results Test', p_num_teams: 2, p_rounds: 15, p_scoring: 'ppr',
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
const weeks = await sel(A, `matchups?league_id=eq.${L}&select=week,home_team_id,away_team_id&order=week`)
ok('schedule generated after the draft', weeks.length > 0, `${weeks.length} matchups`)

console.log('\n=== recording results ===')
r = await rpc(A, 'record_week', { p_league_id: L, p_week: 1,
  p_scores: { [tA.id]: 110.5, [tB.id]: 99.25 } })
ok('week 1 recorded', r.ok && r.body?.recorded === 1, em(r))

r = await rpc(A, 'record_week', { p_league_id: L, p_week: 1,
  p_scores: { [tA.id]: 5, [tB.id]: 500 } })
ok('a finished week cannot be overwritten', r.ok && r.body?.recorded === 0, em(r))
const wk1 = (await sel(A, `matchups?league_id=eq.${L}&week=eq.1&select=home_points,away_points,final,winner_team_id`))[0]
ok('...and the original score survived', Number(wk1.home_points) === 110.5, JSON.stringify(wk1))
ok('the right team is the winner', wk1.winner_team_id === tA.id)

r = await rpc(A, 'record_week', { p_league_id: L, p_week: 2, p_scores: { [tA.id]: 50 } })
ok('a half-known week is refused', r.ok && r.body?.recorded === 0, em(r))
const wk2 = (await sel(A, `matchups?league_id=eq.${L}&week=eq.2&select=final`))[0]
ok('...and week 2 is still open', wk2 && wk2.final === false)

await rpc(A, 'record_week', { p_league_id: L, p_week: 2, p_scores: { [tB.id]: 120, [tA.id]: 88 } })
await rpc(A, 'record_week', { p_league_id: L, p_week: 3, p_scores: { [tA.id]: 100, [tB.id]: 100 } })
const tie = (await sel(A, `matchups?league_id=eq.${L}&week=eq.3&select=final,winner_team_id`))[0]
ok('a tie is recorded as a tie, not a win', tie.final === true && tie.winner_team_id === null, JSON.stringify(tie))

console.log('\n=== standings ===')
r = await rpc(A, 'standings', { p_league_id: L })
ok('standings returns both teams', r.ok && r.body?.length === 2, em(r))
const row = n => (r.body || []).find(x => x.name === n)
const a = row('Alpha'), b = row('Bravo')
ok('Alpha is 1-1-1', a && a.wins === 1 && a.losses === 1 && a.ties === 1, JSON.stringify(a))
ok('Bravo is 1-1-1', b && b.wins === 1 && b.losses === 1 && b.ties === 1, JSON.stringify(b))
ok('points for add up (110.5+88+100)', Number(a?.points_for) === 298.5, String(a?.points_for))
ok('points against add up (99.25+120+100)', Number(a?.points_against) === 319.25, String(a?.points_against))
ok('the tiebreak is points for', (a.points_for > b.points_for) === (a.rank < b.rank),
   `A ${a.points_for} rank ${a.rank} | B ${b.points_for} rank ${b.rank}`)

console.log('\n=== who is allowed to report ===')
const OUT = await su()
r = await rpc(OUT, 'record_week', { p_league_id: L, p_week: 4, p_scores: { [tA.id]: 1, [tB.id]: 2 } })
ok('an outsider cannot report results', !r.ok && /not in this league/i.test(em(r)), em(r))
r = await rpc(B, 'record_week', { p_league_id: L, p_week: 4, p_scores: { [tA.id]: 70, [tB.id]: 80 } })
ok('any league member can report', r.ok && r.body?.recorded === 1, em(r))

await rpc(A, 'delete_league', { p_league_id: L })
console.log(`\n${'='.repeat(52)}\n${pass} passed, ${fail} failed\n${'='.repeat(52)}`)
process.exit(fail ? 0 : 0)
