// Snake-draft math. Mirrors slot_for_pick() in the database exactly.
// The database is the authority; this exists for display only.

export function slotForPick(pick, teams) {
  const round = Math.floor((pick - 1) / teams)
  const idx = (pick - 1) % teams
  return round % 2 === 0 ? idx + 1 : teams - idx
}

export function roundOfPick(pick, teams) {
  return Math.floor((pick - 1) / teams) + 1
}

export function pickInRound(pick, teams) {
  return ((pick - 1) % teams) + 1
}

// All overall pick numbers belonging to a draft slot.
export function picksForSlot(slot, teams, rounds) {
  const out = []
  for (let p = 1; p <= teams * rounds; p++) {
    if (slotForPick(p, teams) === slot) out.push(p)
  }
  return out
}
