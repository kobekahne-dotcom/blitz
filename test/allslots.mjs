/* Every draft slot, every league size.
   Slot 1 and slot N are the turn positions — they pick back-to-back and
   have the longest wait between picks, so they stress the autopick brain
   and the roster lock differently from the middle. Check all of them. */

const API = 'https://yrgbnyoqyurtrisgbvai.supabase.co'
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlyZ2JueW9xeXVydHJpc2didmFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzNzY0MTEsImV4cCI6MjEwMTk1MjQxMX0.ZXfDJtOX0s5avbBfPMMDZuBU2s3KG7pWgJnbWcwgrf4'

let pass = 0, fail = 0
const ok = (n, c, x = '') => { c ? (pass++, console.log('   ✓', n)) : (fail++, console.log('   ✗', n, x)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function fetchR(u, o, t = 5) {
  for (let i = 0; i < t; i++) { try { return await fetch(u, o) } catch (e) { if (i === t - 1) throw e; await sleep(1200 * (i + 1)) } }
}
const su = async () => {
  for (let i = 0; i < 10; i++) {
    const r = await fetchR(`${API}/auth/v1/signup`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: '{}' })
    const d = await r.json()
    if (d.access_token) return { tok: d.access_token, refresh: d.refresh_token, uid: d.user.id }
    await sleep(8000)
  }
  throw new Error('signup rate limited')
}

/* Access tokens last an hour; a 180-pick draft outlives that. Browsers
   refresh automatically (autoRefreshToken), so the harness must too or
   it reports a false failure. */
const expiringSoon = t => {
  try { return (JSON.parse(Buffer.from(t.split('.')[1],'base64')).exp * 1000) - Date.now() < 120000 }
  catch { return true }
}
async function keepAlive() {
  if (!expiringSoon(U.tok)) return
  const r = await fetchR(`${API}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: U.refresh }) })
  const d = await r.json()
  if (d.access_token) { U.tok = d.access_token; U.refresh = d.refresh_token; console.log('   (token refreshed)') }
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
const players = await sel('players?select=id,name,pos,adp&order=adp.asc.nullslast&limit=700')
const byId = new Map(players.map(p => [p.id, p]))
console.log(`player pool: ${players.length}\n`)

async function runLeague(TEAMS, ROUNDS) {
  const mk = await rpc('create_mock_draft', {
    p_num_teams: TEAMS, p_rounds: ROUNDS, p_scoring: 'ppr',
    p_pick_seconds: 600, p_my_slot: 1, p_team_name: 'Slot1' })
  if (!mk.ok) return { err: em(mk) }
  const L = mk.body.league_id
  const teams = await sel(`teams?league_id=eq.${L}&select=*`)
  const draft = (await sel(`drafts?league_id=eq.${L}&select=*`))[0]

  for (let pick = 1; pick <= TEAMS * ROUNDS; pick++) {
    if (pick % 25 === 0) await keepAlive()
    const t = teams.find(x => x.draft_slot === slotFor(pick, TEAMS))
    const c = await rpc('autopick_choice', { p_draft_id: draft.id, p_team_id: t.id })
    if (!c.ok) return { err: `autopick_choice @${pick}: ${em(c)}`, L }
    const r = await rpc('make_pick', { p_draft_id: draft.id, p_team_id: t.id, p_player_id: c.body })
    if (!r.ok) return { err: `make_pick @${pick}: ${em(r)}`, L }
  }
  const picks = await sel(`picks?draft_id=eq.${draft.id}&select=pick_no,team_id,player_id&order=pick_no`)
  const status = (await sel(`drafts?id=eq.${draft.id}&select=status`))[0].status
  return { L, teams, picks, status }
}

/* ============ 1. every slot in a 12-team, 15-round league ============ */
console.log('=== 12 teams x 15 rounds — checking ALL 12 slots ===')
{
  const TEAMS = 12, ROUNDS = 15
  const res = await runLeague(TEAMS, ROUNDS)
  if (res.err) { console.log('   FATAL:', res.err); fail++ }
  else {
    ok('draft completed', res.status === 'complete', res.status)
    ok(`${TEAMS * ROUNDS} picks made`, res.picks.length === TEAMS * ROUNDS, `${res.picks.length}`)
    ok('no duplicate players', new Set(res.picks.map(p => p.player_id)).size === res.picks.length)

    console.log('\n   slot  RB WR QB TE  K DEF   K@rd DEF@rd  worst reach  verdict')
    let allGood = true
    for (const t of [...res.teams].sort((a, b) => a.draft_slot - b.draft_slot)) {
      const mine = res.picks.filter(p => p.team_id === t.id)
      const cnt = {}; let kRd = null, dRd = null, worst = 0
      mine.forEach(p => {
        const pl = byId.get(p.player_id); if (!pl) return
        cnt[pl.pos] = (cnt[pl.pos] || 0) + 1
        const rd = Math.floor((p.pick_no - 1) / TEAMS) + 1
        if (pl.pos === 'K' && kRd === null) kRd = rd
        if (pl.pos === 'DEF' && dRd === null) dRd = rd
        if (pl.adp != null && pl.pos !== 'K' && pl.pos !== 'DEF') {
          const reach = pl.adp - p.pick_no
          if (reach > worst) worst = reach
        }
      })
      const probs = []
      if ((cnt.QB || 0) > 2) probs.push(`${cnt.QB} QB`)
      if ((cnt.TE || 0) > 2) probs.push(`${cnt.TE} TE`)
      if ((cnt.K || 0) !== 1) probs.push(`${cnt.K || 0} K`)
      if ((cnt.DEF || 0) !== 1) probs.push(`${cnt.DEF || 0} DEF`)
      if (!(cnt.QB >= 1)) probs.push('no QB')
      if (!(cnt.TE >= 1)) probs.push('no TE')
      if ((cnt.RB || 0) < 3) probs.push(`only ${cnt.RB || 0} RB`)
      if ((cnt.WR || 0) < 3) probs.push(`only ${cnt.WR || 0} WR`)
      if (kRd !== null && kRd < ROUNDS - 2) probs.push(`K rd${kRd}`)
      if (dRd !== null && dRd < ROUNDS - 2) probs.push(`DEF rd${dRd}`)
      if (worst > 20) probs.push(`reach ${worst.toFixed(0)}`)
      if (probs.length) allGood = false
      console.log(`   ${String(t.draft_slot).padStart(4)}  ${String(cnt.RB||0).padStart(2)} ${String(cnt.WR||0).padStart(2)} ${String(cnt.QB||0).padStart(2)} ${String(cnt.TE||0).padStart(2)} ${String(cnt.K||0).padStart(2)} ${String(cnt.DEF||0).padStart(3)}   ${String(kRd).padStart(4)} ${String(dRd).padStart(6)}  ${worst.toFixed(0).padStart(11)}  ${probs.length ? probs.join(', ') : 'ok'}`)
    }
    ok('EVERY slot produced an acceptable roster', allGood)

    // lineups exist for every team
    let lineupsOk = true
    for (const t of res.teams) {
      const l = await sel(`lineups?team_id=eq.${t.id}&week=eq.1&select=slot`)
      const st = l.filter(x => x.slot !== 'BN').map(x => x.slot)
      if (l.length !== ROUNDS || !st.includes('K') || !st.includes('DEF') || !st.includes('QB')) lineupsOk = false
    }
    ok('every team got a full valid week-1 lineup', lineupsOk)
    const mus = await sel(`matchups?league_id=eq.${res.L}&select=week`)
    ok('14-week schedule generated', new Set(mus.map(m => m.week)).size === 14)
    await rpc('delete_league', { p_league_id: res.L })
  }
}

/* ============ 2. a sweep of league sizes ============ */
console.log('\n=== other league shapes ===')
for (const [TEAMS, ROUNDS] of [[4, 15], [8, 15], [10, 15], [14, 15], [16, 15], [12, 15]]) {
  const res = await runLeague(TEAMS, ROUNDS)
  if (res.err) { ok(`${TEAMS} teams x ${ROUNDS} rounds`, false, res.err); continue }
  let bad = []
  for (const t of res.teams) {
    const mine = res.picks.filter(p => p.team_id === t.id)
    const cnt = {}
    mine.forEach(p => { const pl = byId.get(p.player_id); if (pl) cnt[pl.pos] = (cnt[pl.pos] || 0) + 1 })
    if ((cnt.QB || 0) > 2 || (cnt.TE || 0) > 2 || (cnt.K || 0) !== 1 || (cnt.DEF || 0) !== 1
        || !(cnt.QB >= 1) || !(cnt.TE >= 1)) {
      bad.push(`slot${t.draft_slot}:${JSON.stringify(cnt)}`)
    }
  }
  ok(`${TEAMS} teams x ${ROUNDS} rounds — all ${res.teams.length} rosters valid`,
     res.status === 'complete' && bad.length === 0,
     bad.slice(0, 2).join(' '))
  await rpc('delete_league', { p_league_id: res.L })
}

console.log(`\n${'='.repeat(52)}\n${pass} passed, ${fail} failed\n${'='.repeat(52)}`)
process.exit(fail ? 1 : 0)
