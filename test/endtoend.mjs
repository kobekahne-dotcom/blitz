/* Full post-patch-7 proof: mock draft -> picks land -> roster lock fires
   -> draft completes -> schedule generates -> lineup autofills. */

const API = 'https://yrgbnyoqyurtrisgbvai.supabase.co'
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlyZ2JueW9xeXVydHJpc2didmFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzNzY0MTEsImV4cCI6MjEwMTk1MjQxMX0.ZXfDJtOX0s5avbBfPMMDZuBU2s3KG7pWgJnbWcwgrf4'

let pass = 0, fail = 0
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)) }

const su = async () => {
  const r = await fetch(`${API}/auth/v1/signup`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: '{}' })
  const d = await r.json()
  if (!d.access_token) throw new Error(JSON.stringify(d))
  return d.access_token
}
let TOK
const H = () => ({ apikey: ANON, Authorization: 'Bearer ' + TOK, 'Content-Type': 'application/json' })
const rpc = async (f, a) => {
  const r = await fetch(`${API}/rest/v1/rpc/${f}`, { method: 'POST', headers: H(), body: JSON.stringify(a) })
  const t = await r.text(); let b; try { b = JSON.parse(t) } catch { b = t }
  return { ok: r.ok, body: b }
}
const sel = async p => (await fetch(`${API}/rest/v1/${p}`, { headers: H() })).json()
const em = r => (r.body && r.body.message) || JSON.stringify(r.body)
const slotFor = (pick, n) => { const r = Math.floor((pick - 1) / n), i = (pick - 1) % n; return r % 2 === 0 ? i + 1 : n - i }

TOK = await su()

const TEAMS = 4, ROUNDS = 9, TOTAL = TEAMS * ROUNDS
console.log(`\n=== mock draft: ${TEAMS} teams x ${ROUNDS} rounds = ${TOTAL} picks ===`)

const mk = await rpc('create_mock_draft', {
  p_num_teams: TEAMS, p_rounds: ROUNDS, p_scoring: 'ppr',
  p_pick_seconds: 600, p_my_slot: 1, p_team_name: 'My Team' })
ok('mock league created', mk.ok, em(mk))
if (!mk.ok) process.exit(1)
const L = mk.body.league_id

const teams = await sel(`teams?league_id=eq.${L}&select=*`)
const draft = (await sel(`drafts?league_id=eq.${L}&select=*`))[0]
const pool = await sel('players?select=id,name,pos&order=adp.asc&limit=300')
const mine = teams.find(t => t.draft_slot === 1)
ok('4 teams created with unique slots', teams.length === 4 && new Set(teams.map(t => t.draft_slot)).size === 4)
ok('draft starts active at pick 1', draft.status === 'active' && draft.current_pick === 1)

// first pick must simply work — this is what was broken
const first = await rpc('make_pick', { p_draft_id: draft.id, p_team_id: mine.id, p_player_id: pool[0].id })
ok('FIRST PICK SUCCEEDS (the patch-5 regression)', first.ok, em(first))

const taken = new Set([pool[0].id])
let lockMsg = null, err = null
for (let pick = 2; pick <= TOTAL; pick++) {
  const t = teams.find(x => x.draft_slot === slotFor(pick, TEAMS))
  let done = false
  for (const c of pool) {
    if (taken.has(c.id)) continue
    const r = await rpc('make_pick', { p_draft_id: draft.id, p_team_id: t.id, p_player_id: c.id })
    if (r.ok) { taken.add(c.id); done = true; break }
    const m = em(r)
    if (/still need|Take one/i.test(m)) { if (!lockMsg) lockMsg = `pick ${pick}: ${m}`; continue }
    if (/already drafted/i.test(m)) continue
    err = `pick ${pick}: ${m}`; break
  }
  if (err) break
  if (!done) { err = `pick ${pick} could not be filled`; break }
}
ok('all remaining picks succeeded', !err, err || '')

const after = (await sel(`drafts?id=eq.${draft.id}&select=status,current_pick`))[0]
const picks = await sel(`picks?draft_id=eq.${draft.id}&select=pick_no,team_id,player_id&order=pick_no`)
ok(`${TOTAL} picks stored`, picks.length === TOTAL, `${picks.length}`)
ok('pick numbers 1..N with no gaps', picks.every((p, i) => p.pick_no === i + 1))
ok('draft marked complete', after.status === 'complete', after.status)

console.log('\n=== roster rule ===')
ok('roster lock fired at least once', !!lockMsg, 'never triggered')
if (lockMsg) console.log('     ', lockMsg)
const myRoster = picks.filter(p => p.team_id === mine.id).map(p => pool.find(x => x.id === p.player_id)).filter(Boolean)
const cnt = {}; myRoster.forEach(p => cnt[p.pos] = (cnt[p.pos] || 0) + 1)
console.log('      my roster:', JSON.stringify(cnt))
ok('I was forced to end up with a kicker', (cnt.K || 0) >= 1, JSON.stringify(cnt))
ok('I was forced to end up with a defense', (cnt.DEF || 0) >= 1, JSON.stringify(cnt))

console.log('\n=== after the draft ===')
const mus = await sel(`matchups?league_id=eq.${L}&select=week,home_team_id,away_team_id`)
ok('schedule generated', mus.length > 0, `${mus.length} rows`)
ok('14 weeks scheduled', new Set(mus.map(m => m.week)).size === 14, `${new Set(mus.map(m => m.week)).size}`)
const wk1 = mus.filter(m => m.week === 1)
ok('week 1 pairs every team', wk1.length === TEAMS / 2, `${wk1.length} matchups`)

const lu = await sel(`lineups?team_id=eq.${mine.id}&week=eq.1&select=slot,player_id`)
ok('lineup autofilled for week 1', lu.length === ROUNDS, `${lu.length} of ${ROUNDS}`)
const starters = lu.filter(x => x.slot !== 'BN').map(x => x.slot).sort()
console.log('      starters:', starters.join(', '))
console.log('      bench   :', lu.filter(x => x.slot === 'BN').length)
ok('starting lineup has a QB', starters.includes('QB'))
ok('starting lineup has a K', starters.includes('K'))
ok('starting lineup has a DEF', starters.includes('DEF'))
ok('starting lineup has a FLEX', starters.includes('FLEX'))

console.log(`\n${'='.repeat(46)}\n${pass} passed, ${fail} failed\n${'='.repeat(46)}`)
console.log('league:', L)
process.exit(fail ? 1 : 0)
