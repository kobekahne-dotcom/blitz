import React, { useEffect, useMemo, useState } from 'react'

/* What changed since you last looked.

   Sleeper's free feed gives injury DESIGNATIONS and roster movement, not
   written news stories — so this shows exactly that and does not pretend
   to be a wire service. Your own players come first, because an injury to
   someone you actually start is the only item that forces a decision. */

const SEV = {
  IR: 3, PUP: 3, Sus: 3, NA: 3, DNR: 3,
  Out: 3, Doubtful: 2, Questionable: 1,
}
const WORD = {
  IR: 'Injured reserve', PUP: 'Physically unable to perform', Sus: 'Suspended',
  NA: 'Not active', DNR: 'Did not report', Out: 'Out',
  Doubtful: 'Doubtful', Questionable: 'Questionable',
}

export default function News({ players, roster, myTeam, byId, onOpenPlayer, onClose }) {
  const [trend, setTrend] = useState(null)
  const [tab, setTab] = useState('mine')

  useEffect(() => {
    const g = async (kind) => {
      try {
        const r = await fetch(`https://api.sleeper.app/v1/players/nfl/trending/${kind}?lookback_hours=24&limit=25`)
        return r.ok ? await r.json() : []
      } catch { return [] }
    }
    Promise.all([g('add'), g('drop')]).then(([add, drop]) => setTrend({ add, drop }))
  }, [])

  const mineIds = useMemo(
    () => new Set((roster || []).filter(r => r.team_id === myTeam?.id).map(r => r.player_id)),
    [roster, myTeam?.id])
  const ownedIds = useMemo(() => new Set((roster || []).map(r => r.player_id)), [roster])

  const injured = useMemo(() => (players || [])
    .filter(p => p.inj && ['QB', 'RB', 'WR', 'TE', 'K'].includes(p.pos))
    .sort((a, b) => (SEV[b.inj] || 0) - (SEV[a.inj] || 0) || (b.ppr || 0) - (a.ppr || 0)),
    [players])

  const myInjured = injured.filter(p => mineIds.has(p.id))
  const leagueInjured = injured.filter(p => ownedIds.has(p.id) && !mineIds.has(p.id))
  const freeInjured = injured.filter(p => !ownedIds.has(p.id)).slice(0, 40)

  const Line = ({ p, tag }) => (
    <button className="row tap nopad newsrow" onClick={() => onOpenPlayer?.(p)}>
      <span className={'injpill sev' + (SEV[p.inj] || 1)}>{p.inj}</span>
      <span className="who">
        <span className="nm">{p.name}</span>
        <span className="sub">
          <span className={'posbadge bg-' + p.pos}>{p.pos}</span>
          <span className="dot">·</span>{p.team || 'FA'}
          <span className="dot">·</span>{WORD[p.inj] || p.inj}
          {tag && <><span className="dot">·</span><b className="newstag">{tag}</b></>}
        </span>
      </span>
    </button>
  )

  const TrendLine = ({ id, count, up }) => {
    const p = byId?.get(id)
    if (!p) return null
    const owned = ownedIds.has(id)
    return (
      <button className="row tap nopad newsrow" onClick={() => onOpenPlayer?.(p)}>
        <span className={'trendarrow' + (up ? ' up' : ' down')}>{up ? '▲' : '▼'}</span>
        <span className="who">
          <span className="nm">{p.name}</span>
          <span className="sub">
            <span className={'posbadge bg-' + p.pos}>{p.pos}</span>
            <span className="dot">·</span>{p.team || 'FA'}
            <span className="dot">·</span>
            {mineIds.has(id) ? <b className="newstag">on your team</b>
              : owned ? 'rostered in your league' : <b className="newstag free">free agent</b>}
          </span>
        </span>
        <span className="num plain"><b>{count > 999 ? Math.round(count / 1000) + 'k' : count}</b><s>{up ? 'adds' : 'drops'}</s></span>
      </button>
    )
  }

  return (
    <div className="wrap">
      <div className="sect">
        <div>
          <h1>News</h1>
          <div className="microlabel">injuries and roster moves</div>
        </div>
        <button className="btn small secondary" onClick={onClose}>Done</button>
      </div>

      <div className="toptabs">
        <button className={tab === 'mine' ? 'on' : ''} onClick={() => setTab('mine')}>
          Your team{myInjured.length ? ` (${myInjured.length})` : ''}
        </button>
        <button className={tab === 'league' ? 'on' : ''} onClick={() => setTab('league')}>League</button>
        <button className={tab === 'trend' ? 'on' : ''} onClick={() => setTab('trend')}>Trending</button>
      </div>

      {tab === 'mine' && (
        <>
          {!myInjured.length && (
            <div className="empty"><strong>Nobody on your team is banged up</strong>
              <p>Injury designations appear here as soon as they are reported.</p></div>
          )}
          {myInjured.map(p => <Line key={p.id} p={p} />)}
          {!!freeInjured.length && myInjured.length > 0 && (
            <div className="notice">
              A player marked Out, IR or PUP will score nothing. Swap him before kickoff —
              after his game starts the lineup is locked.
            </div>
          )}
        </>
      )}

      {tab === 'league' && (
        <>
          <div className="sect"><h2>Rostered elsewhere in your league</h2></div>
          {!leagueInjured.length && <div className="hint pad">Nothing reported.</div>}
          {leagueInjured.map(p => <Line key={p.id} p={p} />)}
          <div className="sect"><h2>Available — worth watching</h2></div>
          {freeInjured.map(p => <Line key={p.id} p={p} tag="free agent" />)}
        </>
      )}

      {tab === 'trend' && (
        <>
          {trend === null && <div className="loading"><span className="spinner" />Loading…</div>}
          {trend && (
            <>
              <div className="sect"><h2>Most added — last 24 hours</h2></div>
              {trend.add.map(t => <TrendLine key={'a' + t.player_id} id={t.player_id} count={t.count} up />)}
              <div className="sect"><h2>Most dropped</h2></div>
              {trend.drop.map(t => <TrendLine key={'d' + t.player_id} id={t.player_id} count={t.count} />)}
              <div className="notice">
                Counts are how many Sleeper leagues added or dropped that player in the last
                day — a crowd signal, not advice.
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
