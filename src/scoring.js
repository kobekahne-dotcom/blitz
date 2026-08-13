/* ============================================================
   The scoring engine.

   One pure function. Same stat line + same settings = same number,
   on every phone in the league, every time. That is what lets the
   live view be computed on each client without five people arguing
   about whose score is right.

   Every value comes from the league's own settings tree (the 101
   settings on the League Info screen), never a hardcoded rule.
   ============================================================ */

const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : 0

/* Bonuses fire when a threshold is crossed. Real apps do not stack them
   (a 410-yard game pays the 400 bonus, not 300 + 400), so neither do we. */
const bonus = (yards, tiers) => {
  let best = 0
  for (const [min, pts] of tiers) if (yards >= min && pts) best = pts
  return best
}

/* stats: the normalised line below. scoring: league_settings().scoring */
export function scorePlayer(stats, scoring, pos) {
  if (!stats || !scoring) return 0
  const s = stats
  const P = scoring.passing || {}, R = scoring.rushing || {}
  const C = scoring.receiving || {}, K = scoring.kicking || {}
  const M = scoring.misc || {}, D = scoring.dst || {}
  let pts = 0

  if (pos === 'DEF') {
    pts += num(s.sack) * num(D.SK)
    pts += num(s.def_int) * num(D.INT)
    pts += num(s.fum_rec) * num(D.FR)
    pts += num(s.safety) * num(D.SF)
    pts += num(s.blocked) * num(D.BLK)
    pts += (num(s.def_td) + num(s.kr_td) + num(s.pr_td)) * num(D.DTD)
    const pa = num(s.pts_allowed)
    const cut = D.PA_TIERS || [0, 6, 13, 17, 27, 34, 45]   // ESPN's boundaries
    const keys = ['PA0', 'PA1', 'PA7', 'PA14', 'PA18', 'PA28', 'PA35']
    let hit = 'PA46'
    for (let i = 0; i < cut.length; i++) if (pa <= cut[i]) { hit = keys[i]; break }
    pts += num(D[hit])
    return Math.round(pts * 100) / 100
  }

  // passing — PY25 is "points per 25 yards", so it is per-yard / 25
  pts += num(s.pass_yd) / 25 * num(P.PY25)
  pts += num(s.pass_td) * num(P.PTD)
  pts += num(s.pass_int) * num(P.INT)
  pts += num(s.pass_2pt) * num(P.P2C)
  pts += bonus(num(s.pass_yd), [[300, num(P.PY300)], [400, num(P.PY400)]])

  // rushing
  pts += num(s.rush_yd) / 10 * num(R.RY10)
  pts += num(s.rush_td) * num(R.RTD)
  pts += num(s.rush_2pt) * num(R.R2C)
  pts += bonus(num(s.rush_yd), [[100, num(R.RY100)], [200, num(R.RY200)]])

  // receiving
  pts += num(s.rec_yd) / 10 * num(C.REY10)
  pts += num(s.rec) * num(C.REC)
  pts += num(s.rec_td) * num(C.RETD)
  pts += num(s.rec_2pt) * num(C.RE2C)
  pts += bonus(num(s.rec_yd), [[100, num(C.REY100)], [200, num(C.REY200)]])

  // kicking — distance buckets, and misses only count if the league says so
  pts += num(s.pat) * num(K.PAT)
  pts += num(s.pat_miss) * num(K.PATM)
  pts += num(s.fg_0_39) * num(K.FG0)
  pts += num(s.fg_40_49) * num(K.FG40)
  pts += num(s.fg_50) * num(K.FG50)
  pts += num(s.fg_miss) * num(K.FGM)

  // everything else
  pts += num(s.fum_lost) * num(M.FUML)
  pts += num(s.fum_td) * num(M.FTD)
  pts += num(s.kr_td) * num(M.KRTD)
  pts += num(s.pr_td) * num(M.PRTD)
  // Sleeper's season feed reports one combined special-teams TD instead of
  // splitting kick from punt. Live from ESPN they ARE split and use the two
  // settings above; here the kick-return rate is applied to both.
  pts += num(s.ret_td) * num(M.KRTD)
  // Special-teams forced fumbles and recoveries. Sleeper's default rules
  // pay an offensive player for these; ESPN's do not, so this only fires
  // when a league actually sets a value for it.
  pts += num(s.st_ff) * num(M.STFF)
  pts += num(s.st_fum_rec) * num(M.STFR)

  return Math.round(pts * 100) / 100
}

/* ---------- ESPN box score -> the normalised line ----------
   ESPN gives each category as parallel `labels` and `stats` arrays, so
   read by label rather than by position; the order is not promised. */
const pick = (labels, stats, label) => {
  const i = (labels || []).indexOf(label)
  return i < 0 ? null : (stats || [])[i]
}
const int = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0 }

export function fromEspnBox(categories) {
  const out = {
    pass_yd: 0, pass_td: 0, pass_int: 0, rush_yd: 0, rush_td: 0,
    rec: 0, rec_yd: 0, rec_td: 0, fum_lost: 0, kr_td: 0, pr_td: 0,
    pat: 0, pat_miss: 0, fg_0_39: 0, fg_40_49: 0, fg_50: 0, fg_miss: 0,
  }
  for (const c of categories || []) {
    const L = c.labels, v = c.stats
    if (c.name === 'passing') {
      out.pass_yd += int(pick(L, v, 'YDS')); out.pass_td += int(pick(L, v, 'TD'))
      out.pass_int += int(pick(L, v, 'INT'))
    } else if (c.name === 'rushing') {
      out.rush_yd += int(pick(L, v, 'YDS')); out.rush_td += int(pick(L, v, 'TD'))
    } else if (c.name === 'receiving') {
      out.rec += int(pick(L, v, 'REC')); out.rec_yd += int(pick(L, v, 'YDS'))
      out.rec_td += int(pick(L, v, 'TD'))
    } else if (c.name === 'fumbles') {
      out.fum_lost += int(pick(L, v, 'LOST'))
    } else if (c.name === 'kickReturns') {
      out.kr_td += int(pick(L, v, 'TD'))
    } else if (c.name === 'puntReturns') {
      out.pr_td += int(pick(L, v, 'TD'))
    } else if (c.name === 'kicking') {
      // "2/3" made/attempted — the miss count is the difference
      const fg = String(pick(L, v, 'FG') || '0/0').split('/')
      const xp = String(pick(L, v, 'XP') || '0/0').split('/')
      out.fg_made = int(fg[0]); out.fg_att = int(fg[1])
      out.fg_miss += Math.max(0, int(fg[1]) - int(fg[0]))
      out.pat += int(xp[0])
      out.pat_miss += Math.max(0, int(xp[1]) - int(xp[0]))
      // ESPN's box score does NOT break made kicks out by distance, only
      // LONG. Distance buckets need play-by-play; until that is wired the
      // made kicks are counted at the 0-39 rate and flagged, never guessed
      // into a higher bucket.
      out.fg_0_39 += int(fg[0])
      out.fg_distance_unknown = true
    }
  }
  return out
}

/* Sleeper's own season blob uses different key names. */
export function fromSleeperSeason(st) {
  if (!st) return null
  return {
    pass_yd: num(st.pass_yd), pass_td: num(st.pass_td), pass_int: num(st.pass_int),
    pass_2pt: num(st.pass_2pt),
    rush_yd: num(st.rush_yd), rush_td: num(st.rush_td), rush_2pt: num(st.rush_2pt),
    rec: num(st.rec), rec_yd: num(st.rec_yd), rec_td: num(st.rec_td), rec_2pt: num(st.rec_2pt),
    fum_lost: num(st.fum_lost),
    pat: num(st.xpm), pat_miss: num(st.xpmiss),
    // fgm_50p is already the TOTAL of 50-59 and 60+; adding those separately
    // would count the long ones twice
    fg_0_39: num(st.fgm_0_19) + num(st.fgm_20_29) + num(st.fgm_30_39),
    fg_40_49: num(st.fgm_40_49), fg_50: num(st.fgm_50p),
    fg_miss: num(st.fgmiss),
    ret_td: num(st.st_td), fum_td: num(st.fum_rec_td),
    st_ff: num(st.st_ff), st_fum_rec: num(st.st_fum_rec),
  }
}

/* KNOWN RESIDUAL: one kicker in 33 lands a point off. Chris Boswell 2025
   had 1 blocked FG and 2 blocked extra points, and Sleeper's own feed is
   internally inconsistent about them (xpa 43 - xpm 42 = 1 miss, yet
   xp_blkd = 2). Blocked kicks are rare and the gap is a single point, so
   this is recorded rather than papered over with a fudge factor. */

/* The scoring most public stat feeds are computed with — used to VALIDATE
   the engine against numbers somebody else calculated, not as a default
   for anyone's league. */
export const SLEEPER_PPR = {
  passing:   { PY25: 1, PTD: 4, INT: -1, P2C: 2, PY300: 0, PY400: 0 },
  rushing:   { RY10: 1, RTD: 6, R2C: 2, RY100: 0, RY200: 0 },
  receiving: { REY10: 1, REC: 1, RETD: 6, RE2C: 2, REY100: 0, REY200: 0 },
  kicking:   { PAT: 1, PATM: -1, FG0: 3, FG40: 4, FG50: 5, FGM: -1 },
  misc:      { FTD: 6, FUML: -2, KRTD: 6, PRTD: 6, STFF: 1, STFR: 1 },
  dst:       { SK: 1, INT: 2, FR: 2, SF: 2, BLK: 2, DTD: 6,
               // Sleeper's own tiers, which differ from ESPN's at 14-20
               PA_TIERS: [0, 6, 13, 20, 27, 34, 45],
               PA0: 10, PA1: 7, PA7: 4, PA14: 1, PA18: 0, PA28: -1, PA35: -4, PA46: -4 },
}
