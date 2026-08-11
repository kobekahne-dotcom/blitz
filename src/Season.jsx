import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase } from './supabase.js'

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

const SLOT_ORDER = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN']

function Shot({ p, size = 40 }) {
  const [bad, setBad] = useState(false)
  const isDef = p?.pos === 'DEF'
  const src = isDef ? teamLogo(p.team) : headshot(p.id)
  if (!p || bad || !src) return <div className="pic" style={{ width: size, height: size }}>
    <span className={'ph pos-' + (p?.pos || '')}>{p?.pos || '?'}</span></div>
  return <div className={'pic' + (isDef ? ' logo' : '')} style={{ width: size, height: size }}>
    <img src={src} alt="" onError={() => setBad(true)} /></div>
}

/* ============================================================
   SEASON — what you see once the draft is done.
   ============================================================ */
export default function Season({ league, teams, draft, uid, players, onOpenPlayer, goDraft }) {
  const [tab, setTab] = useState('team')
  const [week, setWeek] = useState(1)
  const [lineup, setLineup] = useState(null)
  const [allPicks, setAllPicks] = useState(null)
  const [matchups, setMatchups] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [sel, setSel] = useState(null)          // player id selected for a swap

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

  useEffect(() => {
    supabase.from('picks').select('team_id,player_id,pick_no').eq('draft_id', draft.id)
      .then(({ data }) => setAllPicks(data || []))
    supabase.from('matchups').select('*').eq('league_id', league.id).order('week')
      .then(({ data }) => setMatchups(data || []))
  }, [draft.id, league.id])

  const starters = (lineup || []).filter(l => l.slot !== 'BN')
  const bench = (lineup || []).filter(l => l.slot === 'BN')
  const sortSlots = arr => [...arr].sort((a, b) =>
    SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot))

  const projTotal = starters.reduce((s, l) => s + (perGame(byId.get(l.player_id), projKey) || 0), 0)

  const myMatchup = (matchups || []).find(m =>
    m.week === week && (m.home_team_id === myTeam?.id || m.away_team_id === myTeam?.id))
  const oppId = myMatchup
    ? (myMatchup.home_team_id === myTeam?.id ? myMatchup.away_team_id : myMatchup.home_team_id)
    : null

  const tapPlayer = async (l) => {
    if (!sel) { setSel(l.player_id); return }
    if (sel === l.player_id) { setSel(null); return }
    setBusy(true); setErr(null)
    const { error } = await supabase.rpc('swap_lineup', {
      p_team_id: myTeam.id, p_week: week, p_a: sel, p_b: l.player_id,
    })
    setBusy(false); setSel(null)
    if (error) setErr(error.message); else loadLineup()
  }

  const rosterOf = (teamId) => (allPicks || [])
    .filter(p => p.team_id === teamId)
    .map(p => byId.get(p.player_id)).filter(Boolean)
    .sort((a, b) => (b[projKey] || 0) - (a[projKey] || 0))

  return (
    <div className="wrap">
      <div className="sect">
        <div>
          <h1>{league.name}</h1>
          <div className="microlabel">{myTeam?.name} · {league.scoring.toUpperCase()} · {teams.length} teams</div>
        </div>
        <button className="btn small secondary" onClick={goDraft}>Draft results</button>
      </div>

      {err && <div className="err">{err}</div>}

      <div className="toptabs">
        <button className={tab === 'team' ? 'on' : ''} onClick={() => setTab('team')}>My Team</button>
        <button className={tab === 'matchup' ? 'on' : ''} onClick={() => setTab('matchup')}>Matchup</button>
        <button className={tab === 'players' ? 'on' : ''} onClick={() => setTab('players')}>Players</button>
        <button className={tab === 'league' ? 'on' : ''} onClick={() => setTab('league')}>League</button>
      </div>

      <div className="weekbar">
        <button className="wk" disabled={week <= 1} onClick={() => setWeek(w => w - 1)}>‹</button>
        <span>Week {week}</span>
        <button className="wk" disabled={week >= 14} onClick={() => setWeek(w => w + 1)}>›</button>
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
                <b>{projTotal.toFixed(1)}</b>
              </div>
              {sel && <div className="needline">Tap another player to swap.</div>}

              {sortSlots(starters).map(l => {
                const p = byId.get(l.player_id)
                return (
                  <div className={'row tap nopad' + (sel === l.player_id ? ' sel' : '')} key={l.player_id}
                    onClick={() => tapPlayer(l)}>
                    <div className="slotpill">{l.slot}</div>
                    <Shot p={p} size={38} />
                    <div className="who" onClick={e => { e.stopPropagation(); p && onOpenPlayer(p) }}>
                      <div className="nm">{p?.name || l.player_id}</div>
                      <div className="sub">
                        <span className={'pos pos-' + p?.pos}>{p?.pos}</span>
                        {p?.team || 'FA'} · Bye {p?.bye ?? '—'}
                      </div>
                    </div>
                    <div className="nums"><div className="num"><b>{perGame(p, projKey) ?? '—'}</b><s>PROJ</s></div></div>
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
                        <span className={'pos pos-' + p?.pos}>{p?.pos}</span>
                        {p?.team || 'FA'} · Bye {p?.bye ?? '—'}
                      </div>
                    </div>
                    <div className="nums"><div className="num"><b>{perGame(p, projKey) ?? '—'}</b><s>PROJ</s></div></div>
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
                  <div className="mscore">{projTotal.toFixed(1)}</div>
                  <div className="microlabel">projected</div>
                </div>
                <div className="mvs">VS</div>
                <div className="mside">
                  <div className="mname">{oppId ? teamById.get(oppId)?.name : 'BYE'}</div>
                  <div className="mscore">
                    {oppId ? rosterOf(oppId).slice(0, 9).reduce((s, p) => s + (perGame(p, projKey) || 0), 0).toFixed(1) : '—'}
                  </div>
                  <div className="microlabel">projected</div>
                </div>
              </div>
              <div className="notice">
                The 2026 season hasn't started, so these are projections, not live scores.
                Real points appear here once games are played.
              </div>
              {oppId && (
                <>
                  <div className="sect"><h2>{teamById.get(oppId)?.name} roster</h2></div>
                  {rosterOf(oppId).map(p => (
                    <div className="row tap nopad" key={p.id} onClick={() => onOpenPlayer(p)}>
                      <div className="slotpill">{p.pos}</div>
                      <Shot p={p} size={34} />
                      <div className="who">
                        <div className="nm">{p.name}</div>
                        <div className="sub">{p.team || 'FA'} · Bye {p.bye ?? '—'}</div>
                      </div>
                      <div className="nums"><div className="num"><b>{perGame(p, projKey) ?? '—'}</b><s>PROJ</s></div></div>
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* ---------------- PLAYERS (free agents) ---------------- */}
      {tab === 'players' && (
        <FreeAgents players={players} allPicks={allPicks} projKey={projKey} onOpenPlayer={onOpenPlayer} />
      )}

      {/* ---------------- LEAGUE ---------------- */}
      {tab === 'league' && (
        <div>
          <div className="sect"><h2>Standings</h2></div>
          {teams.map((t, i) => {
            const roster = rosterOf(t.id)
            const total = roster.slice(0, 9).reduce((s, p) => s + (perGame(p, projKey) || 0), 0)
            return (
              <div className="row nopad" key={t.id}>
                <div className="slotpill">{i + 1}</div>
                <div className="who">
                  <div className="nm">{t.name}{t.owner_uid === uid ? ' (you)' : ''}</div>
                  <div className="sub">0–0 · {roster.length} players</div>
                </div>
                <div className="nums"><div className="num"><b>{total.toFixed(0)}</b><s>PROJ</s></div></div>
              </div>
            )
          })}
          <div className="notice mt14">
            Records are 0–0 until week 1 is played. Standings will sort by wins once games count.
          </div>
        </div>
      )}
    </div>
  )
}

/* ---------- free agents ---------- */
function FreeAgents({ players, allPicks, projKey, onOpenPlayer }) {
  const [q, setQ] = useState('')
  const [posSel, setPosSel] = useState(new Set())
  const [shown, setShown] = useState(75)
  useEffect(() => { setShown(75) }, [posSel, q])
  const taken = useMemo(() => new Set((allPicks || []).map(p => p.player_id)), [allPicks])

  const list = useMemo(() => {
    if (!players) return []
    let l = players.filter(p => !taken.has(p.id))
    if (posSel.size) l = l.filter(p => posSel.has(p.pos))
    if (q.trim()) {
      const s = q.trim().toLowerCase()
      l = l.filter(p => p.name.toLowerCase().includes(s) || (p.team || '').toLowerCase().includes(s))
    }
    return l.sort((a, b) => (b[projKey] || 0) - (a[projKey] || 0))
  }, [players, taken, posSel, q, projKey])

  return (
    <div>
      <div className="sect"><h2>Free agents — {list.length} available</h2></div>
      <input className="search" placeholder="Search free agents" value={q} onChange={e => setQ(e.target.value)} />
      <div className="chips">
        <button className={posSel.size === 0 ? 'on' : ''} onClick={() => setPosSel(new Set())}>ALL</button>
        {['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map(pos => (
          <button key={pos} className={posSel.has(pos) ? 'on' : ''}
            onClick={() => setPosSel(prev => {
              const n = new Set(prev); n.has(pos) ? n.delete(pos) : n.add(pos); return n
            })}>{pos}</button>
        ))}
      </div>
      {list.slice(0, shown).map(p => (
        <div className="row tap nopad" key={p.id} onClick={() => onOpenPlayer(p)}>
          <div className="slotpill">{p.pos}{p.prank ?? ''}</div>
          <Shot p={p} size={38} />
          <div className="who">
            <div className="nm">{p.name}</div>
            <div className="sub">{p.team || 'FA'} · Bye {p.bye ?? '—'}</div>
          </div>
          <div className="nums"><div className="num"><b>{perGame(p, projKey) ?? '—'}</b><s>PROJ</s></div></div>
        </div>
      ))}
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
