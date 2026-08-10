import { slotForPick, roundOfPick, picksForSlot } from '../src/snake.js'

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra) }
}

console.log('=== snake math (must mirror the database exactly) ===')
ok('pick 13 in 12-team → slot 12', slotForPick(13, 12) === 12, slotForPick(13, 12))
ok('pick 25 in 12-team → slot 1', slotForPick(25, 12) === 1, slotForPick(25, 12))
ok('pick 1 → slot 1', slotForPick(1, 10) === 1)
ok('pick 10 in 10-team → slot 10', slotForPick(10, 10) === 10)
ok('pick 11 in 10-team → slot 10 (snake turn)', slotForPick(11, 10) === 10)
ok('pick 20 in 10-team → slot 1', slotForPick(20, 10) === 1)
ok('pick 21 in 10-team → slot 1 (double pick)', slotForPick(21, 10) === 1)
ok('round of pick 13 (12-team) = 2', roundOfPick(13, 12) === 2)

// exhaustive: every pick maps to exactly one slot, every slot gets exactly `rounds` picks
for (const [teams, rounds] of [[10, 16], [12, 15], [8, 14], [16, 20]]) {
  const counts = new Map()
  for (let p = 1; p <= teams * rounds; p++) {
    const s = slotForPick(p, teams)
    if (s < 1 || s > teams) { fail++; console.log(`  FAIL slot out of range: pick ${p} → ${s}`); break }
    counts.set(s, (counts.get(s) || 0) + 1)
  }
  ok(`${teams}x${rounds}: every slot drafts exactly ${rounds} times`,
    [...counts.values()].every(c => c === rounds) && counts.size === teams)
  ok(`${teams}x${rounds}: picksForSlot(1) has ${rounds} entries`,
    picksForSlot(1, teams, rounds).length === rounds)
}

// adjacency: at every snake turn the same slot picks twice in a row
for (const teams of [8, 10, 12]) {
  let good = true
  for (let r = 1; r < 6; r++) {
    const endOfRound = r * teams
    if (slotForPick(endOfRound, teams) !== slotForPick(endOfRound + 1, teams)) good = false
  }
  ok(`${teams}-team: snake turns give back-to-back picks`, good)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
