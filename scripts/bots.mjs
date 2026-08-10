/* BLITZ bots.
     node scripts/bots.mjs join <CODE> [count]   -> create bot managers and join
     node scripts/bots.mjs draft <CODE>          -> bots draft themselves, live
   Bots pick best-available-by-ADP but respect roster needs, with a human-ish delay.
*/

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const API = 'https://yrgbnyoqyurtrisgbvai.supabase.co'
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlyZ2JueW9xeXVydHJpc2didmFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzNzY0MTEsImV4cCI6MjEwMTk1MjQxMX0.ZXfDJtOX0s5avbBfPMMDZuBU2s3KG7pWgJnbWcwgrf4'
const STORE = join(dirname(fileURLToPath(import.meta.url)), 'bots.json')

const NAMES = [
  'Gridiron Goblins', 'Couch Commanders', 'Bye Week Bandits', 'Waiver Wire Wolves',
  'Sunday Scaries', 'Pylon Pirates', 'Hail Mary Hooligans', 'Red Zone Rejects',
  'Play Action Panic', 'Turf Toe Titans', 'Blitz Brigade', 'Third Down Trolls',
]

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function signUp() {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(`${API}/auth/v1/signup`, {
      method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: '{}',
    })
    const d = await r.json()
    if (d.access_token) return { token: d.access_token, refresh: d.refresh_token, uid: d.user.id }
    if (d.error_code === 'over_request_rate_limit') {
      console.log('   rate limited, waiting 15s…'); await sleep(15000); continue
    }
    throw new Error(JSON.stringify(d))
  }
  throw new Error('could not sign up after retries')
}

// Access tokens last ~1 hour. A real draft outlives that, so refresh on demand.
async function refresh(bot) {
  const r = await fetch(`${API}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: bot.refresh }),
  })
  const d = await r.json()
  if (!d.access_token) return false
  bot.token = d.access_token
  bot.refresh = d.refresh_token
  return true
}

const expired = tok => {
  try {
    const p = JSON.parse(Buffer.from(tok.split('.')[1], 'base64').toString())
    return (p.exp * 1000) - Date.now() < 120000   // refresh 2 min before expiry
  } catch { return true }
}

const H = tok => ({ apikey: ANON, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' })

async function rpc(tok, fn, args) {
  const r = await fetch(`${API}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: H(tok), body: JSON.stringify(args || {}),
  })
  const t = await r.text()
  let b; try { b = JSON.parse(t) } catch { b = t }
  return { ok: r.ok, body: b }
}
async function sel(tok, path) {
  const r = await fetch(`${API}/rest/v1/${path}`, { headers: H(tok) })
  return r.json()
}
const em = r => (r.body && r.body.message) || JSON.stringify(r.body)

const slotForPick = (pick, teams) => {
  const round = Math.floor((pick - 1) / teams), idx = (pick - 1) % teams
  return round % 2 === 0 ? idx + 1 : teams - idx
}

/* ---------------- join ---------------- */
async function joinBots(code, count) {
  const bots = existsSync(STORE) ? JSON.parse(readFileSync(STORE, 'utf8')) : {}
  bots[code] = bots[code] || []
  let added = 0, full = false

  for (let i = 0; i < count; i++) {
    const name = NAMES[(bots[code].length) % NAMES.length] +
      (bots[code].length >= NAMES.length ? ' ' + (bots[code].length + 1) : '')
    const u = await signUp()
    const j = await rpc(u.token, 'join_league', { p_join_code: code, p_team_name: name })
    if (!j.ok) {
      const msg = em(j)
      if (/full/i.test(msg)) { console.log(`   league is full — stopped at ${added} bots`); full = true; break }
      if (/already started/i.test(msg)) { console.log('   draft already started — cannot add bots'); full = true; break }
      console.log('   join failed:', msg); break
    }
    bots[code].push({ name, token: u.token, refresh: u.refresh, uid: u.uid, league_id: j.body.league_id })
    added++
    console.log(`   ✓ ${name}`)
  }
  writeFileSync(STORE, JSON.stringify(bots, null, 1))
  console.log(`\n${added} bot${added === 1 ? '' : 's'} joined.${full ? '' : ' Ready.'}`)
  if (added) {
    const any = bots[code][0]
    const teams = await sel(any.token, `teams?league_id=eq.${any.league_id}&select=name,claim_code`)
    console.log(`League now has ${teams.length} teams total.`)
  }
}

/* ---------------- draft ---------------- */
// rough roster targets so bots don't hoard one position
const CAP = { QB: 2, RB: 6, WR: 7, TE: 2, K: 1, DEF: 1 }
const LATE_ONLY = new Set(['K', 'DEF'])   // don't take these early

async function drive(code) {
  const store = JSON.parse(readFileSync(STORE, 'utf8'))
  const bots = store[code]
  if (!bots || !bots.length) { console.log('No bots for that code. Run `join` first.'); return }

  const lead = bots[0]
  const leagueId = lead.league_id
  const league = (await sel(lead.token, `leagues?id=eq.${leagueId}&select=*`))[0]
  const players = await sel(lead.token, 'players?select=id,name,team,pos,adp,ppr,half,std&limit=1000')
  const projKey = league.scoring === 'ppr' ? 'ppr' : league.scoring === 'half' ? 'half' : 'std'

  const byUid = new Map()
  for (const b of bots) {
    const t = (await sel(b.token, `teams?league_id=eq.${leagueId}&owner_uid=eq.${b.uid}&select=*`))[0]
    if (t) byUid.set(t.id, { ...b, team: t })
  }
  console.log(`Driving ${byUid.size} bots in "${league.name}" (${league.num_teams} teams, ${league.rounds} rounds).`)
  console.log('Bots will pick when it is their turn. Ctrl+C to stop.\n')

  let lastPick = 0
  const keepFresh = async () => {
    for (const b of [...byUid.values()]) {
      if (expired(b.token)) {
        const okRef = await refresh(b)
        if (okRef) { console.log(`   (refreshed login for ${b.team.name})`); store[code].find(x => x.uid === b.uid).token = b.token }
        else console.log(`   ! could not refresh ${b.team.name} — it may stop picking`)
      }
    }
    writeFileSync(STORE, JSON.stringify(store, null, 1))
  }

  for (;;) {
    await keepFresh()
    const draft = (await sel(lead.token, `drafts?league_id=eq.${leagueId}&select=*`))[0]
    if (!draft) { console.log('draft row vanished'); return }

    if (draft.status === 'complete') { console.log('\nDraft complete. Bots are done.'); return }
    if (draft.status !== 'active') { await sleep(2000); continue }

    const total = league.num_teams * league.rounds
    if (draft.current_pick > total) { await sleep(2000); continue }

    const slot = slotForPick(draft.current_pick, league.num_teams)
    const teams = await sel(lead.token, `teams?league_id=eq.${leagueId}&select=*`)
    const onClock = teams.find(t => t.draft_slot === slot)
    const bot = onClock && byUid.get(onClock.id)

    if (!bot) {                       // a human is on the clock
      if (draft.current_pick !== lastPick) {
        console.log(`   pick ${draft.current_pick}: waiting on ${onClock ? onClock.name : '?'} (human)`)
        lastPick = draft.current_pick
      }
      await sleep(2000); continue
    }

    // bot's turn — think for a beat, then pick
    const delay = 1500 + Math.random() * 3000
    await sleep(delay)

    // re-read in case a human/undo moved things while we "thought"
    const fresh = (await sel(lead.token, `drafts?league_id=eq.${leagueId}&select=*`))[0]
    if (fresh.current_pick !== draft.current_pick || fresh.status !== 'active') continue

    const picks = await sel(lead.token, `picks?draft_id=eq.${draft.id}&select=player_id,team_id`)
    const taken = new Set(picks.map(p => p.player_id))
    const mine = picks.filter(p => p.team_id === bot.team.id).map(p => p.player_id)
    const counts = {}
    for (const id of mine) {
      const pl = players.find(x => x.id === id)
      if (pl) counts[pl.pos] = (counts[pl.pos] || 0) + 1
    }
    const round = Math.floor((draft.current_pick - 1) / league.num_teams) + 1
    const lateRounds = round > league.rounds - 3

    const candidates = players
      .filter(p => !taken.has(p.id))
      .filter(p => (counts[p.pos] || 0) < (CAP[p.pos] ?? 99))
      .filter(p => lateRounds || !LATE_ONLY.has(p.pos))
      .sort((a, b) => {
        const aa = a.adp ?? 9999, bb = b.adp ?? 9999
        if (aa !== bb) return aa - bb
        return (b[projKey] ?? 0) - (a[projKey] ?? 0)
      })

    // small randomness so it isn't a robot: pick from the top 3
    const pool = candidates.slice(0, 3)
    const choice = pool[Math.floor(Math.random() * pool.length)] || candidates[0]
    if (!choice) { console.log('   no candidate left'); await sleep(2000); continue }

    const r = await rpc(bot.token, 'make_pick', {
      p_draft_id: draft.id, p_team_id: bot.team.id, p_player_id: choice.id,
    })
    if (r.ok) {
      console.log(`   pick ${draft.current_pick} (R${round}) — ${bot.team.name} took ${choice.name} ${choice.pos} ${choice.team || 'FA'}`)
      lastPick = draft.current_pick
      idle = 0
    } else {
      const msg = em(r)
      if (!/not your turn|already drafted/i.test(msg)) console.log('   pick failed:', msg)
      await sleep(800)
    }
  }
}

/* ---------------- cli ---------------- */
const [cmd, code, countArg] = process.argv.slice(2)
if (!cmd || !code) {
  console.log('usage:\n  node scripts/bots.mjs join <JOIN_CODE> [count]\n  node scripts/bots.mjs draft <JOIN_CODE>')
  process.exit(1)
}
if (cmd === 'join') await joinBots(code.toLowerCase().trim(), Number(countArg) || 10)
else if (cmd === 'draft') await drive(code.toLowerCase().trim())
else { console.log('unknown command:', cmd); process.exit(1) }
