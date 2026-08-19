/* Trades, end to end, as two real signed-in managers.

   The cases that matter are not "can A trade with B" — they are the ones
   where a trade is legal when proposed and illegal by the time it lands. */

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
const em = r => (r.body && r.body.message) || JSON.stringify(r.body).slice(0, 130)
const slotFor = (pk, n) => { const r = Math.floor((pk - 1) / n), i = (pk - 1) % n; return r % 2 === 0 ? i + 1 : n - i }

const A = await su(), B = await su()

console.log('\n=== set up a drafted 2-team league ===')
const mk = await rpc(A, 'create_league', {
  p_name: 'Trade Test', p_num_teams: 2, p_rounds: 15, p_scoring: 'ppr',
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
await rpc(A, 'seed_rosters', { p_league_id: L })
const tA = teams.find(t => t.name === 'Alpha'), tB = teams.find(t => t.name === 'Bravo')
const rA = await sel(A, `roster_players?team_id=eq.${tA.id}&select=player_id`)
const rB = await sel(A, `roster_players?team_id=eq.${tB.id}&select=player_id`)
ok('both rosters seeded', rA.length === 15 && rB.length === 15, `${rA.length}/${rB.length}`)

// no review window, so accepted trades execute immediately
await rpc(A, 'set_league_option', { p_league_id: L, p_path: 'trades.review_days', p_value: 0 })
await rpc(A, 'set_league_option', { p_league_id: L, p_path: 'trades.veto_votes', p_value: 0 })

console.log('\n=== a straight 1-for-1 ===')
const give = rA[0].player_id, get = rB[0].player_id
let r = await rpc(A, 'propose_trade', { p_from_team: tA.id, p_to_team: tB.id, p_give: [give], p_get: [get], p_note: 'fair swap' })
ok('proposed', r.ok, em(r))
const T1 = r.body?.trade_id

r = await rpc(A, 'respond_trade', { p_trade_id: T1, p_accept: true })
ok('the PROPOSER cannot accept their own offer', !r.ok && /receiving the offer/i.test(em(r)), em(r))

r = await rpc(B, 'respond_trade', { p_trade_id: T1, p_accept: true })
ok('the recipient can accept', r.ok, em(r))

r = await rpc(A, 'process_trades', { p_league_id: L })
ok('it executes', r.ok && r.body?.executed === 1, JSON.stringify(r.body))
const ownGive = await sel(A, `roster_players?league_id=eq.${L}&player_id=eq.${give}&select=team_id`)
const ownGet = await sel(A, `roster_players?league_id=eq.${L}&player_id=eq.${get}&select=team_id`)
ok('the given player is now on Bravo', ownGive[0]?.team_id === tB.id)
ok('the received player is now on Alpha', ownGet[0]?.team_id === tA.id)
const sizes = [
  (await sel(A, `roster_players?team_id=eq.${tA.id}&select=player_id`)).length,
  (await sel(A, `roster_players?team_id=eq.${tB.id}&select=player_id`)).length,
]
ok('both rosters still 15', sizes[0] === 15 && sizes[1] === 15, sizes.join('/'))

console.log('\n=== rejecting ===')
r = await rpc(A, 'propose_trade', { p_from_team: tA.id, p_to_team: tB.id, p_give: [rA[1].player_id], p_get: [rB[1].player_id] })
const T2 = r.body?.trade_id
r = await rpc(B, 'respond_trade', { p_trade_id: T2, p_accept: false })
ok('recipient can reject', r.ok && r.body?.status === 'rejected', em(r))
r = await rpc(B, 'respond_trade', { p_trade_id: T2, p_accept: true })
ok('a rejected trade cannot be revived', !r.ok && /already rejected/i.test(em(r)), em(r))

console.log('\n=== pulling an offer back ===')
r = await rpc(A, 'propose_trade', { p_from_team: tA.id, p_to_team: tB.id, p_give: [rA[2].player_id], p_get: [rB[2].player_id] })
const T3 = r.body?.trade_id
r = await rpc(B, 'cancel_trade', { p_trade_id: T3 })
ok('the recipient cannot cancel it', !r.ok && /offered it/i.test(em(r)), em(r))
r = await rpc(A, 'cancel_trade', { p_trade_id: T3 })
ok('the proposer can pull it back', r.ok, em(r))

console.log('\n=== THE CASE THAT MATTERS: legal when proposed, illegal later ===')
const stale = rA[3].player_id
r = await rpc(A, 'propose_trade', { p_from_team: tA.id, p_to_team: tB.id, p_give: [stale], p_get: [rB[3].player_id] })
const T4 = r.body?.trade_id
ok('proposed while legal', r.ok, em(r))
// ...then Alpha drops the very player they offered
r = await rpc(A, 'drop_player', { p_team_id: tA.id, p_player_id: stale })
ok('proposer drops that player', r.ok, em(r))
r = await rpc(B, 'respond_trade', { p_trade_id: T4, p_accept: true })
// it must REPORT the failure rather than raise — raising would roll back
// the very row update that records why, leaving it pending forever
ok('accepting is refused, with a reason', r.ok && r.body?.ok === false && /no longer on that roster/i.test(r.body?.reason || ''), JSON.stringify(r.body))
const t4 = (await sel(A, `trades?id=eq.${T4}&select=status,reason`))[0]
ok('...and the trade is marked invalid, not left pending', t4.status === 'invalid' && !!t4.reason, JSON.stringify(t4))
const own4 = await sel(A, `roster_players?league_id=eq.${L}&player_id=eq.${rB[3].player_id}&select=team_id`)
ok('...and no players moved', own4[0]?.team_id === tB.id, JSON.stringify(own4))

console.log('\n=== roster limits ===')
const many = rA.slice(4, 8).map(x => x.player_id)
r = await rpc(A, 'propose_trade', { p_from_team: tA.id, p_to_team: tB.id, p_give: [many[0]], p_get: rB.slice(4, 8).map(x => x.player_id) })
ok('4-for-1 refused: it would overfill the receiver', !r.ok && /over 15/i.test(em(r)), em(r))

console.log('\n=== outsiders and nonsense ===')
const OUT = await su()
r = await rpc(OUT, 'propose_trade', { p_from_team: tA.id, p_to_team: tB.id, p_give: [rA[9].player_id], p_get: [] })
ok('an outsider cannot trade your players', !r.ok && /not your team/i.test(em(r)), em(r))
r = await rpc(A, 'propose_trade', { p_from_team: tA.id, p_to_team: tB.id, p_give: [], p_get: [] })
ok('an empty trade is refused', !r.ok && /at least one player/i.test(em(r)), em(r))
r = await rpc(A, 'propose_trade', { p_from_team: tA.id, p_to_team: tB.id, p_give: [rB[9].player_id], p_get: [] })
ok('you cannot trade away a player you do not own', !r.ok && /no longer on that roster/i.test(em(r)), em(r))

console.log('\n=== veto ===')
await rpc(A, 'set_league_option', { p_league_id: L, p_path: 'trades.veto_votes', p_value: 1 })
r = await rpc(A, 'propose_trade', { p_from_team: tA.id, p_to_team: tB.id, p_give: [rA[10].player_id], p_get: [rB[10].player_id] })
const T5 = r.body?.trade_id
await rpc(B, 'respond_trade', { p_trade_id: T5, p_accept: true })
r = await rpc(A, 'veto_trade', { p_trade_id: T5, p_team_id: tA.id })
ok('you cannot veto your own trade', !r.ok && /your own trade/i.test(em(r)), em(r))
// only two teams here, so nobody neutral exists to cast the vote — verify
// instead that with the threshold unmet the trade still goes through
r = await rpc(A, 'process_trades', { p_league_id: L })
ok('with no vetoes cast it still executes', r.ok && r.body?.executed === 1, JSON.stringify(r.body))

console.log('\n=== the activity feed saw it all ===')
const acts = await sel(A, `league_activity?league_id=eq.${L}&kind=eq.trade&select=body&order=id.desc`)
ok('trades are logged', Array.isArray(acts) && acts.length >= 4, `${acts.length} lines`)
console.log('  ', (acts[0]?.body || '').slice(0, 70))

await rpc(A, 'delete_league', { p_league_id: L })
console.log(`\n${'='.repeat(52)}\n${pass} passed, ${fail} failed\n${'='.repeat(52)}`)
process.exit(fail ? 1 : 0)
