/* Part 2: full 150-pick mock draft + join rules.
   Signups are rate-limited on the free tier, so back off and reuse. */

const URL = 'https://yrgbnyoqyurtrisgbvai.supabase.co'
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlyZ2JueW9xeXVydHJpc2didmFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzNzY0MTEsImV4cCI6MjEwMTk1MjQxMX0.ZXfDJtOX0s5avbBfPMMDZuBU2s3KG7pWgJnbWcwgrf4'

let pass = 0, fail = 0
const ok = (n, c, extra = '') => {
  if (c) { pass++; console.log('  ✓', n) }
  else { fail++; console.log('  ✗ FAIL:', n, extra ? '\n      ' + extra : '') }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function signUp(attempt = 0) {
  const r = await fetch(`${URL}/auth/v1/signup`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: '{}',
  })
  const d = await r.json()
  if (d.access_token) return { token: d.access_token, uid: d.user.id }
  if (d.error_code === 'over_request_rate_limit' && attempt < 12) {
    const wait = 20000
    console.log(`     rate limited, waiting ${wait / 1000}s (attempt ${attempt + 1})…`)
    await sleep(wait)
    return signUp(attempt + 1)
  }
  throw new Error('signup failed: ' + JSON.stringify(d))
}

async function rpc(user, fn, args) {
  const r = await fetch(`${URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: 'Bearer ' + user.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(args || {}),
  })
  const t = await r.text()
  let body; try { body = JSON.parse(t) } catch { body = t }
  return { ok: r.ok, body }
}
async function sel(user, path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    headers: { apikey: ANON, Authorization: 'Bearer ' + user.token },
  })
  return { body: await r.json() }
}
const errMsg = r => (r.body && r.body.message) || JSON.stringify(r.body)
const slotForPick = (pick, teams) => {
  const round = Math.floor((pick - 1) / teams), idx = (pick - 1) % teams
  return round % 2 === 0 ? idx + 1 : teams - idx
}

const TEAMS = 10, ROUNDS = 15, TOTAL = TEAMS * ROUNDS

console.log(`\n=== full mock draft: ${TEAMS} teams x ${ROUNDS} rounds = ${TOTAL} picks ===`)
console.log('     creating users (this is the slow part — signup rate limits)…')

const commish = await signUp()
const made = await rpc(commish, 'create_league', {
  p_name: 'FULL MOCK', p_num_teams: TEAMS, p_rounds: ROUNDS,
  p_scoring: 'ppr', p_pick_seconds: 600, p_team_name: 'Team 1',
})
if (!made.ok) { console.log('create failed:', errMsg(made)); process.exit(1) }
const { league_id, join_code } = made.body

const users = [commish]
for (let i = 2; i <= TEAMS; i++) {
  const u = await signUp()
  const j = await rpc(u, 'join_league', { p_join_code: join_code, p_team_name: 'Team ' + i })
  if (!j.ok) { console.log(`join ${i} failed:`, errMsg(j)); process.exit(1) }
  users.push(u)
  process.stdout.write(`     ${i}/${TEAMS} joined\r`)
}
console.log(`     ${TEAMS}/${TEAMS} joined      `)

const started = await rpc(commish, 'start_draft', { p_league_id: league_id })
ok('draft started with 10 teams', started.ok && started.body.teams === TEAMS, errMsg(started))

const draft = (await sel(commish, `drafts?league_id=eq.${league_id}&select=*`)).body[0]
const bySlot = {}
for (const u of users) {
  const mine = (await sel(u, `teams?league_id=eq.${league_id}&owner_uid=eq.${u.uid}&select=*`)).body[0]
  bySlot[mine.draft_slot] = { user: u, team: mine }
}
ok('all 10 slots assigned uniquely', Object.keys(bySlot).length === TEAMS)

const pool = (await sel(commish, 'players?select=id,name&order=adp.asc&limit=400')).body
ok('player pool big enough for 150 picks', pool.length >= TOTAL, `${pool.length} players`)

const t0 = Date.now()
const taken = new Set()
let errors = 0, firstErr = ''
for (let pick = 1; pick <= TOTAL; pick++) {
  const who = bySlot[slotForPick(pick, TEAMS)]
  const next = pool.find(p => !taken.has(p.id))
  const r = await rpc(who.user, 'make_pick', {
    p_draft_id: draft.id, p_team_id: who.team.id, p_player_id: next.id,
  })
  if (!r.ok) { errors++; if (!firstErr) firstErr = `pick ${pick}: ${errMsg(r)}` }
  else taken.add(next.id)
  if (pick % 30 === 0) process.stdout.write(`     ${pick}/${TOTAL} picks\r`)
}
const secs = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`     ${TOTAL}/${TOTAL} picks in ${secs}s     `)
ok(`all ${TOTAL} picks succeeded`, errors === 0, `${errors} errors. ${firstErr}`)

const final = (await sel(commish, `drafts?id=eq.${draft.id}&select=*`)).body[0]
ok('draft auto-marked COMPLETE', final.status === 'complete', `status=${final.status}`)
ok('clock cleared on completion', final.pick_deadline === null)

const all = (await sel(commish, `picks?draft_id=eq.${draft.id}&select=*&order=pick_no`)).body
ok(`exactly ${TOTAL} picks stored`, all.length === TOTAL, `${all.length}`)
ok('pick numbers run 1..150 with no gaps or duplicates', all.every((p, i) => p.pick_no === i + 1))
ok('no player was drafted twice', new Set(all.map(p => p.player_id)).size === TOTAL)

const perTeam = {}
all.forEach(p => { perTeam[p.team_id] = (perTeam[p.team_id] || 0) + 1 })
ok('every team drafted exactly 15 players',
  Object.keys(perTeam).length === TEAMS && Object.values(perTeam).every(v => v === ROUNDS),
  JSON.stringify(Object.values(perTeam)))

let snakeOk = true, badPick = null
for (const p of all) {
  const expect = slotForPick(p.pick_no, TEAMS)
  const actual = Object.values(bySlot).find(x => x.team.id === p.team_id)?.team.draft_slot
  if (actual !== expect) { snakeOk = false; badPick = `pick ${p.pick_no}: expected slot ${expect}, got ${actual}`; break }
}
ok('snake order held for all 150 picks', snakeOk, badPick || '')

const extra = await rpc(bySlot[1].user, 'make_pick', {
  p_draft_id: draft.id, p_team_id: bySlot[1].team.id, p_player_id: pool[399].id,
})
ok('a 151st pick is refused', !extra.ok && /complete/i.test(errMsg(extra)), errMsg(extra))

const late = await rpc(users[3], 'join_league', { p_join_code: join_code, p_team_name: 'Late' })
ok('cannot join after the draft started', !late.ok, errMsg(late))

// rosters actually saved and readable
const roster1 = all.filter(p => p.team_id === bySlot[1].team.id)
ok('slot 1 roster saved with 15 players', roster1.length === ROUNDS)
const names = roster1.map(p => (pool.find(x => x.id === p.player_id) || {}).name).filter(Boolean)
ok('roster resolves to real player names', names.length === ROUNDS, names.slice(0, 3).join(', '))
console.log('     slot 1 first 5:', names.slice(0, 5).join(' | '))

console.log(`\n${'='.repeat(50)}\n${pass} passed, ${fail} failed\n${'='.repeat(50)}`)
process.exit(fail ? 1 : 0)
