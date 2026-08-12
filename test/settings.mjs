/* LIVE test of the settings system.
   The do-block inside the patch proves the functions run; this proves
   they run THROUGH THE API as a real signed-in user, with RLS on — which
   is the part a SQL-editor test cannot see. Two accounts, because the
   thing most worth checking is that a league member who is NOT the
   manager can read the settings and cannot change them. */

const API = 'https://yrgbnyoqyurtrisgbvai.supabase.co'
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlyZ2JueW9xeXVydHJpc2didmFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzNzY0MTEsImV4cCI6MjEwMTk1MjQxMX0.ZXfDJtOX0s5avbBfPMMDZuBU2s3KG7pWgJnbWcwgrf4'

let pass = 0, fail = 0
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function fetchR(u, o, t = 5) {
  for (let i = 0; i < t; i++) { try { return await fetch(u, o) } catch (e) { if (i === t - 1) throw e; await sleep(1200 * (i + 1)) } }
}
const su = async () => {
  for (let i = 0; i < 8; i++) {
    const r = await fetchR(`${API}/auth/v1/signup`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: '{}' })
    const d = await r.json()
    if (d.access_token) return d.access_token
    await sleep(8000)
  }
  throw new Error('signup rate limited')
}
const H = tok => ({ apikey: ANON, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' })
const rpc = async (tok, fn, args) => {
  const r = await fetchR(`${API}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H(tok), body: JSON.stringify(args) })
  const t = await r.text(); let b; try { b = JSON.parse(t) } catch { b = t }
  return { ok: r.ok, status: r.status, body: b }
}
const sel = async (tok, p) => (await fetchR(`${API}/rest/v1/${p}`, { headers: H(tok) })).json()
const em = r => (r.body && r.body.message) || JSON.stringify(r.body).slice(0, 160)
const at = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o)

const BOSS = await su()
const OTHER = await su()

console.log('\n=== the spec the whole screen is drawn from ===')
const sp = await rpc(BOSS, 'blitz_setting_spec', {})
ok('blitz_setting_spec is installed', sp.ok, em(sp))
if (!sp.ok) { console.log('\nRUN blitz-03-settings.sql FIRST.'); process.exit(1) }
const spec = sp.body
ok('every setting has a label, section and type',
   spec.every(s => s.path && s.label && s.sect && s.type), `${spec.length} rows`)
ok('choice rows all carry their options', spec.every(s => s.type !== 'choice' || Array.isArray(s.options)))
console.log(`  (${spec.length} settings across ${new Set(spec.map(s => s.sect)).size} sections)`)

console.log('\n=== a real league ===')
/* exactly the call the app makes, so an ambiguous overload shows up here
   before it shows up for a friend trying to make a league */
const mk = await rpc(BOSS, 'create_league', {
  p_name: 'Settings Test', p_num_teams: 12, p_rounds: 15,
  p_scoring: 'ppr', p_pick_seconds: 90, p_team_name: 'Boss', p_draft_at: null })
ok('league created', mk.ok, em(mk))
if (!mk.ok) process.exit(1)
const L = mk.body.league_id
const code = mk.body.join_code
await rpc(OTHER, 'join_league', { p_join_code: code, p_team_name: 'Rando' })

const get = async (tok = BOSS) => (await rpc(tok, 'league_settings', { p_league_id: L })).body
let V = await get()
ok('defaults match ESPN: 4 points for a passing TD', at(V, 'scoring.passing.PTD') === 4)
ok('defaults match ESPN: -2 for an interception', at(V, 'scoring.passing.INT') === -2)
ok('defaults match ESPN: 5 votes to veto a trade', at(V, 'trades.veto_votes') === 5)
ok('defaults match ESPN: 1 RB/WR flex spot', at(V, 'roster.RBWR') === 1)
ok('defaults match ESPN: 6 bench spots', at(V, 'roster.BE') === 6)
ok('PPR shows a reception as 1 point', at(V, 'scoring.receiving.REC') === 1)
ok('the manager is flagged as the manager', at(V, 'meta.is_commish') === true)
ok('15 draft rounds', at(V, 'meta.rounds') === 15)

console.log('\n=== changing things, one row at a time ===')
const set = (tok, path, value) => rpc(tok, 'set_league_option', { p_league_id: L, p_path: path, p_value: value })

let r = await set(BOSS, 'scoring.passing.PTD', 6)
ok('a number saves', r.ok, em(r))
r = await set(BOSS, 'transactions.undroppable', false)
ok('a yes/no saves', r.ok, em(r))
r = await set(BOSS, 'transactions.waiver_order', 'move_to_last')
ok('a choice saves', r.ok, em(r))
r = await set(BOSS, 'basic.name', 'Settings Test 2')
ok('text saves', r.ok, em(r))
/* JSON null arrives as a SQL NULL, which compares to nothing — this is
   where a blank activity line and a skipped validation came from */
r = await set(BOSS, 'trades.limit', null)
ok('a nullable setting takes No Limit', r.ok, em(r))
ok('...and says "No Limit" rather than logging a blank line', r.body?.shown === 'No Limit', JSON.stringify(r.body))
r = await set(BOSS, 'trades.veto_votes', null)
ok('...while a required setting still refuses an empty value', !r.ok, em(r))
const when = new Date(Date.now() + 3 * 86400000).toISOString()
r = await set(BOSS, 'draft.at', when)
ok('a draft date saves', r.ok, em(r))

V = await get()
ok('  passing TD reads back as 6', at(V, 'scoring.passing.PTD') === 6)
ok('  undroppable list reads back as off', at(V, 'transactions.undroppable') === false)
ok('  waiver order reads back changed', at(V, 'transactions.waiver_order') === 'move_to_last')
ok('  league name reads back changed', at(V, 'basic.name') === 'Settings Test 2')
ok('  trade limit reads back as none', at(V, 'trades.limit') === null)

console.log('\n=== settings the ENGINE uses must move the real column ===')
await set(BOSS, 'playoffs.teams', 6)
await set(BOSS, 'schedule.regular_matchups', 13)
await set(BOSS, 'scoring.receiving.REC', 0.5)
await set(BOSS, 'roster.BE', 7)
let row = (await sel(BOSS, `leagues?id=eq.${L}&select=*`))[0]
ok('playoff_teams column moved', row.playoff_teams === 6, String(row.playoff_teams))
ok('regular_weeks column moved', row.regular_weeks === 13, String(row.regular_weeks))
ok('half-PPR set the scoring column', row.scoring === 'half', row.scoring)
ok('the league name column moved', row.name === 'Settings Test 2', row.name)
ok('the draft date column moved', !!row.draft_at, String(row.draft_at))
ok('bench went to 7 in the roster column', (row.roster || {}).BN === 7, JSON.stringify(row.roster))
ok('...and the draft grew to 16 rounds to match', row.rounds === 16, String(row.rounds))
await set(BOSS, 'roster.BE', 6)
row = (await sel(BOSS, `leagues?id=eq.${L}&select=rounds,roster`))[0]
ok('...and back to 15 when the bench goes back to 6', row.rounds === 15, String(row.rounds))
ok('the rest of the roster survived the edit',
   row.roster.QB === 1 && row.roster.RB === 2 && row.roster.WR === 2 && row.roster.FLEX === 1,
   JSON.stringify(row.roster))

console.log('\n=== bad values are refused ===')
r = await set(BOSS, 'trades.veto_votes', 99);            ok('99 veto votes refused', !r.ok, em(r))
r = await set(BOSS, 'playoffs.teams', 5);                ok('5 playoff teams refused', !r.ok, em(r))
r = await set(BOSS, 'basic.name', '');                   ok('an empty league name refused', !r.ok, em(r))
r = await set(BOSS, 'made.up.setting', 1);               ok('an unknown setting refused', !r.ok, em(r))
r = await set(BOSS, 'roster.LB', 2);                     ok('a linebacker slot refused (none loaded)', !r.ok, em(r))
r = await set(BOSS, 'basic.league_id', 'hack');          ok('the league code cannot be edited', !r.ok, em(r))
r = await set(BOSS, 'scoring.passing.PTD', 'lots');      ok('a word where a number goes is refused', !r.ok, em(r))
r = await set(BOSS, 'draft.at', '1999-01-01T00:00:00Z'); ok('a draft time in the past is refused', !r.ok, em(r))

console.log('\n=== the other guy in the league ===')
const V2 = await get(OTHER)
ok('a member can READ the settings', !!V2 && at(V2, 'scoring.passing.PTD') === 6)
ok('...and is not flagged as the manager', at(V2, 'meta.is_commish') === false)
r = await set(OTHER, 'scoring.passing.PTD', 99)
ok('a member CANNOT change them', !r.ok, em(r))
ok('...and nothing moved', at(await get(), 'scoring.passing.PTD') === 6)

r = await rpc(OTHER, 'set_league_option_raw', {
  p_league_id: L, p_path: 'scoring.passing.PTD', p_value: 1,
  p_actor: (await sel(BOSS, `leagues?id=eq.${L}&select=commissioner_uid`))[0].commissioner_uid })
ok('the raw setter is not reachable from the API at all', !r.ok, `status ${r.status} ${em(r)}`)

console.log('\n=== the activity feed ===')
const acts = await sel(BOSS, `league_activity?league_id=eq.${L}&select=body,kind&order=id.desc`)
ok('every accepted change was logged', Array.isArray(acts) && acts.length >= 10, `${acts.length} lines`)
ok('rejected changes were NOT logged', !acts.some(a => /99|hack|lots/.test(a.body)),
   acts.filter(a => /99|hack|lots/.test(a.body)).map(a => a.body).join(' | '))
console.log('  latest:', acts.slice(0, 3).map(a => a.body).join('\n          '))
r = await rpc(OTHER, 'rename_team', { p_team_id: (await sel(OTHER, `teams?league_id=eq.${L}&select=id,name`)).find(t => t.name === 'Rando').id, p_name: 'Renamed Crew' })
ok('a manager can rename their own team', r.ok, em(r))
const acts2 = await sel(BOSS, `league_activity?league_id=eq.${L}&select=body&order=id.desc&limit=1`)
ok('...and the rename was logged like ESPN does',
   /Renamed team Rando to Renamed Crew/.test(acts2[0]?.body || ''), acts2[0]?.body)

console.log('\n=== an outsider ===')
const OUT = await su()
const vOut = await rpc(OUT, 'league_settings', { p_league_id: L })
const aOut = await sel(OUT, `league_activity?league_id=eq.${L}&select=body`)
ok('an outsider cannot read the activity feed', Array.isArray(aOut) && aOut.length === 0, JSON.stringify(aOut).slice(0, 80))
r = await set(OUT, 'scoring.passing.PTD', 1)
ok('an outsider cannot change anything', !r.ok, em(r))

console.log('\n=== locking at the draft ===')
await rpc(BOSS, 'start_draft', { p_league_id: L })
r = await set(BOSS, 'roster.RB', 3)
ok('the roster locks once the draft starts', !r.ok, em(r))
r = await set(BOSS, 'basic.num_teams', 10)
ok('the team count locks too', !r.ok, em(r))
r = await set(BOSS, 'draft.pick_seconds', 120)
ok('the draft clock locks too', !r.ok, em(r))
r = await set(BOSS, 'scoring.passing.PTD', 4)
ok('...but scoring is still the manager\'s to fix', r.ok, em(r))
ok('the screen knows to grey the locked rows', at(await get(), 'meta.draft_locked') === true)

console.log('\n=== cleanup ===')
r = await rpc(BOSS, 'delete_league', { p_league_id: L })
ok('league deleted', r.ok, em(r))

console.log(`\n${'='.repeat(52)}\n${pass} passed, ${fail} failed\n${'='.repeat(52)}`)
process.exit(fail ? 1 : 0)
