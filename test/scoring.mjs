/* Prove the scoring engine against a season somebody else already scored.
   Every 2025 stat line in the database carries Sleeper's own pts_ppr.
   Feed the same raw line to our engine with Sleeper's scoring rules; if
   the engine is right the two numbers are the same. This is the test that
   has to pass before anyone trusts a live score on a Sunday. */

import { scorePlayer, fromSleeperSeason, SLEEPER_PPR } from '../src/scoring.js'

const API = 'https://yrgbnyoqyurtrisgbvai.supabase.co'
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlyZ2JueW9xeXVydHJpc2didmFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzNzY0MTEsImV4cCI6MjEwMTk1MjQxMX0.ZXfDJtOX0s5avbBfPMMDZuBU2s3KG7pWgJnbWcwgrf4'

const s = await (await fetch(`${API}/auth/v1/signup`, {
  method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: '{}' })).json()
const H = { apikey: ANON, Authorization: 'Bearer ' + s.access_token }

const players = new Map()
for (let from = 0; ; from += 1000) {
  const r = await fetch(`${API}/rest/v1/players?select=id,name,pos&limit=1000&offset=${from}`, { headers: H })
  const d = await r.json()
  d.forEach(p => players.set(p.id, p))
  if (d.length < 1000) break
}

const rows = []
for (let from = 0; ; from += 1000) {
  const r = await fetch(`${API}/rest/v1/player_seasons?season=eq.2025&select=player_id,stats&limit=1000&offset=${from}`, { headers: H })
  const d = await r.json()
  rows.push(...d)
  if (d.length < 1000) break
}
console.log(`2025 season lines: ${rows.length}\n`)

const byPos = {}
const misses = []
let scored = 0

for (const row of rows) {
  const st = row.stats || {}
  if (st.dnp) continue
  const actual = st.pts_ppr
  if (actual == null) continue
  const p = players.get(row.player_id)
  const pos = p?.pos || '?'
  if (pos === 'DEF') continue          // team defense is scored from a different feed

  const mine = scorePlayer(fromSleeperSeason(st), SLEEPER_PPR, pos)
  const diff = Math.round((mine - actual) * 100) / 100
  scored++
  byPos[pos] = byPos[pos] || { n: 0, exact: 0, close: 0, worst: 0 }
  const b = byPos[pos]
  b.n++
  if (Math.abs(diff) < 0.005) b.exact++
  if (Math.abs(diff) < 0.5) b.close++
  if (Math.abs(diff) > Math.abs(b.worst)) b.worst = diff
  if (Math.abs(diff) >= 0.5) misses.push({ name: p?.name || row.player_id, pos, mine, actual, diff, st })
}

console.log('pos    n     exact      within 0.5     worst gap')
let totExact = 0, totN = 0
for (const [pos, b] of Object.entries(byPos).sort((a, z) => z[1].n - a[1].n)) {
  totExact += b.exact; totN += b.n
  console.log(`${pos.padEnd(5)} ${String(b.n).padStart(4)}  ` +
    `${String(b.exact).padStart(4)} (${String(Math.round(b.exact / b.n * 100)).padStart(3)}%)  ` +
    `${String(b.close).padStart(4)} (${String(Math.round(b.close / b.n * 100)).padStart(3)}%)  ` +
    `${b.worst > 0 ? '+' : ''}${b.worst}`)
}
console.log(`\nEXACT TO THE PENNY: ${totExact}/${totN} = ${Math.round(totExact / totN * 100)}%`)

misses.sort((a, z) => Math.abs(z.diff) - Math.abs(a.diff))
if (misses.length) {
  console.log(`\n${misses.length} lines off by 0.5 or more. The 8 worst:`)
  for (const m of misses.slice(0, 8)) {
    const k = ['pass_yd', 'pass_td', 'pass_int', 'rush_yd', 'rush_td', 'rec', 'rec_yd', 'rec_td', 'fum_lost']
      .filter(x => m.st[x]).map(x => `${x} ${m.st[x]}`).join(' ')
    console.log(`  ${m.name.padEnd(22)} ${m.pos}  mine ${String(m.mine).padStart(7)}  real ${String(m.actual).padStart(7)}  ` +
      `gap ${m.diff > 0 ? '+' : ''}${m.diff}`)
    console.log(`     ${k}`)
  }
}

/* a settings change must move the number in the right direction */
console.log('\n=== the settings actually drive it ===')
const lamb = rows.find(r => players.get(r.player_id)?.name === 'CeeDee Lamb')
if (lamb) {
  const line = fromSleeperSeason(lamb.stats)
  const ppr = scorePlayer(line, SLEEPER_PPR, 'WR')
  const half = scorePlayer(line, { ...SLEEPER_PPR, receiving: { ...SLEEPER_PPR.receiving, REC: 0.5 } }, 'WR')
  const std = scorePlayer(line, { ...SLEEPER_PPR, receiving: { ...SLEEPER_PPR.receiving, REC: 0 } }, 'WR')
  const recs = lamb.stats.rec
  console.log(`  CeeDee Lamb, ${recs} catches`)
  console.log(`    full PPR ${ppr}   half ${half}   standard ${std}`)
  const dropHalf = Math.round((ppr - half) * 100) / 100
  const dropStd = Math.round((ppr - std) * 100) / 100
  console.log(`    half costs ${dropHalf} (expect ${recs * 0.5}) — ${dropHalf === recs * 0.5 ? 'OK' : 'WRONG'}`)
  console.log(`    std  costs ${dropStd} (expect ${recs}) — ${dropStd === recs ? 'OK' : 'WRONG'}`)
}

const ok = totExact / totN > 0.97
console.log(`\n${'='.repeat(52)}`)
console.log(ok ? 'PASS — the engine reproduces a real season.' : 'FAIL — engine does not match reality.')
console.log('='.repeat(52))
process.exit(ok ? 0 : 1)
