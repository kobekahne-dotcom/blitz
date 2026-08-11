/* The actual shape of Kobe's league:
   12 teams = 5 humans (Kobe, Alec, Wyatt, Connor, Aidan) + 7 bots,
   15 rounds = 180 picks. Bots are driven the way scripts/bots.mjs does it. */

const API = 'https://yrgbnyoqyurtrisgbvai.supabase.co'
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlyZ2JueW9xeXVydHJpc2didmFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzNzY0MTEsImV4cCI6MjEwMTk1MjQxMX0.ZXfDJtOX0s5avbBfPMMDZuBU2s3KG7pWgJnbWcwgrf4'

let pass = 0, fail = 0
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))


/* the network drops occasionally on this machine; retry transport errors
   so a blip doesn't look like an app failure */
async function fetchR(url, opts, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { return await fetch(url, opts) }
    catch (e) {
      if (i === tries - 1) throw e
      await sleep(1500 * (i + 1))
    }
  }
}

async function newUser(label) {
  for (let i = 0; i < 8; i++) {
    const r = await fetchR(`${API}/auth/v1/signup`, {
      method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: '{}' })
    const d = await r.json()
    if (d.access_token) return { tok: d.access_token, uid: d.user.id, label }
    if (d.error_code === 'over_request_rate_limit') { await sleep(10000); continue }
    throw new Error(label + ': ' + JSON.stringify(d))
  }
  throw new Error(label + ': rate limited out')
}
const H = u => ({ apikey: ANON, Authorization: 'Bearer ' + u.tok, 'Content-Type': 'application/json' })
const rpc = async (u, f, a) => {
  const r = await fetchR(`${API}/rest/v1/rpc/${f}`, { method: 'POST', headers: H(u), body: JSON.stringify(a) })
  const t = await r.text(); let b; try { b = JSON.parse(t) } catch { b = t }
  return { ok: r.ok, body: b }
}
const sel = async (u, p) => (await fetchR(`${API}/rest/v1/${p}`, { headers: H(u) })).json()
const em = r => (r.body && r.body.message) || JSON.stringify(r.body)
const slotFor = (pick, n) => { const r = Math.floor((pick - 1) / n), i = (pick - 1) % n; return r % 2 === 0 ? i + 1 : n - i }

const TEAMS = 12, ROUNDS = 15, TOTAL = TEAMS * ROUNDS
console.log(`\n=== ${TEAMS} teams (5 humans + 7 bots) x ${ROUNDS} rounds = ${TOTAL} picks ===`)

const kobe = await newUser('Kobe')
const players = await sel(kobe, 'players?select=id,name,pos&order=adp.asc.nullslast&limit=600')
ok('player pool loaded', players.length >= 400, `${players.length}`)

const cl = await rpc(kobe, 'create_league', {
  p_name: 'The Boys 2026', p_num_teams: TEAMS, p_rounds: ROUNDS,
  p_scoring: 'ppr', p_pick_seconds: 90, p_team_name: 'Kobe' })
ok('12-team league created', cl.ok, em(cl))
const L = cl.body?.league_id, code = cl.body?.join_code
if (!L) process.exit(1)

const humans = [kobe]
for (const n of ['Alec', 'Wyatt', 'Connor', 'Aidan']) {
  const u = await newUser(n)
  const j = await rpc(u, 'join_league', { p_join_code: code, p_team_name: n })
  ok(`${n} joined`, j.ok, em(j))
  humans.push(u)
}
const bots = []
const botNames = ['Gridiron Goblins', 'Couch Commanders', 'Bye Week Bandits',
                  'Waiver Wire Wolves', 'Sunday Scaries', 'Pylon Pirates', 'Hail Mary Hooligans']
for (const n of botNames) {
  const u = await newUser(n)
  const j = await rpc(u, 'join_league', { p_join_code: code, p_team_name: n })
  if (!j.ok) { ok(`bot ${n} joined`, false, em(j)); break }
  bots.push(u)
}
ok('all 7 bots joined', bots.length === 7, `${bots.length}`)

const start = await rpc(kobe, 'start_draft', { p_league_id: L })
ok('draft started with 12 teams', start.ok && start.body.teams === TEAMS, em(start))

const teams = await sel(kobe, `teams?league_id=eq.${L}&select=*`)
const draft = (await sel(kobe, `drafts?league_id=eq.${L}&select=*`))[0]
const all = [...humans, ...bots]
const bySlot = {}
for (const u of all) {
  const t = (await sel(u, `teams?league_id=eq.${L}&owner_uid=eq.${u.uid}&select=*`))[0]
  if (t) bySlot[t.draft_slot] = { u, team: t }
}
ok('all 12 teams have a unique slot', Object.keys(bySlot).length === TEAMS)

const t0 = Date.now()
const taken = new Set()
let err = null, made = 0, locks = 0
for (let guard = 0; guard < TOTAL + 40; guard++) {
  const d = (await sel(kobe, `drafts?id=eq.${draft.id}&select=status,current_pick`))[0]
  if (d.status === 'complete') break
  const who = bySlot[slotFor(d.current_pick, TEAMS)]
  let placed = false
  for (const c of players) {
    if (taken.has(c.id)) continue
    const r = await rpc(who.u, 'make_pick', { p_draft_id: draft.id, p_team_id: who.team.id, p_player_id: c.id })
    if (r.ok) { taken.add(c.id); placed = true; made++; break }
    const m = em(r)
    if (/still need|Take one/i.test(m)) { locks++; continue }
    if (/already drafted/i.test(m)) continue
    err = `${who.u.label} at pick ${d.current_pick}: ${m}`; break
  }
  if (err || !placed) break
  if (made % 30 === 0) process.stdout.write(`      ${made}/${TOTAL}\r`)
}
const secs = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`      ${made}/${TOTAL} picks in ${secs}s      `)

ok('no errors across 180 picks', !err, err || '')
ok(`all ${TOTAL} picks made`, made === TOTAL, `${made}`)
ok('roster lock engaged during the draft', locks > 0, `${locks} refusals`)

const fin = (await sel(kobe, `drafts?id=eq.${draft.id}&select=status`))[0]
ok('draft complete', fin.status === 'complete', fin.status)

const picks = await sel(kobe, `picks?draft_id=eq.${draft.id}&select=pick_no,team_id,player_id&order=pick_no`)
ok('no duplicate players', new Set(picks.map(p => p.player_id)).size === TOTAL)
ok('pick numbers 1..180 clean', picks.every((p, i) => p.pick_no === i + 1))
const per = {}; picks.forEach(p => per[p.team_id] = (per[p.team_id] || 0) + 1)
ok('every team drafted exactly 15', Object.values(per).every(v => v === ROUNDS), JSON.stringify(Object.values(per)))

console.log('\n=== after the draft ===')
const mus = await sel(kobe, `matchups?league_id=eq.${L}&select=week,home_team_id,away_team_id`)
ok('14-week schedule built', new Set(mus.map(m => m.week)).size === 14)
ok('6 matchups per week for 12 teams', mus.filter(m => m.week === 1).length === 6, `${mus.filter(m => m.week === 1).length}`)

let allGood = true
for (const u of humans) {
  const t = (await sel(u, `teams?league_id=eq.${L}&owner_uid=eq.${u.uid}&select=id`))[0]
  const l = await sel(u, `lineups?team_id=eq.${t.id}&week=eq.1&select=slot`)
  const st = l.filter(x => x.slot !== 'BN').map(x => x.slot).sort()
  const good = l.length === ROUNDS && st.includes('K') && st.includes('DEF') && st.includes('FLEX')
  if (!good) allGood = false
  console.log(`      ${u.label}: ${l.length} players, starters ${st.join(',')}`)
}
ok('every human has a full valid week-1 lineup', allGood)

const roster = picks.filter(p => p.team_id === bySlot[1].team.id)
  .map(p => players.find(x => x.id === p.player_id)).filter(Boolean)
const cnt = {}; roster.forEach(p => cnt[p.pos] = (cnt[p.pos] || 0) + 1)
console.log('      slot-1 roster composition:', JSON.stringify(cnt))
ok('slot 1 ended with a kicker and a defense', (cnt.K || 0) >= 1 && (cnt.DEF || 0) >= 1, JSON.stringify(cnt))

console.log(`\n${'='.repeat(48)}\n${pass} passed, ${fail} failed\n${'='.repeat(48)}`)
process.exit(fail ? 1 : 0)
