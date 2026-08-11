/* Simulates exactly what a brand-new person (Wyatt on his phone) does:
   land on the app as a fresh anonymous user -> mock draft -> pick players
   -> finish -> land on My Team. Plus a real multi-human league draft. */

const API = 'https://yrgbnyoqyurtrisgbvai.supabase.co'
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlyZ2JueW9xeXVydHJpc2didmFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzNzY0MTEsImV4cCI6MjEwMTk1MjQxMX0.ZXfDJtOX0s5avbBfPMMDZuBU2s3KG7pWgJnbWcwgrf4'

let pass = 0, fail = 0
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function newUser(label) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`${API}/auth/v1/signup`, {
      method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: '{}' })
    const d = await r.json()
    if (d.access_token) return { tok: d.access_token, uid: d.user.id, label }
    if (d.error_code === 'over_request_rate_limit') { await sleep(12000); continue }
    throw new Error(label + ' signup: ' + JSON.stringify(d))
  }
  throw new Error(label + ' signup: rate limited out')
}
const H = u => ({ apikey: ANON, Authorization: 'Bearer ' + u.tok, 'Content-Type': 'application/json' })
const rpc = async (u, f, a) => {
  const r = await fetch(`${API}/rest/v1/rpc/${f}`, { method: 'POST', headers: H(u), body: JSON.stringify(a) })
  const t = await r.text(); let b; try { b = JSON.parse(t) } catch { b = t }
  return { ok: r.ok, body: b }
}
const sel = async (u, p) => (await fetch(`${API}/rest/v1/${p}`, { headers: H(u) })).json()
const em = r => (r.body && r.body.message) || JSON.stringify(r.body)
const slotFor = (pick, n) => { const r = Math.floor((pick - 1) / n), i = (pick - 1) % n; return r % 2 === 0 ? i + 1 : n - i }

/* ============ 1. a stranger opens the app and runs a mock ============ */
console.log('\n=== 1. brand-new user, mock draft (what Wyatt did) ===')
const wyatt = await newUser('wyatt')
ok('fresh anonymous sign-in works', !!wyatt.tok)

const players = await sel(wyatt, 'players?select=id,name,pos,prank&order=adp.asc.nullslast&limit=400')
ok('player list loads for a brand-new user', players.length > 200, `${players.length}`)
ok('players have stat columns from patch 4', players[0] && players[0].prank != null, JSON.stringify(players[0] || {}))

const mk = await rpc(wyatt, 'create_mock_draft', {
  p_num_teams: 8, p_rounds: 9, p_scoring: 'ppr', p_pick_seconds: 90,
  p_my_slot: 4, p_team_name: 'Wyatt' })
ok('mock draft created', mk.ok, em(mk))
const L = mk.body?.league_id
if (!L) { console.log('\nFATAL: cannot continue'); process.exit(1) }

const teams = await sel(wyatt, `teams?league_id=eq.${L}&select=*`)
const draft = (await sel(wyatt, `drafts?league_id=eq.${L}&select=*`))[0]
const me = teams.find(t => t.draft_slot === 4)
ok('8 teams, I am slot 4', teams.length === 8 && !!me)
ok('draft is live immediately', draft.status === 'active')

// walk to my first turn the way the app does (commissioner picks for bots)
const taken = new Set()
let firstMineOk = null, err = null
for (let guard = 0; guard < 80; guard++) {
  const d = (await sel(wyatt, `drafts?id=eq.${draft.id}&select=status,current_pick`))[0]
  if (d.status === 'complete') break
  const t = teams.find(x => x.draft_slot === slotFor(d.current_pick, 8))
  let placed = false
  for (const c of players) {
    if (taken.has(c.id)) continue
    const r = await rpc(wyatt, 'make_pick', { p_draft_id: draft.id, p_team_id: t.id, p_player_id: c.id })
    if (r.ok) {
      taken.add(c.id); placed = true
      if (t.id === me.id && firstMineOk === null) firstMineOk = c.name
      break
    }
    const m = em(r)
    if (/still need|already drafted/i.test(m)) continue
    err = `pick ${d.current_pick}: ${m}`; break
  }
  if (err || !placed) break
}
ok('I CAN PICK A PLAYER (Wyatt\'s bug)', !!firstMineOk, err || 'never got a pick in')
if (firstMineOk) console.log('      first player I drafted:', firstMineOk)
ok('no pick errors anywhere in the draft', !err, err || '')

const done = (await sel(wyatt, `drafts?id=eq.${draft.id}&select=status`))[0]
ok('draft reached complete', done.status === 'complete', done.status)

const lu = await sel(wyatt, `lineups?team_id=eq.${me.id}&week=eq.1&select=slot`)
const mus = await sel(wyatt, `matchups?league_id=eq.${L}&select=week`)
ok('my week-1 lineup exists', lu.length > 0, `${lu.length} rows`)
ok('schedule exists', new Set(mus.map(m => m.week)).size === 14, `${new Set(mus.map(m => m.week)).size} weeks`)
const st = lu.filter(x => x.slot !== 'BN').map(x => x.slot).sort()
ok('starters include K and DEF', st.includes('K') && st.includes('DEF'), st.join(','))

/* ============ 2. a real league with 5 humans ============ */
console.log('\n=== 2. real league, 5 humans (your actual league) ===')
const kobe = await newUser('kobe')
const cl = await rpc(kobe, 'create_league', {
  p_name: 'The Boys', p_num_teams: 5, p_rounds: 9, p_scoring: 'ppr',
  p_pick_seconds: 90, p_team_name: 'Kobe' })
ok('league created', cl.ok, em(cl))
const L2 = cl.body?.league_id, code = cl.body?.join_code

const names = ['Alec', 'Wyatt', 'Connor', 'Aidan']
const others = []
for (const n of names) {
  const u = await newUser(n)
  const j = await rpc(u, 'join_league', { p_join_code: code, p_team_name: n })
  ok(`${n} joined with the code`, j.ok, em(j))
  others.push(u)
}
const start = await rpc(kobe, 'start_draft', { p_league_id: L2 })
ok('commissioner started the draft', start.ok, em(start))

const t2 = await sel(kobe, `teams?league_id=eq.${L2}&select=*`)
const d2 = (await sel(kobe, `drafts?league_id=eq.${L2}&select=*`))[0]
const all = [kobe, ...others]
const owner = {}
for (const u of all) {
  const mine = (await sel(u, `teams?league_id=eq.${L2}&owner_uid=eq.${u.uid}&select=*`))[0]
  if (mine) owner[mine.draft_slot] = { u, team: mine }
}
ok('all 5 humans have a team with a slot', Object.keys(owner).length === 5)

const taken2 = new Set(); let err2 = null, humanPicks = 0
for (let guard = 0; guard < 60; guard++) {
  const d = (await sel(kobe, `drafts?id=eq.${d2.id}&select=status,current_pick`))[0]
  if (d.status === 'complete') break
  const who = owner[slotFor(d.current_pick, 5)]
  let placed = false
  for (const c of players) {
    if (taken2.has(c.id)) continue
    const r = await rpc(who.u, 'make_pick', { p_draft_id: d2.id, p_team_id: who.team.id, p_player_id: c.id })
    if (r.ok) { taken2.add(c.id); placed = true; humanPicks++; break }
    const m = em(r)
    if (/still need|already drafted/i.test(m)) continue
    err2 = `${who.u.label} at pick ${d.current_pick}: ${m}`; break
  }
  if (err2 || !placed) break
}
ok('every human could draft on their turn', !err2, err2 || '')
ok('45 picks made', humanPicks === 45, `${humanPicks}`)
const fin = (await sel(kobe, `drafts?id=eq.${d2.id}&select=status`))[0]
ok('real league draft completed', fin.status === 'complete', fin.status)

for (const u of all) {
  const mine = (await sel(u, `teams?league_id=eq.${L2}&owner_uid=eq.${u.uid}&select=id,name`))[0]
  const l = await sel(u, `lineups?team_id=eq.${mine.id}&week=eq.1&select=slot`)
  ok(`${u.label} has a week-1 lineup`, l.length === 9, `${l.length}`)
}

console.log(`\n${'='.repeat(48)}\n${pass} passed, ${fail} failed\n${'='.repeat(48)}`)
process.exit(fail ? 1 : 0)
