/* THE KOLE TEST.
   ESPN autodrafted Kole 3 QBs and 3 TEs. Here a team never picks at all —
   every one of their 15 picks comes from autopick. Then we check the roster
   is something a human would actually accept. Also proves a drafted league
   can now be deleted. */

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
    if (d.access_token) return { tok: d.access_token, uid: d.user.id }
    await sleep(9000)
  }
  throw new Error('signup rate limited')
}
let U
const H = () => ({ apikey: ANON, Authorization: 'Bearer ' + U.tok, 'Content-Type': 'application/json' })
const rpc = async (f, a) => {
  const r = await fetchR(`${API}/rest/v1/rpc/${f}`, { method: 'POST', headers: H(), body: JSON.stringify(a) })
  const t = await r.text(); let b; try { b = JSON.parse(t) } catch { b = t }
  return { ok: r.ok, body: b }
}
const sel = async p => (await fetchR(`${API}/rest/v1/${p}`, { headers: H() })).json()
const em = r => (r.body && r.body.message) || JSON.stringify(r.body)
const slotFor = (pk, n) => { const r = Math.floor((pk - 1) / n), i = (pk - 1) % n; return r % 2 === 0 ? i + 1 : n - i }

U = await su()
const TEAMS = 10, ROUNDS = 15, TOTAL = TEAMS * ROUNDS
const ABSENT = 7   // this slot never picks — autopick does everything

console.log(`\n=== ${TEAMS}x${ROUNDS}; slot ${ABSENT} never picks (pure autopick) ===`)
const mk = await rpc('create_mock_draft', {
  p_num_teams: TEAMS, p_rounds: ROUNDS, p_scoring: 'ppr',
  p_pick_seconds: 15, p_my_slot: 1, p_team_name: 'Me' })
ok('league created', mk.ok, em(mk))
const L = mk.body?.league_id
if (!L) process.exit(1)

const teams = await sel(`teams?league_id=eq.${L}&select=*`)
const draft = (await sel(`drafts?league_id=eq.${L}&select=*`))[0]
const players = await sel('players?select=id,name,pos,adp&order=adp.asc.nullslast&limit=400')
const byId = new Map(players.map(p => [p.id, p]))
const absentTeam = teams.find(t => t.draft_slot === ABSENT)

let err = null, autoCount = 0
for (let guard = 0; guard < TOTAL + 60; guard++) {
  const d = (await sel(`drafts?id=eq.${draft.id}&select=status,current_pick,pick_deadline`))[0]
  if (d.status === 'complete') break
  const slot = slotFor(d.current_pick, TEAMS)

  if (slot === ABSENT) {
    // let the clock run out; the server must pick for them
    const waitMs = new Date(d.pick_deadline) - Date.now() + 900
    if (waitMs > 0) await sleep(Math.min(waitMs, 17000))
    const fired = await rpc('autopick_if_expired', { p_draft_id: draft.id })
    if (fired.ok && fired.body?.fired) autoCount++
    else if (!fired.ok) { err = 'autopick: ' + em(fired); break }
    continue
  }

  const t = teams.find(x => x.draft_slot === slot)
  const gone = new Set((await sel(`picks?draft_id=eq.${draft.id}&select=player_id`)).map(x => x.player_id))
  let placed = false
  for (const c of players) {
    if (gone.has(c.id)) continue
    const r = await rpc('make_pick', { p_draft_id: draft.id, p_team_id: t.id, p_player_id: c.id })
    if (r.ok) { placed = true; break }
    const m = em(r)
    if (/still need|already drafted|not your turn/i.test(m)) continue
    err = `pick ${d.current_pick}: ${m}`; break
  }
  if (err) break
  if (!placed) { err = `could not fill pick ${d.current_pick}`; break }
}
ok('draft ran to the end with no errors', !err, err || '')
ok('autopick fired for the absent team', autoCount > 0, `${autoCount} times`)

const fin = (await sel(`drafts?id=eq.${draft.id}&select=status`))[0]
ok('draft complete', fin.status === 'complete', fin.status)

const picks = await sel(`picks?draft_id=eq.${draft.id}&select=pick_no,team_id,player_id,auto&order=pick_no`)
const theirs = picks.filter(p => p.team_id === absentTeam.id)
const roster = theirs.map(p => byId.get(p.player_id)).filter(Boolean)
const cnt = {}; roster.forEach(p => cnt[p.pos] = (cnt[p.pos] || 0) + 1)

console.log('\n--- the fully autodrafted roster ---')
theirs.forEach(p => {
  const pl = byId.get(p.player_id)
  const round = Math.floor((p.pick_no - 1) / TEAMS) + 1
  console.log(`   R${String(round).padStart(2)}  ${(pl?.pos || '??').padEnd(3)} ${(pl?.name || p.player_id).padEnd(24)} ${p.auto ? '(auto)' : ''}`)
})
console.log('   composition:', JSON.stringify(cnt))

console.log('\n--- would a human accept this roster? ---')
ok('every pick was automatic', theirs.every(p => p.auto), theirs.filter(p => !p.auto).length + ' manual')
ok('at most 2 QBs  (ESPN gave Kole 3)', (cnt.QB || 0) <= 2, `${cnt.QB || 0}`)
ok('at most 2 TEs  (ESPN gave Kole 3)', (cnt.TE || 0) <= 2, `${cnt.TE || 0}`)
ok('exactly 1 kicker', (cnt.K || 0) === 1, `${cnt.K || 0}`)
ok('exactly 1 defense', (cnt.DEF || 0) === 1, `${cnt.DEF || 0}`)
ok('at least 4 RBs', (cnt.RB || 0) >= 4, `${cnt.RB || 0}`)
ok('at least 4 WRs', (cnt.WR || 0) >= 4, `${cnt.WR || 0}`)
ok('has a starting QB', (cnt.QB || 0) >= 1)
ok('has a starting TE', (cnt.TE || 0) >= 1)

const kRound = theirs.map((p, i) => ({ r: Math.floor((p.pick_no - 1) / TEAMS) + 1, pos: byId.get(p.player_id)?.pos }))
const kAt = kRound.find(x => x.pos === 'K')?.r
const dAt = kRound.find(x => x.pos === 'DEF')?.r
console.log(`   kicker taken in round ${kAt}, defense in round ${dAt} (of ${ROUNDS})`)
ok('kicker taken in the last 2 rounds', kAt >= ROUNDS - 1, `round ${kAt}`)
ok('defense taken in the last 2 rounds', dAt >= ROUNDS - 1, `round ${dAt}`)
const qb2 = kRound.filter(x => x.pos === 'QB')[1]
if (qb2) { ok('backup QB not taken early', qb2.r >= Math.ceil(ROUNDS * 0.66), `round ${qb2.r}`) }
else { ok('backup QB not taken early', true, 'only one QB') }

console.log('\n--- delete a drafted league ---')
const del = await rpc('delete_league', { p_league_id: L })
ok('drafted league deletes cleanly', del.ok, em(del))
const still = await sel(`leagues?id=eq.${L}&select=id`)
ok('league is actually gone', Array.isArray(still) && still.length === 0)

console.log(`\n${'='.repeat(48)}\n${pass} passed, ${fail} failed\n${'='.repeat(48)}`)
process.exit(fail ? 1 : 0)
