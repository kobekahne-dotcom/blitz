/* End-to-end proof of the LIVE path.

   Take a real NFL week, pull ESPN's box scores exactly the way the app
   will on a Sunday, run them through the same engine, and compare every
   player against the points Sleeper independently computed for that week.

   If this matches, the only thing standing between here and live scoring
   is games being played. */
import fs from 'fs'
import { scorePlayer, SLEEPER_PPR } from '../src/scoring.js'
import { fetchLiveWeek, fromSleeperWeek } from '../src/live.js'

const SEASON = 2025, WEEK = Number(process.argv[2] || 1)
console.log(`replaying ${SEASON} week ${WEEK} through the live path\n`)

const t0 = Date.now()
const { raw, gameByTeam, games, finals } = await fetchLiveWeek(SEASON, WEEK)
const stats = raw
console.log(`${games} games, ${finals} final, ${Object.keys(stats).length} stat lines in ${Math.round((Date.now() - t0) / 1000)}s`)

// what Sleeper says those same players scored that week
const truth = await (await fetch(`https://api.sleeper.app/v1/stats/nfl/regular/${SEASON}/${WEEK}`)).json()
const players = JSON.parse(fs.readFileSync('public/players-lite.json', 'utf8'))

let exact = 0, close = 0, n = 0
const byPos = {}
const misses = []

for (const [sid, line] of Object.entries(stats)) {
  const p = players[sid]
  if (!p) continue
  const real = truth[sid]?.pts_ppr
  if (real == null) continue
  if (p.pos === 'DEF') continue            // scored from a different feed, checked separately
  const mine = scorePlayer(fromSleeperWeek(line, p.pos), SLEEPER_PPR, p.pos)
  const d = Math.round((mine - real) * 100) / 100
  n++
  byPos[p.pos] = byPos[p.pos] || { n: 0, ok: 0, worst: 0 }
  const b = byPos[p.pos]; b.n++
  if (Math.abs(d) < 0.005) { exact++; b.ok++ }
  if (Math.abs(d) < 0.5) close++
  if (Math.abs(d) > Math.abs(b.worst)) b.worst = d
  if (Math.abs(d) >= 0.5) misses.push({ name: p.name, pos: p.pos, mine, real, d, line })
}

console.log('\npos    n    exact       worst')
for (const [pos, b] of Object.entries(byPos).sort((a, z) => z[1].n - a[1].n)) {
  console.log(`${pos.padEnd(5)} ${String(b.n).padStart(3)}  ${String(b.ok).padStart(3)} (${String(Math.round(b.ok / b.n * 100)).padStart(3)}%)   ${b.worst > 0 ? '+' : ''}${b.worst}`)
}
console.log(`\nEXACT: ${exact}/${n} = ${Math.round(exact / n * 100)}%   within 0.5: ${Math.round(close / n * 100)}%`)

misses.sort((a, z) => Math.abs(z.d) - Math.abs(a.d))
if (misses.length) {
  console.log(`\n${misses.length} off by 0.5+. Worst 10:`)
  for (const m of misses.slice(0, 10)) {
    const kk = Object.entries(m.line).filter(([k, v]) => typeof v === 'number' && v)
      .map(([k, v]) => `${k} ${v}`).join(' ')
    console.log(`  ${m.name.padEnd(22)} ${m.pos}  mine ${String(m.mine).padStart(6)}  real ${String(m.real).padStart(6)}  ${m.d > 0 ? '+' : ''}${m.d}`)
    console.log(`     ${kk}`)
  }
}

console.log('\n=== team defenses ===')
/* Sleeper's DEF total in this feed EXCLUDES points allowed — verified by
   hand: NO = 5 sacks + 1 blocked kick x2 = 7; CIN = 2 sacks + 2 INTs = 6;
   CLE = 3 sacks = 3, none with a points-allowed component. Comparing
   totals would be meaningless, so check the COMPONENTS we read from ESPN
   against Sleeper's raw counts instead. */
let dn = 0, dsack = 0, dint = 0
const dbad = []
for (const [sid, line] of Object.entries(stats)) {
  const p = players[sid]
  if (!p || p.pos !== 'DEF') continue
  const t = truth[sid]
  if (!t) continue
  dn++
  const d = fromSleeperWeek(line, 'DEF')
  if (Math.abs(d.sack - (t.sack || 0)) < 0.26) dsack++
  else dbad.push(sid + " sack " + d.sack + " vs " + (t.sack || 0))
  if (d.def_int === (t.int || 0)) dint++
  else dbad.push(sid + " int " + d.def_int + " vs " + (t.int || 0))
}
console.log("  sacks match     " + dsack + "/" + dn)
console.log("  interceptions   " + dint + "/" + dn)
console.log("  points allowed  taken straight from the final score")
if (dbad.length) console.log("  mismatches:", dbad.slice(0, 6).join(" | "))
const dOk = dn > 20 && dsack / dn > 0.9 && dint / dn > 0.9
console.log("  components " + (dOk ? "VERIFIED" : "FAILED"))

console.log('\n=== game clock reaches the UI ===')
const sample = Object.entries(gameByTeam).slice(0, 4)
for (const [team, g] of sample) console.log(`  ${team.padEnd(4)} ${g.state.padEnd(5)} ${g.detail}`)

const pass = n > 100 && exact / n > 0.95 && dOk
console.log(`\n${'='.repeat(52)}`)
console.log(pass ? 'PASS — the live path reproduces a real week.' : 'FAIL')
console.log('='.repeat(52))
process.exit(pass ? 0 : 1)
