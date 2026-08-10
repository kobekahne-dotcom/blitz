/* Attack suite against the LIVE database.
   Creates throwaway leagues, hammers them, reports pass/fail. */

const URL = 'https://yrgbnyoqyurtrisgbvai.supabase.co'
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlyZ2JueW9xeXVydHJpc2didmFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzNzY0MTEsImV4cCI6MjEwMTk1MjQxMX0.ZXfDJtOX0s5avbBfPMMDZuBU2s3KG7pWgJnbWcwgrf4'

let pass = 0, fail = 0
const ok = (n, c, extra = '') => {
  if (c) { pass++; console.log('  ✓', n) }
  else { fail++; console.log('  ✗ FAIL:', n, extra ? '\n      ' + extra : '') }
}

async function signUp() {
  const r = await fetch(`${URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: '{}',
  })
  const d = await r.json()
  if (!d.access_token) throw new Error('signup failed: ' + JSON.stringify(d))
  return { token: d.access_token, uid: d.user.id }
}

async function rpc(user, fn, args) {
  const r = await fetch(`${URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: ANON,
      Authorization: 'Bearer ' + user.token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args || {}),
  })
  const text = await r.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return { status: r.status, ok: r.ok, body }
}

async function sel(user, path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    headers: { apikey: ANON, Authorization: 'Bearer ' + user.token },
  })
  return { status: r.status, body: await r.json() }
}

const errMsg = (res) => (res.body && res.body.message) || JSON.stringify(res.body)

/* ---------- helper: build a league with N teams, started ---------- */
async function buildLeague(n, rounds = 4, secs = 600) {
  const commish = await signUp()
  const c = await rpc(commish, 'create_league', {
    p_name: 'TEST ' + Math.random().toString(36).slice(2, 8),
    p_num_teams: n, p_rounds: rounds, p_scoring: 'ppr',
    p_pick_seconds: secs, p_team_name: 'Commish Team',
  })
  if (!c.ok) throw new Error('create_league: ' + errMsg(c))
  const { league_id, join_code } = c.body

  const users = [commish]
  for (let i = 2; i <= n; i++) {
    const u = await signUp()
    const j = await rpc(u, 'join_league', { p_join_code: join_code, p_team_name: 'Team ' + i })
    if (!j.ok) throw new Error('join_league: ' + errMsg(j))
    users.push(u)
  }
  const s = await rpc(commish, 'start_draft', { p_league_id: league_id })
  if (!s.ok) throw new Error('start_draft: ' + errMsg(s))

  const teams = (await sel(commish, `teams?league_id=eq.${league_id}&select=*`)).body
  const draft = (await sel(commish, `drafts?league_id=eq.${league_id}&select=*`)).body[0]
  return { commish, users, league_id, join_code, teams, draft, n, rounds }
}

const slotForPick = (pick, teams) => {
  const round = Math.floor((pick - 1) / teams), idx = (pick - 1) % teams
  return round % 2 === 0 ? idx + 1 : teams - idx
}

/* ================================================================ */
console.log('\n=== 1. league lifecycle ===')
let L
try {
  L = await buildLeague(4, 4)
  ok('created league, 4 users joined, draft started', L.teams.length === 4)
  ok('all 4 teams got a unique draft slot',
    new Set(L.teams.map(t => t.draft_slot)).size === 4 &&
    L.teams.every(t => t.draft_slot >= 1 && t.draft_slot <= 4))
  ok('draft is active at pick 1', L.draft.status === 'active' && L.draft.current_pick === 1)
  ok('pick_deadline is set', !!L.draft.pick_deadline)
} catch (e) {
  fail++; console.log('  ✗ FATAL in setup:', e.message)
  process.exit(1)
}

/* ---------- players visible ---------- */
const pl = await sel(L.commish, 'players?select=id,name,pos,bye,adp&order=adp.asc&limit=400')
ok('players readable by a signed-in member', pl.status === 200 && pl.body.length > 300, `got ${pl.body.length}`)
const allPlayers = (await sel(L.commish, 'players?select=id,name,team,pos,bye,adp&limit=1000')).body
const wasPlayers = allPlayers.filter(p => p.team === 'WAS')
ok('Washington players exist and ALL have a bye (WAS/WSH trap)',
  wasPlayers.length > 0 && wasPlayers.every(p => p.bye !== null),
  `${wasPlayers.length} WAS players, ${wasPlayers.filter(p => p.bye === null).length} missing bye`)
ok('no player anywhere is missing a bye',
  allPlayers.filter(p => p.team && p.bye === null).length === 0)

/* ================================================================ */
console.log('\n=== 2. THE BIG ONE: 10 simultaneous picks at the same slot ===')
{
  const T = await buildLeague(4, 4)
  const slot1 = T.teams.find(t => t.draft_slot === 1)
  const owner = T.users.find(async () => true)
  // find which user owns slot 1
  let slot1User = null
  for (const u of T.users) {
    const mine = (await sel(u, `teams?id=eq.${slot1.id}&select=owner_uid`)).body[0]
    if (mine && mine.owner_uid === u.uid) { slot1User = u; break }
  }
  ok('located the user on the clock', !!slot1User)

  const targets = (await sel(slot1User, 'players?select=id&order=adp.asc&limit=10')).body
  // 10 simultaneous make_pick calls, same slot, 10 DIFFERENT players
  const results = await Promise.all(
    targets.map(t => rpc(slot1User, 'make_pick', {
      p_draft_id: T.draft.id, p_team_id: slot1.id, p_player_id: t.id,
    }))
  )
  const won = results.filter(r => r.ok)
  const lost = results.filter(r => !r.ok)
  ok('EXACTLY ONE of 10 simultaneous picks succeeded', won.length === 1,
    `succeeded=${won.length} failed=${lost.length}`)
  ok('the other 9 got clean errors (no crashes)',
    lost.length === 9 && lost.every(r => r.body && r.body.message),
    lost.map(r => errMsg(r)).slice(0, 3).join(' | '))

  const picks = (await sel(slot1User, `picks?draft_id=eq.${T.draft.id}&select=*`)).body
  ok('database has exactly 1 pick recorded', picks.length === 1, `found ${picks.length}`)
  const d2 = (await sel(slot1User, `drafts?id=eq.${T.draft.id}&select=*`)).body[0]
  ok('draft advanced to pick 2 exactly once', d2.current_pick === 2, `current_pick=${d2.current_pick}`)
}

/* ================================================================ */
console.log('\n=== 3. two teams grab the SAME player at once ===')
{
  const T = await buildLeague(4, 4)
  // find users for slot 1 and slot 2
  const bySlot = {}
  for (const u of T.users) {
    const mine = (await sel(u, `teams?league_id=eq.${T.league_id}&owner_uid=eq.${u.uid}&select=*`)).body[0]
    bySlot[mine.draft_slot] = { user: u, team: mine }
  }
  const target = (await sel(T.commish, 'players?select=id,name&order=adp.asc&limit=1')).body[0]

  const [a, b] = await Promise.all([
    rpc(bySlot[1].user, 'make_pick', { p_draft_id: T.draft.id, p_team_id: bySlot[1].team.id, p_player_id: target.id }),
    rpc(bySlot[2].user, 'make_pick', { p_draft_id: T.draft.id, p_team_id: bySlot[2].team.id, p_player_id: target.id }),
  ])
  const winners = [a, b].filter(r => r.ok)
  ok('exactly one team got the player', winners.length === 1,
    `a=${a.ok}:${errMsg(a)} b=${b.ok}:${errMsg(b)}`)
  ok('the loser was told why', winners.length === 1 && [a, b].some(r => !r.ok && /turn|drafted/i.test(errMsg(r))),
    [a, b].filter(r => !r.ok).map(errMsg).join(' | '))

  // now slot 2 tries the SAME player again on their real turn -> must fail
  const nowPick = (await sel(T.commish, `drafts?id=eq.${T.draft.id}&select=current_pick`)).body[0].current_pick
  const onClock = slotForPick(nowPick, 4)
  const dup = await rpc(bySlot[onClock].user, 'make_pick', {
    p_draft_id: T.draft.id, p_team_id: bySlot[onClock].team.id, p_player_id: target.id,
  })
  ok('same player cannot be drafted twice, even on a legit turn', !dup.ok && /already drafted/i.test(errMsg(dup)), errMsg(dup))
}

/* ================================================================ */
console.log('\n=== 4. turn enforcement & ownership ===')
{
  const T = await buildLeague(4, 4)
  const bySlot = {}
  for (const u of T.users) {
    const mine = (await sel(u, `teams?league_id=eq.${T.league_id}&owner_uid=eq.${u.uid}&select=*`)).body[0]
    bySlot[mine.draft_slot] = { user: u, team: mine }
  }
  const p = (await sel(T.commish, 'players?select=id&order=adp.asc&limit=5')).body

  const wrongTurn = await rpc(bySlot[3].user, 'make_pick',
    { p_draft_id: T.draft.id, p_team_id: bySlot[3].team.id, p_player_id: p[0].id })
  ok('slot 3 cannot pick when slot 1 is on the clock', !wrongTurn.ok && /not your turn/i.test(errMsg(wrongTurn)), errMsg(wrongTurn))

  // slot 2's user tries to pick USING slot 1's team id (impersonation)
  const impersonate = await rpc(bySlot[2].user, 'make_pick',
    { p_draft_id: T.draft.id, p_team_id: bySlot[1].team.id, p_player_id: p[1].id })
  ok('cannot pick using a team you do not own', !impersonate.ok && /do not own/i.test(errMsg(impersonate)), errMsg(impersonate))

  // outsider (not in the league at all)
  const outsider = await signUp()
  const out = await rpc(outsider, 'make_pick',
    { p_draft_id: T.draft.id, p_team_id: bySlot[1].team.id, p_player_id: p[2].id })
  ok('a total stranger cannot pick', !out.ok, errMsg(out))
  const peek = await sel(outsider, `picks?draft_id=eq.${T.draft.id}&select=*`)
  ok('a stranger cannot READ the league (RLS)', Array.isArray(peek.body) && peek.body.length === 0,
    JSON.stringify(peek.body).slice(0, 120))
  const peekL = await sel(outsider, `leagues?id=eq.${T.league_id}&select=*`)
  ok('a stranger cannot read the league row', Array.isArray(peekL.body) && peekL.body.length === 0)
}

/* ================================================================ */
console.log('\n=== 5. commissioner powers ===')
{
  const T = await buildLeague(3, 4)
  const bySlot = {}
  for (const u of T.users) {
    const mine = (await sel(u, `teams?league_id=eq.${T.league_id}&owner_uid=eq.${u.uid}&select=*`)).body[0]
    bySlot[mine.draft_slot] = { user: u, team: mine }
  }
  const p = (await sel(T.commish, 'players?select=id&order=adp.asc&limit=6')).body

  await rpc(bySlot[1].user, 'make_pick', { p_draft_id: T.draft.id, p_team_id: bySlot[1].team.id, p_player_id: p[0].id })

  const nonCommish = T.users.find(u => u.uid !== T.commish.uid)
  const badPause = await rpc(nonCommish, 'pause_draft', { p_draft_id: T.draft.id })
  ok('a normal manager cannot pause', !badPause.ok && /commissioner only/i.test(errMsg(badPause)), errMsg(badPause))

  const pause = await rpc(T.commish, 'pause_draft', { p_draft_id: T.draft.id })
  ok('commissioner can pause', pause.ok, errMsg(pause))

  const onClock2 = slotForPick(2, 3)
  const whilePaused = await rpc(bySlot[onClock2].user, 'make_pick',
    { p_draft_id: T.draft.id, p_team_id: bySlot[onClock2].team.id, p_player_id: p[1].id })
  ok('nobody can pick while paused', !whilePaused.ok && /paused/i.test(errMsg(whilePaused)), errMsg(whilePaused))

  ok('commissioner can resume', (await rpc(T.commish, 'resume_draft', { p_draft_id: T.draft.id })).ok)
  ok('commissioner can extend the clock', (await rpc(T.commish, 'extend_clock', { p_draft_id: T.draft.id, p_seconds: 30 })).ok)

  const undo = await rpc(T.commish, 'undo_last_pick', { p_draft_id: T.draft.id })
  ok('commissioner can undo the last pick', undo.ok, errMsg(undo))
  const after = (await sel(T.commish, `drafts?id=eq.${T.draft.id}&select=current_pick`)).body[0]
  ok('undo rolled the clock back to pick 1', after.current_pick === 1, `current_pick=${after.current_pick}`)
  const remaining = (await sel(T.commish, `picks?draft_id=eq.${T.draft.id}&select=id`)).body
  ok('undone pick is gone from the board', remaining.length === 0, `${remaining.length} picks left`)
  const redraft = await rpc(bySlot[1].user, 'make_pick',
    { p_draft_id: T.draft.id, p_team_id: bySlot[1].team.id, p_player_id: p[0].id })
  ok('the undone player can be drafted again', redraft.ok, errMsg(redraft))
}

/* ================================================================ */
console.log('\n=== 6. autopick on the SERVER clock (all clients "closed") ===')
{
  const T = await buildLeague(3, 4, 15)   // 15s clock — minimum allowed
  console.log('     waiting 17s for the clock to expire with nobody picking…')
  await new Promise(r => setTimeout(r, 17000))

  const early = await rpc(T.commish, 'autopick_if_expired', { p_draft_id: T.draft.id })
  ok('autopick fired after the deadline passed', early.ok && early.body.fired === true, JSON.stringify(early.body))

  const picks = (await sel(T.commish, `picks?draft_id=eq.${T.draft.id}&select=*`)).body
  ok('exactly one autopick was recorded', picks.length === 1, `${picks.length} picks`)
  ok('it is flagged as auto', picks[0] && picks[0].auto === true)
  ok('autopick took the best available by ADP', !!picks[0])

  // hammer it: 8 clients all call autopick at once on a fresh expiry
  await new Promise(r => setTimeout(r, 16000))
  const many = await Promise.all(Array.from({ length: 8 }, () => rpc(T.commish, 'autopick_if_expired', { p_draft_id: T.draft.id })))
  const fired = many.filter(r => r.ok && r.body.fired === true)
  ok('8 simultaneous autopick calls fire exactly ONCE', fired.length === 1, `fired ${fired.length} times`)
  const picks2 = (await sel(T.commish, `picks?draft_id=eq.${T.draft.id}&select=*`)).body
  ok('still only 2 picks total after the stampede', picks2.length === 2, `${picks2.length} picks`)
}

/* ================================================================ */
console.log('\n=== 7. full mock draft, 10 teams x 15 rounds = 150 picks ===')
{
  const t0 = Date.now()
  const T = await buildLeague(10, 15, 600)
  const bySlot = {}
  for (const u of T.users) {
    const mine = (await sel(u, `teams?league_id=eq.${T.league_id}&owner_uid=eq.${u.uid}&select=*`)).body[0]
    bySlot[mine.draft_slot] = { user: u, team: mine }
  }
  const pool = (await sel(T.commish, 'players?select=id&order=adp.asc&limit=400')).body.map(p => p.id)
  const taken = new Set()
  let errors = 0

  for (let pick = 1; pick <= 150; pick++) {
    const slot = slotForPick(pick, 10)
    const who = bySlot[slot]
    const next = pool.find(id => !taken.has(id))
    const r = await rpc(who.user, 'make_pick', { p_draft_id: T.draft.id, p_team_id: who.team.id, p_player_id: next })
    if (!r.ok) { errors++; if (errors < 4) console.log(`     pick ${pick} failed: ${errMsg(r)}`) }
    else taken.add(next)
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  ok(`all 150 picks succeeded (${secs}s)`, errors === 0, `${errors} errors`)

  const final = (await sel(T.commish, `drafts?id=eq.${T.draft.id}&select=*`)).body[0]
  ok('draft auto-marked COMPLETE at pick 150', final.status === 'complete', `status=${final.status}`)
  ok('pick_deadline cleared on completion', final.pick_deadline === null)

  const allPicks = (await sel(T.commish, `picks?draft_id=eq.${T.draft.id}&select=*&order=pick_no`)).body
  ok('exactly 150 picks stored', allPicks.length === 150, `${allPicks.length}`)
  ok('pick numbers are 1..150 with no gaps or dupes',
    allPicks.every((p, i) => p.pick_no === i + 1))
  ok('no player drafted twice', new Set(allPicks.map(p => p.player_id)).size === 150)

  // every team got exactly 15
  const perTeam = {}
  allPicks.forEach(p => { perTeam[p.team_id] = (perTeam[p.team_id] || 0) + 1 })
  ok('every team drafted exactly 15 players',
    Object.keys(perTeam).length === 10 && Object.values(perTeam).every(v => v === 15),
    JSON.stringify(Object.values(perTeam)))

  // snake order held all the way through
  let snakeOk = true
  for (const p of allPicks) {
    const expectSlot = slotForPick(p.pick_no, 10)
    const team = T.teams.find(t => t.id === p.team_id)
    const actual = Object.values(bySlot).find(x => x.team.id === p.team_id)?.team.draft_slot
    if (actual !== expectSlot) { snakeOk = false; break }
  }
  ok('snake order held for all 150 picks', snakeOk)

  const done = await rpc(bySlot[1].user, 'make_pick',
    { p_draft_id: T.draft.id, p_team_id: bySlot[1].team.id, p_player_id: pool[399] })
  ok('a 151st pick is refused', !done.ok && /complete/i.test(errMsg(done)), errMsg(done))
}

/* ================================================================ */
console.log('\n=== 8. joining rules ===')
{
  const T = await buildLeague(2, 4)
  const late = await signUp()
  const r = await rpc(late, 'join_league', { p_join_code: T.join_code, p_team_name: 'Too Late' })
  ok('cannot join after the draft starts', !r.ok && /already started/i.test(errMsg(r)), errMsg(r))

  const c2 = await signUp()
  const made = await rpc(c2, 'create_league', {
    p_name: 'Cap Test', p_num_teams: 2, p_rounds: 4, p_scoring: 'ppr',
    p_pick_seconds: 90, p_team_name: 'A',
  })
  const u2 = await signUp()
  await rpc(u2, 'join_league', { p_join_code: made.body.join_code, p_team_name: 'B' })
  const u3 = await signUp()
  const full = await rpc(u3, 'join_league', { p_join_code: made.body.join_code, p_team_name: 'C' })
  ok('cannot exceed the league size', !full.ok && /full/i.test(errMsg(full)), errMsg(full))

  const rejoin = await rpc(u2, 'join_league', { p_join_code: made.body.join_code, p_team_name: 'B again' })
  ok('re-joining on the same device returns your existing team', rejoin.ok && rejoin.body.rejoined === true, JSON.stringify(rejoin.body))

  const bad = await rpc(u3, 'join_league', { p_join_code: 'zzzzzzzz', p_team_name: 'X' })
  ok('a bad code is rejected cleanly', !bad.ok && /no league/i.test(errMsg(bad)), errMsg(bad))

  const solo = await signUp()
  const madeSolo = await rpc(solo, 'create_league', {
    p_name: 'Solo', p_num_teams: 4, p_rounds: 4, p_scoring: 'ppr',
    p_pick_seconds: 90, p_team_name: 'Only',
  })
  const startSolo = await rpc(solo, 'start_draft', { p_league_id: madeSolo.body.league_id })
  ok('cannot start a draft with only 1 team', !startSolo.ok && /at least 2/i.test(errMsg(startSolo)), errMsg(startSolo))
}

/* ================================================================ */
console.log('\n=== 9. short-league safety (start with fewer than max) ===')
{
  const c = await signUp()
  const made = await rpc(c, 'create_league', {
    p_name: 'Short', p_num_teams: 12, p_rounds: 4, p_scoring: 'ppr',
    p_pick_seconds: 600, p_team_name: 'One',
  })
  const u2 = await signUp()
  await rpc(u2, 'join_league', { p_join_code: made.body.join_code, p_team_name: 'Two' })
  const u3 = await signUp()
  await rpc(u3, 'join_league', { p_join_code: made.body.join_code, p_team_name: 'Three' })

  const s = await rpc(c, 'start_draft', { p_league_id: made.body.league_id })
  ok('draft starts with 3 of 12 slots filled', s.ok && s.body.teams === 3, JSON.stringify(s.body))
  const lg = (await sel(c, `leagues?id=eq.${made.body.league_id}&select=num_teams`)).body[0]
  ok('league resized to the 3 who showed up', lg.num_teams === 3, `num_teams=${lg.num_teams}`)
}

console.log(`\n${'='.repeat(50)}\n${pass} passed, ${fail} failed\n${'='.repeat(50)}`)
process.exit(fail ? 1 : 0)
