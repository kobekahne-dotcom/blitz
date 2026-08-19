import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase } from './supabase.js'
import LeagueInfo from './LeagueInfo.jsx'
import { useScrollLock } from './lockScroll.js'
import Trades from './Trades.jsx'
import { fetchLiveWeek, currentWeek, fromSleeperWeek } from './live.js'
import { scorePlayer } from './scoring.js'

const headshot = id => `https://sleepercdn.com/content/nfl/players/${id}.jpg`
const teamLogo = t => t ? `https://sleepercdn.com/images/team_logos/nfl/${t.toLowerCase()}.png` : null

/* Projections from Sleeper are FULL SEASON totals. A weekly lineup needs
   per-game numbers, so divide by that player's projected games played. */
const perGame = (p, key) => {
  if (!p) return null
  const season = p[key]
  if (season == null) return null
  const gp = (p.projd && p.projd.gp) || 17
  return Math.round((season / gp) * 10) / 10
}


/* Single-select position filters, with the combo slots a real fantasy app
   has. Tapping a chip SWITCHES to it — it never stacks with the last one. */
const POS_FILTERS = [
  { k: 'ALL',  label: 'ALL',   pos: null },
  { k: 'QB',   label: 'QB',    pos: ['QB'] },
  { k: 'RB',   label: 'RB',    pos: ['RB'] },
  { k: 'WR',   label: 'WR',    pos: ['WR'] },
  { k: 'TE',   label: 'TE',    pos: ['TE'] },
  { k: 'FLEX', label: 'FLEX',  pos: ['RB', 'WR'] },   // widened per-league if flex_te
  { k: 'K',    label: 'K',     pos: ['K'] },
  { k: 'DEF',  label: 'DEF',   pos: ['DEF'] },
]
const posOf = (k, flexTE) => {
  const f = POS_FILTERS.find(x => x.k === k) || POS_FILTERS[0]
  if (f.k === 'FLEX' && flexTE) return ['RB', 'WR', 'TE']
  return f.pos
}

const SLOT_ORDER = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN']

/* 17<sup>.00</sup> — the NFL app's signature score treatment */
const Sup = ({ v }) => {
  if (v == null) return <>—</>
  const [i, d] = Number(v).toFixed(2).split('.')
  return <>{i}<sup>.{d}</sup></>
}

/* same sideways stat columns as the draft room, for the free-agent pool */
const FA_COLS = {
  QB: [['pass_yd', 'PASS YD'], ['pass_td', 'PASS TD'], ['pass_int', 'INT'], ['rush_yd', 'RUSH YD'], ['ppg', 'PPG']],
  RB: [['rush_yd', 'RUSH YD'], ['ypc', 'YPC'], ['rush_td', 'RUSH TD'], ['rec', 'REC'], ['rec_yd', 'REC YD'], ['touch', 'TOUCHES'], ['ppg', 'PPG']],
  WR: [['rec', 'REC'], ['rec_tgt', 'TAR'], ['rec_yd', 'REC YD'], ['rec_td', 'REC TD'], ['catch_pct', 'CATCH%'], ['ppg', 'PPG']],
  K:  [['gp', 'GP'], ['ppg', 'PPG']],
  DEF: [['gp', 'GP'], ['ppg', 'PPG']],
}
FA_COLS.TE = FA_COLS.WR
const faCells = (p, projKey) => {
  const ly = p.lyd || {}
  const cells = [
    ['PROJ/WK', perGame(p, projKey)],
    ...(FA_COLS[p.pos] || []).map(([k, lab]) => ["'25 " + lab, ly[k]]),
  ]
  return cells.map(([lab, v]) => (
    <div className="scell" key={lab}><s>{lab}</s><b>{v ?? '—'}</b></div>
  ))
}

function Shot({ p, size = 40 }) {
  const [bad, setBad] = useState(false)
  // guard FIRST — a lineup can reference a player that isn't loaded, and
  // reading p.id before this check crashed the whole page to white.
  if (!p) return <div className="pic" style={{ width: size, height: size }}>
    <span className="ph">?</span></div>
  const isDef = p.pos === 'DEF'
  const src = isDef ? teamLogo(p.team) : headshot(p.id)
  const inj = p.inj ? ' inj' : ''   // gold ring, like the real app
  if (bad || !src) return <div className={'pic' + inj} style={{ width: size, height: size }}>
    <span className={'ph pos-' + (p.pos || '')}>{p.pos || '?'}</span></div>
  return <div className={'pic' + (isDef ? ' logo' : '') + inj} style={{ width: size, height: size }}>
    <img src={src} alt="" onError={() => setBad(true)} /></div>
}

/* the bottom tab bar the real app navigates with */
const NAV = [
  ['team', 'Team', <path key="t" d="M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-3z" />],
  ['matchup', 'Matchup', <ellipse key="m" cx="12" cy="12" rx="9" ry="5.6" transform="rotate(-32 12 12)" />],
  ['players', 'Players', <g key="p"><circle cx="9" cy="8.5" r="3.2" /><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" /><circle cx="17" cy="9.5" r="2.6" /><path d="M15.5 14.4c2.4.2 4.3 1.8 4.9 4.6" /></g>],
  ['trades', 'Trades', <g key="tr"><path d="M4 8h13l-3.2-3.2M20 16H7l3.2 3.2" /></g>],
  ['league', 'League', <g key="l"><path d="M7 4h10v4a5 5 0 0 1-10 0V4z" /><path d="M7 5H4.5a3 3 0 0 0 3 4M17 5h2.5a3 3 0 0 1-3 4M12 13v4m-4 4h8m-4-4v4" /></g>],
]
function BottomNav({ tab, setTab }) {
  return (
    <div className="bottomnav">
      {NAV.map(([k, label, icon]) => (
        <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round">{icon}
            {k === 'matchup' && <path d="M9.4 14.6l5.2-5.2M11 13l1-1m1-1l1-1" />}
          </svg>
          <span>{label}</span>
        </button>
      ))}
    </div>
  )
}

/* ============================================================
   SEASON — what you see once the draft is done.
   ============================================================ */
export default function Season({ league, teams, draft, uid, players, onOpenPlayer, goDraft }) {
  const [tab, setTab] = useState('team')
  const [info, setInfo] = useState(false)   // League Info takes over the screen
  const [week, setWeek] = useState(1)
  const [lineup, setLineup] = useState(null)
  const [allPicks, setAllPicks] = useState(null)
  const [matchups, setMatchups] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [sel, setSel] = useState(null)          // player id selected for a swap
  const [roster, setRoster] = useState(null)
  const [waivers, setWaivers] = useState([])
  const [claims, setClaims] = useState([])
  const [priority, setPriority] = useState([])
  const [txErr, setTxErr] = useState(null)
  const [txBusy, setTxBusy] = useState(false)
  const [pending, setPending] = useState(null)   // {player, mode} awaiting a drop choice
  const [live, setLive] = useState(null)        // {stats, gameByTeam, live, finals}
  const [nfl, setNfl] = useState(null)          // which week the NFL is actually on
  const [scoringCfg, setScoringCfg] = useState(null)
  const [table, setTable] = useState(null)   // real standings once weeks are final

  const myTeam = teams.find(t => t.owner_uid === uid)
  const byId = useMemo(() => new Map((players || []).map(p => [p.id, p])), [players])
  const teamById = useMemo(() => new Map(teams.map(t => [t.id, t])), [teams])
  const projKey = league.scoring === 'ppr' ? 'ppr' : league.scoring === 'half' ? 'half' : 'std'

  const loadLineup = useCallback(async () => {
    if (!myTeam) return
    const { data } = await supabase.from('lineups').select('*').eq('team_id', myTeam.id).eq('week', week)
    if (data && data.length) { setLineup(data); return }
    // no lineup yet for this week — build one
    const { error } = await supabase.rpc('autofill_lineup', { p_team_id: myTeam.id, p_week: week })
    if (error) { setErr(error.message); setLineup([]); return }
    const again = await supabase.from('lineups').select('*').eq('team_id', myTeam.id).eq('week', week)
    setLineup(again.data || [])
  }, [myTeam?.id, week])

  useEffect(() => { loadLineup() }, [loadLineup])

  const loadMatchups = useCallback(() => {
    supabase.from('matchups').select('*').eq('league_id', league.id).order('week')
      .then(({ data }) => setMatchups(data || []))
    supabase.rpc('standings', { p_league_id: league.id })
      .then(({ data }) => setTable(data || null)).catch(() => {})
  }, [league.id])

  useEffect(() => {
    supabase.from('picks').select('team_id,player_id,pick_no').eq('draft_id', draft.id)
      .then(({ data }) => setAllPicks(data || []))
    loadMatchups()
  }, [draft.id, league.id])


  /* The roster is a real table now, not the draft picks. Seed it once from
     the draft the first time anyone opens the season screen. */
  const loadRoster = useCallback(async () => {
    let { data } = await supabase.from('roster_players')
      .select('team_id,player_id,acquired').eq('league_id', league.id)
    if (!data || !data.length) {
      await supabase.rpc('seed_rosters', { p_league_id: league.id })
      const again = await supabase.from('roster_players')
        .select('team_id,player_id,acquired').eq('league_id', league.id)
      data = again.data || []
    }
    setRoster(data || [])
    const [w, c, t] = await Promise.all([
      supabase.from('waiver_players').select('player_id,clears_at').eq('league_id', league.id),
      supabase.from('waiver_claims').select('*').eq('league_id', league.id).eq('status', 'pending'),
      supabase.from('teams').select('id,name,waiver_priority').eq('league_id', league.id),
    ])
    setWaivers(w.data || []); setClaims(c.data || []); setPriority(t.data || [])
  }, [league.id])
  useEffect(() => { loadRoster() }, [loadRoster])

  /* The league's own scoring rules drive every number on screen. */
  useEffect(() => {
    supabase.rpc('league_settings', { p_league_id: league.id })
      .then(({ data }) => setScoringCfg(data?.scoring || null)).catch(() => {})
    /* ?replay=2025:1 pins the live feed to a week that has actually been
       played. It is how live scoring gets tested before September, and it
       labels itself on screen so a replay can never be mistaken for today. */
    const rp = new URLSearchParams(location.search).get('replay')
    if (rp && /^\d{4}:\d{1,2}$/.test(rp)) {
      const [y, w] = rp.split(':').map(Number)
      setNfl({ season: y, week: w, regular: true, replay: true })
    } else {
      currentWeek().then(setNfl).catch(() => {})
    }
  }, [league.id])

  /* Live scores. Every client reads the same public feed and runs the same
     deterministic engine, so all five managers see identical numbers. Games
     that have finished are cached, so a quiet Tuesday costs one request. */
  const pullLive = useCallback(async () => {
    if (!nfl?.regular || !nfl.season) return
    try { setLive(await fetchLiveWeek(nfl.season, nfl.replay ? nfl.week : week)) } catch {}
  }, [nfl?.regular, nfl?.season, nfl?.replay, nfl?.week, week])
  useEffect(() => { pullLive() }, [pullLive])
  useEffect(() => {
    if (!live?.live) return                     // nothing in progress, no need to poll
    const iv = setInterval(pullLive, 45000)
    return () => clearInterval(iv)
  }, [live?.live, pullLive])


  /* Claims settle in the database on a heartbeat, the same way the draft
     clock does — never on a browser's idea of what time it is. */
  useEffect(() => {
    const iv = setInterval(() => {
      supabase.rpc('process_waivers', { p_league_id: league.id })
        .then(({ data }) => { if (data?.settled) loadRoster() }).catch(() => {})
    }, 60000)
    return () => clearInterval(iv)
  }, [league.id, loadRoster])

  const starters = (lineup || []).filter(l => l.slot !== 'BN')
  const bench = (lineup || []).filter(l => l.slot === 'BN')
  const sortSlots = arr => [...arr].sort((a, b) =>
    SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot))

  /* What a player is worth RIGHT NOW. Before kickoff that is the weekly
     projection; once his game starts it is what he has actually scored. */
  const liveOf = (p) => {
    if (!p || !live || !scoringCfg) return null
    const raw = live.raw[p.id]
    if (!raw) return null
    return scorePlayer(fromSleeperWeek(raw, p.pos), scoringCfg, p.pos)
  }
  const gameOf = (p) => (p && live?.gameByTeam?.[p.team]) || null

  /* ON FIELD / SIDELINE, the way the NFL app showed it. A player counts as
     on the field when his game is being played and his own team has the
     ball. Kickers and defences are the exception — a defence is on the
     field precisely when its team does NOT have it. */
  const fieldState = (p) => {
    const g = gameOf(p)
    if (!g || !g.inPlay) return null
    if (!g.possession) return 'sideline'          // between plays, nobody has it
    const theirBall = g.hasBall
    if (p.pos === 'DEF') return theirBall ? 'sideline' : 'field'
    if (p.pos === 'K') return 'sideline'          // only out for kicks
    return theirBall ? 'field' : 'sideline'
  }
  const shownPts = (p) => {
    const l = liveOf(p)
    return l == null ? perGame(p, projKey) : l
  }
  const isLive = !!live && (live.live > 0 || live.finals > 0)
  /* the season is as long as the league says, plus its playoff rounds —
     a hardcoded 14 hid weeks 15-17 from anyone who reaches the final */
  const lastWeek = (league.regular_weeks || 14) +
    Math.ceil(Math.log2(Math.max(2, league.playoff_teams || 4)))

  const projTotal = starters.reduce((s, l) => s + (shownPts(byId.get(l.player_id)) || 0), 0)

  const myMatchup = (matchups || []).find(m =>
    m.week === week && (m.home_team_id === myTeam?.id || m.away_team_id === myTeam?.id))
  const oppId = myMatchup
    ? (myMatchup.home_team_id === myTeam?.id ? myMatchup.away_team_id : myMatchup.home_team_id)
    : null

  /* Once a player's game kicks off his slot is frozen, the way it is in
     every real fantasy app. Without this you could watch someone score 30
     and then slide him into your lineup afterwards. */
  const lockedFor = (playerId) => {
    const p = byId.get(playerId)
    const g = gameOf(p)
    return !!g && g.state !== 'pre'
  }

  const tapPlayer = async (l) => {
    if (lockedFor(l.player_id)) {
      setErr(`${byId.get(l.player_id)?.name || 'That player'}'s game has started — his spot is locked.`)
      setSel(null); return
    }
    if (sel && lockedFor(sel)) { setSel(null); return }
    if (!sel) { setSel(l.player_id); return }
    if (sel === l.player_id) { setSel(null); return }
    setBusy(true); setErr(null)
    const { error } = await supabase.rpc('swap_lineup', {
      p_team_id: myTeam.id, p_week: week, p_a: sel, p_b: l.player_id,
    })
    setBusy(false); setSel(null)
    if (error) setErr(error.message); else loadLineup()
  }

  const rosterOf = (teamId) => (roster || allPicks || [])
    .filter(p => p.team_id === teamId)
    .map(p => byId.get(p.player_id)).filter(Boolean)
    .sort((a, b) => (b[projKey] || 0) - (a[projKey] || 0))


  /* free / waivers / rostered, computed once for the whole player list */
  const waiverBy = useMemo(() => new Map(waivers.map(w => [w.player_id, w.clears_at])), [waivers])
  const ownerBy = useMemo(() => new Map((roster || []).map(r => [r.player_id, r.team_id])), [roster])
  const claimedBy = useMemo(
    () => new Set(claims.filter(c => c.team_id === myTeam?.id).map(c => c.player_id)), [claims, myTeam?.id])
  const myPriority = priority.find(t => t.id === myTeam?.id)?.waiver_priority
  const rosterFull = (roster || []).filter(r => r.team_id === myTeam?.id).length >= league.rounds

  const stateOf = (id) => {
    if (ownerBy.has(id)) return 'rostered'
    const c = waiverBy.get(id)
    if (c && new Date(c) > new Date()) return 'waivers'
    return 'free'
  }

  const transact = async (fn, args) => {
    setTxBusy(true); setTxErr(null)
    const { error } = await supabase.rpc(fn, args)
    setTxBusy(false)
    if (error) { setTxErr(error.message); return false }
    await loadRoster(); loadLineup()
    return true
  }

  /* opponent's starters for the mirrored matchup columns. Their real
     lineup is used when the database lets us read it; otherwise it is
     synthesized from their roster (best projection into each slot) and
     labelled as projected, never passed off as their actual lineup. */
  const [oppStarters, setOppStarters] = useState(null)
  useEffect(() => {
    let live = true
    setOppStarters(null)
    if (!oppId) return
    const synth = () => {
      const cfg = league.roster || { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 }
      const pool = rosterOf(oppId); const used = new Set(); const out = []
      for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'])
        for (let i = 0; i < (cfg[pos] || 0); i++) {
          const pl = pool.find(x => x.pos === pos && !used.has(x.id))
          if (pl) used.add(pl.id); out.push({ slot: pos, p: pl || null })
        }
      const FLEXPOS = cfg.flex_te ? ['RB', 'WR', 'TE'] : ['RB', 'WR']
      for (let i = 0; i < (cfg.FLEX || 0); i++) {
        const pl = pool.find(x => FLEXPOS.includes(x.pos) && !used.has(x.id))
        if (pl) used.add(pl.id); out.push({ slot: 'FLEX', p: pl || null })
      }
      return out
    }
    supabase.from('lineups').select('*').eq('team_id', oppId).eq('week', week)
      .then(({ data }) => {
        if (!live) return
        if (data && data.length) {
          setOppStarters(sortSlots(data.filter(l => l.slot !== 'BN'))
            .map(l => ({ slot: l.slot, p: byId.get(l.player_id) || null })))
        } else setOppStarters(synth())
      })
  }, [oppId, week, allPicks])

  /* Once every game in a week is final, write the result down. Each
     manager reports the matchup THEY can see; record_week ignores a
     matchup whose scores aren't both known and refuses to touch a week
     already marked final, so five phones reporting the same week is
     harmless and between them every game gets recorded. */
  useEffect(() => {
    if (!live || !scoringCfg || !myTeam || !myMatchup || myMatchup.final) return
    if (!live.games || live.finals < live.games) return          // week still running
    const total = (ids) => ids.reduce((sum, id) => {
      const p = byId.get(id)
      const raw = p && live.raw[p.id]
      return sum + (raw ? scorePlayer(fromSleeperWeek(raw, p.pos), scoringCfg, p.pos) : 0)
    }, 0)
    const mineIds = (lineup || []).filter(l => l.slot !== 'BN').map(l => l.player_id)
    const oppIds = (oppStarters || []).filter(x => x.p).map(x => x.p.id)
    if (!mineIds.length || !oppIds.length) return
    supabase.rpc('record_week', {
      p_league_id: league.id, p_week: week,
      p_scores: { [myTeam.id]: total(mineIds), [oppId]: total(oppIds) },
    }).then(({ data }) => { if (data?.recorded) loadMatchups() }).catch(() => {})
  }, [live?.finals, live?.games, scoringCfg, myMatchup?.id, lineup, oppStarters, week])

  if (info) return (
    <LeagueInfo league={league} teams={teams} uid={uid}
      startTab={info === 'activity' ? 'activity' : 'league'}
      onClose={() => setInfo(false)} />
  )

  return (
    <div className="wrap hasnav">
      <div className="sect">
        <div>
          <h1>{league.name}</h1>
          <div className="microlabel">{myTeam?.name} · {league.scoring.toUpperCase()} · {teams.length} teams</div>
        </div>
        <button className="btn small secondary" onClick={goDraft}>Draft results</button>
      </div>

      {err && <div className="err">{err}</div>}

      <BottomNav tab={tab} setTab={setTab} />

      <div className="weekbar">
        <button className="wk" disabled={week <= 1} onClick={() => setWeek(w => w - 1)}>‹</button>
        <span>Week {week}</span>
        <button className="wk" disabled={week >= lastWeek} onClick={() => setWeek(w => w + 1)}>›</button>
      </div>

      {/* ---------------- MY TEAM ---------------- */}
      {tab === 'team' && (
        <div>
          {!myTeam && <div className="hint pad">You don't have a team in this league.</div>}
          {myTeam && lineup === null && <div className="loading"><span className="spinner" />Loading lineup…</div>}
          {myTeam && lineup && (
            <>
              <div className="lineuptot">
                <span className="microlabel">Starting lineup · projected this week</span>
                <b><Sup v={projTotal} /></b>
              </div>
              {sel && <div className="needline">Tap another player to swap.</div>}

              {sortSlots(starters).map(l => {
                const p = byId.get(l.player_id)
                return (
                  <div className={'row tap nopad' + (sel === l.player_id ? ' sel' : '') +
                      (lockedFor(l.player_id) ? ' lockedrow' : '')} key={l.player_id}
                    onClick={() => tapPlayer(l)}>
                    <div className={"slotpill " + l.slot}>{l.slot}</div>
                    <Shot p={p} size={38} />
                    <div className="who" onClick={e => { e.stopPropagation(); p && onOpenPlayer(p) }}>
                      <div className="nm">{p?.name || l.player_id}</div>
                      <div className="sub">
                        <span className={'posbadge bg-' + (p?.pos || '')}>{p?.pos}</span>
                        {p?.team || 'FA'}
                        {gameOf(p)
                          ? <><span className="dot">·</span>
                              <b className={'gclock' + (gameOf(p).done ? '' : gameOf(p).inPlay ? ' on' : '')}>
                                {gameOf(p).detail}</b>
                              {fieldState(p) && (
                                <span className={'fieldpill ' + fieldState(p)}>
                                  {fieldState(p) === 'field' ? 'ON FIELD' : 'SIDELINE'}
                                </span>
                              )}
                              {gameOf(p)?.hasBall && gameOf(p)?.downDistance &&
                                <span className="dnd">{gameOf(p).downDistance}</span>}
                            </>
                          : <> · Bye {p?.bye ?? '—'}</>}
                      </div>
                    </div>
                    <div className="nums"><div className="num">
                      <b>{shownPts(p) ?? '—'}</b>
                      <s>{liveOf(p) == null ? 'PROJ' : (gameOf(p)?.done ? 'FINAL' : 'LIVE')}</s>
                    </div></div>
                  </div>
                )
              })}

              <div className="sect"><span className="microlabel">Bench</span></div>
              {bench.map(l => {
                const p = byId.get(l.player_id)
                return (
                  <div className={'row tap nopad' + (sel === l.player_id ? ' sel' : '')} key={l.player_id}
                    onClick={() => tapPlayer(l)}>
                    <div className="slotpill">BN</div>
                    <Shot p={p} size={38} />
                    <div className="who" onClick={e => { e.stopPropagation(); p && onOpenPlayer(p) }}>
                      <div className="nm">{p?.name || l.player_id}</div>
                      <div className="sub">
                        <span className={'posbadge bg-' + (p?.pos || '')}>{p?.pos}</span>
                        {p?.team || 'FA'}
                        {gameOf(p)
                          ? <><span className="dot">·</span>
                              <b className={'gclock' + (gameOf(p).done ? '' : gameOf(p).inPlay ? ' on' : '')}>
                                {gameOf(p).detail}</b>
                              {fieldState(p) && (
                                <span className={'fieldpill ' + fieldState(p)}>
                                  {fieldState(p) === 'field' ? 'ON FIELD' : 'SIDELINE'}
                                </span>
                              )}
                              {gameOf(p)?.hasBall && gameOf(p)?.downDistance &&
                                <span className="dnd">{gameOf(p).downDistance}</span>}
                            </>
                          : <> · Bye {p?.bye ?? '—'}</>}
                      </div>
                    </div>
                    <div className="nums"><div className="num">
                      <b>{shownPts(p) ?? '—'}</b>
                      <s>{liveOf(p) == null ? 'PROJ' : (gameOf(p)?.done ? 'FINAL' : 'LIVE')}</s>
                    </div></div>
                  </div>
                )
              })}
              {!bench.length && <div className="hint pad">No bench players.</div>}
            </>
          )}
        </div>
      )}

      {/* ---------------- MATCHUP ---------------- */}
      {tab === 'matchup' && (
        <div>
          {matchups === null && <div className="loading"><span className="spinner" />Loading schedule…</div>}
          {matchups && !myMatchup && <div className="hint pad">No matchup scheduled for week {week}.</div>}
          {myMatchup && (
            <>
              <div className="mhead">
                <div className="mside">
                  <div className="mname">{myTeam?.name}</div>
                  <div className="mscore"><Sup v={projTotal} /></div>
                  <div className="microlabel">projected</div>
                </div>
                <div className="mvs">VS</div>
                <div className="mside r">
                  <div className="mname">{oppId ? teamById.get(oppId)?.name : 'BYE'}</div>
                  <div className="mscore">
                    {oppId ? <Sup v={(oppStarters || []).reduce((s, x) => s + (shownPts(x.p) || 0), 0)} /> : '—'}
                  </div>
                  <div className="microlabel">projected</div>
                </div>
              </div>
              {isLive ? (
                <div className="livebar">
                  <span className="dotlive" />
                  {nfl?.replay && <b className="replaytag">REPLAY {nfl.season} WK{nfl.week}</b>}
                  {live.live > 0 ? `${live.live} game${live.live === 1 ? '' : 's'} in progress`
                                 : `${live.finals} game${live.finals === 1 ? '' : 's'} final`}
                  <span className="lb-sub">scores update on their own</span>
                </div>
              ) : (
                <div className="notice">
                  No games have kicked off for week {week} yet, so these are projections.
                  Real points replace them the moment the ball is snapped.
                </div>
              )}
              {oppId && oppStarters === null &&
                <div className="loading"><span className="spinner" />Loading matchup…</div>}
              {oppId && oppStarters && (() => {
                /* mirrored slot-by-slot pairs, like the real app */
                const mine = sortSlots(starters).map(l => ({ slot: l.slot, p: byId.get(l.player_id) || null }))
                const n = Math.max(mine.length, oppStarters.length)
                const Half = ({ x, opp }) => (
                  <div className={'mcard' + (opp ? ' opp' : '')}
                    onClick={() => x?.p && onOpenPlayer(x.p)}>
                    <div className="mtop">
                      <Shot p={x?.p} size={36} />
                      <div className="mpts">
                        <b>{x?.p ? <Sup v={shownPts(x.p) ?? 0} /> : '—'}</b>
                        <i>{x?.p && liveOf(x.p) != null ? (gameOf(x.p)?.done ? 'final' : 'live') : 'proj'}</i>
                      </div>
                    </div>
                    <div className="mwho">
                      {opp && x?.p && <span className="pos">{x.p.pos}</span>}
                      {x?.p ? x.p.name : 'Empty'}
                      {!opp && x?.p && <span className="pos">{x.p.pos}</span>}
                    </div>
                    <div className="mfoot">
                      <span>{x?.p ? (x.p.team || 'FA') : '—'}</span>
                      <span>{gameOf(x?.p)?.detail || ('Bye ' + (x?.p?.bye ?? '—'))}</span>
                    </div>
                  </div>
                )
                return Array.from({ length: n }, (_, i) => (
                  <React.Fragment key={i}>
                    <div className="mslotband">{mine[i]?.slot || oppStarters[i]?.slot}</div>
                    <div className="mpair">
                      <Half x={mine[i]} opp={false} />
                      <Half x={oppStarters[i]} opp={true} />
                    </div>
                  </React.Fragment>
                ))
              })()}
            </>
          )}
        </div>
      )}

      {/* ---------------- PLAYERS (free agents) ---------------- */}
      {tab === 'players' && (
        <>
          {txErr && <div className="err">{txErr}</div>}
          <div className="wvbar">
            <span className="microlabel">Waiver priority</span>
            <b>{myPriority ?? '—'}<span> of {priority.length}</span></b>
          </div>
          {rosterFull && (
            <div className="notice">
              Your roster is full at {league.rounds}. Drop someone on My Team first,
              or add here and you'll be asked who to drop.
            </div>
          )}
          {claims.filter(c => c.team_id === myTeam?.id).length > 0 && (
            <>
              <div className="sect"><h2>Your pending claims</h2></div>
              {claims.filter(c => c.team_id === myTeam?.id).map(c => {
                const pl = byId.get(c.player_id), dr = byId.get(c.drop_id)
                const when = waiverBy.get(c.player_id)
                return (
                  <div className="row nopad" key={c.id}>
                    <Shot p={pl} size={34} />
                    <div className="who">
                      <div className="nm">{pl?.name || c.player_id}</div>
                      <div className="sub">
                        {dr ? `drop ${dr.name}` : 'no drop'}
                        {when ? ` · settles ${new Date(when).toLocaleString(undefined,
                          { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}
                      </div>
                    </div>
                    <button className="delbtn" disabled={txBusy}
                      onClick={() => transact('cancel_claim', { p_claim_id: c.id })}>Cancel</button>
                  </div>
                )
              })}
            </>
          )}
          <FreeAgents players={players} projKey={projKey} onOpenPlayer={onOpenPlayer}
            stateOf={stateOf} waiverBy={waiverBy} claimedBy={claimedBy}
            busy={txBusy} rosterFull={rosterFull}
            onAdd={p => rosterFull
              ? setPending({ player: p, mode: 'add' })
              : transact('add_free_agent', { p_team_id: myTeam.id, p_player_id: p.id, p_drop_id: null })}
            onClaim={p => setPending({ player: p, mode: 'claim' })} />
        </>
      )}

      {/* ---------------- LEAGUE ---------------- */}
      {pending && myTeam && (
        <DropSheet
          adding={pending.player} mode={pending.mode} projKey={projKey} busy={txBusy}
          mine={rosterOf(myTeam.id)}
          startersById={new Set((lineup || []).filter(l => l.slot !== 'BN').map(l => l.player_id))}
          onCancel={() => setPending(null)}
          onConfirm={async (dropId) => {
            const fn = pending.mode === 'claim' ? 'claim_waiver' : 'add_free_agent'
            const okd = await transact(fn, {
              p_team_id: myTeam.id, p_player_id: pending.player.id, p_drop_id: dropId || null,
            })
            if (okd) setPending(null)
          }} />
      )}

      {tab === 'trades' && (
        myTeam
          ? <Trades league={league} myTeam={myTeam} teams={teams}
              roster={roster || []} byId={byId} onReload={loadRoster} />
          : <div className="hint pad">You don't have a team in this league.</div>
      )}

      {tab === 'league' && (
        <div>
          <button className="linkrow" onClick={() => setInfo(true)}>
            League Info<i className="chev">›</i>
          </button>
          <button className="linkrow" onClick={() => setInfo('activity')}>
            Recent Activity<i className="chev">›</i>
          </button>

          <div className="sect"><h2>Standings</h2></div>
          {(table && table.length ? table : teams.map((t, i) => ({
            id: t.id, name: t.name, rank: i + 1, wins: 0, losses: 0, ties: 0, points_for: null,
          }))).map(row => {
            const mine = row.id === myTeam?.id
            const played = (row.wins + row.losses + row.ties) > 0
            return (
              <div className="row nopad" key={row.id}>
                <div className="slotpill">{row.rank}</div>
                <div className="who">
                  <div className="nm">{row.name}{mine ? ' (you)' : ''}</div>
                  <div className="sub">
                    {row.wins}–{row.losses}{row.ties ? `–${row.ties}` : ''}
                    <span className="dot">·</span>
                    {played ? `${Number(row.points_for).toFixed(1)} pts` : `${rosterOf(row.id).length} players`}
                  </div>
                </div>
                <div className="nums"><div className="num">
                  <b>{played ? Number(row.points_for).toFixed(0)
                             : rosterOf(row.id).slice(0, 9).reduce((s, p) => s + (perGame(p, projKey) || 0), 0).toFixed(0)}</b>
                  <s>{played ? 'PF' : 'PROJ'}</s>
                </div></div>
              </div>
            )
          })}
          {!(table && table.some(r => r.wins + r.losses + r.ties > 0)) && (
            <div className="notice mt14">
              Records fill in as weeks finish. Until then this is ordered by projected points.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ---------- who are you dropping? ----------
   A full roster is the normal state, so "add" almost always means
   "swap". The sheet leads with the players you are least likely to
   miss — worst projection first — and says plainly when the one you
   picked is currently starting. */
function DropSheet({ adding, mode, mine, projKey, busy, onCancel, onConfirm, startersById }) {
  useScrollLock()
  const [pick, setPick] = useState(null)
  const list = [...mine].sort((a, b) => (perGame(a, projKey) || 0) - (perGame(b, projKey) || 0))

  return (
    <div className="sheetback" onClick={() => !busy && onCancel()}>
      <div className="sheet tall" onClick={e => e.stopPropagation()}>
        <div className="sheet-top">
          <div className="sheet-grab" />
          <button className="sheet-close" onClick={onCancel} aria-label="Close">✕</button>
        </div>
        <h3>{mode === 'claim' ? 'Claim' : 'Add'} {adding.name}</h3>
        <p className="sheet-note">
          {mode === 'claim'
            ? 'He is on waivers. Pick who you would drop if your claim wins — you can also claim without dropping anyone.'
            : 'Your roster is full. Pick who to drop.'}
        </p>

        {list.map(pl => {
          const starting = startersById.has(pl.id)
          return (
            <button key={pl.id}
              className={'droprow' + (pick === pl.id ? ' on' : '')}
              onClick={() => setPick(pick === pl.id ? null : pl.id)}>
              <Shot p={pl} size={34} />
              <span className="who">
                <span className="nm">{pl.name}</span>
                <span className="sub">
                  <span className={'posbadge bg-' + pl.pos}>{pl.pos}</span>
                  <span className="dot">·</span>{pl.team || 'FA'}
                  {starting && <><span className="dot">·</span><b className="startflag">STARTING</b></>}
                </span>
              </span>
              <span className="num plain"><b>{perGame(pl, projKey) ?? '—'}</b><s>PROJ</s></span>
            </button>
          )
        })}

        <div className="sheet-foot">
        <button className="btn block big" disabled={busy || (mode === 'add' && !pick)}
          onClick={() => onConfirm(pick)}>
          {busy ? 'Working…'
            : pick ? `${mode === 'claim' ? 'Claim' : 'Add'} ${adding.name.split(' ').slice(-1)[0]}, drop ${(mine.find(m => m.id === pick) || {}).name}`
            : mode === 'claim' ? 'Claim without dropping anyone' : 'Pick someone to drop'}
        </button>
        <button className="btn block secondary" disabled={busy} onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

/* ---------- free agents ---------- */
function FreeAgents({ players, projKey, onOpenPlayer, stateOf, waiverBy, claimedBy,
                      onAdd, onClaim, busy, rosterFull }) {
  const [q, setQ] = useState('')
  const [posKey, setPosKey] = useState('ALL')
  const [shown, setShown] = useState(75)
  useEffect(() => { setShown(75) }, [posKey, q])

  const list = useMemo(() => {
    if (!players) return []
    let l = players.filter(p => stateOf(p.id) !== 'rostered')
    const pf = posOf(posKey, false)
    if (pf) l = l.filter(p => pf.includes(p.pos))
    if (q.trim()) {
      const s = q.trim().toLowerCase()
      l = l.filter(p => p.name.toLowerCase().includes(s) || (p.team || '').toLowerCase().includes(s))
    }
    return l.sort((a, b) => (b[projKey] || 0) - (a[projKey] || 0))
  }, [players, posKey, q, projKey, stateOf])

  return (
    <div>
      <div className="sect"><h2>Available — {list.length}</h2></div>
      <input className="search" placeholder="Search free agents" value={q} onChange={e => setQ(e.target.value)} />
      <div className="chips">
        {POS_FILTERS.map(f => (
          <button key={f.k} className={posKey === f.k ? 'on' : ''}
            onClick={() => setPosKey(f.k)}>{f.label}</button>
        ))}
      </div>
      <div className="hscroll">
        {list.slice(0, shown).map(p => (
          <div className="row tap nopad hrow" key={p.id} onClick={() => onOpenPlayer(p)}>
            <div className="hfix">
              <Shot p={p} size={38} />
              <div className="who">
                <div className="nm">{p.name}</div>
                <div className="sub">
                  <span className={'posbadge bg-' + p.pos}>{p.pos}{p.prank ?? ''}</span>
                  <span className="dot">·</span>{p.team || 'FA'}
                  <span className="dot">·</span>({p.bye ?? '—'})
                </div>
              </div>
              {(() => {
                const st = stateOf(p.id)
                if (st === 'waivers') {
                  const claimed = claimedBy.has(p.id)
                  return (
                    <button className={'wvbtn' + (claimed ? ' on' : '')} disabled={busy || claimed}
                      onClick={e => { e.stopPropagation(); onClaim(p) }}
                      title={'On waivers until ' + new Date(waiverBy.get(p.id)).toLocaleString()}>
                      {claimed ? 'CLAIMED' : 'CLAIM'}
                    </button>
                  )
                }
                return (
                  <button className="rowbtn add" disabled={busy} title="Add"
                    onClick={e => { e.stopPropagation(); onAdd(p) }}>+</button>
                )
              })()}
            </div>
            <div className="hstats">{faCells(p, projKey)}</div>
          </div>
        ))}
      </div>
      {list.length > shown && (
        <button className="btn block secondary" onClick={() => setShown(n => n + 100)}>
          Show more — {list.length - shown} left
        </button>
      )}
      <div className="notice mt14">
        Add/drop and waivers aren't built yet — this is the free-agent pool so you can see who's out there.
      </div>
    </div>
  )
}
