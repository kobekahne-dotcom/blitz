/* ============================================================
   Live scoring.

   Reads Sleeper's public stat feed: two requests for a whole week, no
   API key, and the lines come back keyed by the same player ids the app
   already uses — so there is no id mapping that can drift.

   ESPN was the first choice and had to be abandoned. Its box scores are
   richer, but BROWSERS CANNOT REACH IT: a plain curl gets 200 while the
   CORS preflight returns 403, so every fetch from a real page fails with
   "Failed to fetch". Verified from an actual browser rather than assumed
   — Sleeper and Supabase both answered from the same page that ESPN
   refused.

   Every client reads the same feed and runs the same deterministic
   engine, so all five managers see identical numbers with no server in
   the middle that can quietly die on a Sunday.
   ============================================================ */

const BASE = 'https://api.sleeper.app'

const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : 0

/* Sleeper omits a key entirely when its value is zero, so every read is a
   coalesce — never an assumption that a field is present. */
export function fromSleeperWeek(st, pos) {
  if (!st) return null

  if (pos === 'DEF') {
    return {
      sack: num(st.sack), def_int: num(st.int), fum_rec: num(st.fum_rec),
      def_td: num(st.td), safety: num(st.safe), blocked: num(st.blk_kick),
      pts_allowed: num(st.pts_allow),
    }
  }

  // Field-goal buckets: the short ones are usually absent, so derive them
  // from the total instead of reporting a kicker who made nothing.
  const mid = num(st.fgm_40_49)
  const long = num(st.fgm_50p) || (num(st.fgm_50_59) + num(st.fgm_60p))
  const short = (st.fgm_0_19 != null || st.fgm_20_29 != null || st.fgm_30_39 != null)
    ? num(st.fgm_0_19) + num(st.fgm_20_29) + num(st.fgm_30_39)
    : Math.max(0, num(st.fgm) - mid - long)

  return {
    pass_yd: num(st.pass_yd), pass_td: num(st.pass_td), pass_int: num(st.pass_int),
    pass_2pt: num(st.pass_2pt),
    rush_yd: num(st.rush_yd), rush_td: num(st.rush_td), rush_2pt: num(st.rush_2pt),
    rec: num(st.rec), rec_yd: num(st.rec_yd), rec_td: num(st.rec_td), rec_2pt: num(st.rec_2pt),
    fum_lost: num(st.fum_lost), fum_td: num(st.fum_rec_td),
    ret_td: num(st.st_td), st_ff: num(st.st_ff), st_fum_rec: num(st.st_fum_rec),
    pat: num(st.xpm), pat_miss: num(st.xpmiss),
    fg_0_39: short, fg_40_49: mid, fg_50: long, fg_miss: num(st.fgmiss),
  }
}

/* the schedule is one file for the whole season — fetch it once */
const schedCache = new Map()
async function schedule(season) {
  if (schedCache.has(season)) return schedCache.get(season)
  const r = await fetch(`${BASE}/schedule/nfl/regular/${season}`)
  const j = r.ok ? await r.json() : []
  schedCache.set(season, j)
  return j
}

const LABEL = {
  complete: 'Final', in_game: 'In progress', pre_game: '',
  postponed: 'Postponed', canceled: 'Canceled',
}

/* Quarter label the way a scoreboard says it. */
const QLABEL = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', F: 'Final' }

/* One week: every player's raw line plus each team's live game state —
   quarter, clock, score, and crucially WHO HAS THE BALL, which is what
   lets a player read as on the field rather than on the sideline. */
export async function fetchLiveWeek(season, week) {
  const [statsRes, scoresRes, sched] = await Promise.all([
    fetch(`${BASE}/v1/stats/nfl/regular/${season}/${week}`),
    fetch(`${BASE}/scores/nfl/regular/${season}/${week}`),
    schedule(season),
  ])
  const raw = statsRes.ok ? await statsRes.json() : {}
  const scores = scoresRes.ok ? await scoresRes.json() : []

  // live detail, keyed by team
  const detailByTeam = {}
  for (const g of scores) {
    const m = g.metadata || {}
    const inPlay = !!m.is_in_progress
    const over = !!m.is_over
    const q = m.quarter_num || m.quarter
    const clock = m.time_remaining || ''
    const label = over ? 'Final'
        : inPlay ? `${QLABEL[q] || ('Q' + q)}${clock ? ' ' + clock : ''}`
        : ''
    for (const side of ['home', 'away']) {
      const team = m[side + '_team']
      if (!team) continue
      const opp = m[(side === 'home' ? 'away' : 'home') + '_team']
      detailByTeam[team] = {
        inPlay, over, label,
        quarter: q, clock,
        score: m[side + '_score'], oppScore: m[(side === 'home' ? 'away' : 'home') + '_score'],
        opp, home: side === 'home',
        // possession is the team abbreviation with the ball, blank between plays
        hasBall: !!m.possession && m.possession === team,
        possession: m.possession || '',
        downDistance: m.down_and_distance || '',
      }
    }
  }

  const gameByTeam = {}
  let live = 0, finals = 0, games = 0
  for (const g of sched) {
    if (g.week !== week) continue
    games++
    if (g.status === 'complete') finals++
    else if (g.status === 'in_game') live++
    const base = {
      state: g.status === 'complete' ? 'post' : g.status === 'in_game' ? 'in' : 'pre',
      done: g.status === 'complete',
      detail: LABEL[g.status] ?? g.status,
      date: g.date,
    }
    for (const [team, opp, home] of [[g.home, g.away, true], [g.away, g.home, false]]) {
      if (!team) continue
      const d = detailByTeam[team]
      gameByTeam[team] = {
        ...base, opp, home,
        // the live feed knows more than the schedule does — prefer it
        detail: (d && d.label) || base.detail,
        hasBall: !!(d && d.hasBall),
        possession: d?.possession || '',
        downDistance: d?.downDistance || '',
        score: d?.score, oppScore: d?.oppScore,
        inPlay: !!(d && d.inPlay),
      }
    }
  }

  return { raw, gameByTeam, live, finals, games }
}

/* Which week the NFL is actually on, straight from the source — never
   guessed from today's date, which breaks whenever a week runs long. */
export async function currentWeek() {
  try {
    const s = await (await fetch(`${BASE}/v1/state/nfl`)).json()
    return {
      season: Number(s.season),
      week: Number(s.week),
      type: s.season_type,
      regular: s.season_type === 'regular',
    }
  } catch { return { season: null, week: null, type: null, regular: false } }
}
