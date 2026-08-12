import React, { useState } from 'react'

const headshot = id => `https://sleepercdn.com/content/nfl/players/${id}.jpg`
const teamLogo = t => t ? `https://sleepercdn.com/images/team_logos/nfl/${t.toLowerCase()}.png` : null

const n = v => (v === null || v === undefined || v === '') ? '—' : v

/* Which stat rows matter for which position. Only rows with real data render. */
const SEASON_ROWS = {
  QB: [['pass_cmp', 'CMP'], ['pass_att', 'ATT'], ['pass_yd', 'PASS YDS'], ['pass_td', 'PASS TD'],
       ['pass_int', 'INT'], ['rush_att', 'CAR'], ['rush_yd', 'RUSH YDS'], ['rush_td', 'RUSH TD']],
  RB: [['rush_att', 'CAR'], ['rush_yd', 'RUSH YDS'], ['ypc', 'YPC'], ['rush_td', 'RUSH TD'],
       ['rec', 'REC'], ['rec_yd', 'REC YDS'], ['rec_td', 'REC TD'], ['touch', 'TOUCHES']],
  WR: [['rec', 'REC'], ['rec_tgt', 'TGT'], ['rec_yd', 'REC YDS'], ['ypr', 'YPR'],
       ['rec_td', 'REC TD'], ['rush_att', 'CAR'], ['rush_yd', 'RUSH YDS']],
  TE: [['rec', 'REC'], ['rec_tgt', 'TGT'], ['rec_yd', 'REC YDS'], ['ypr', 'YPR'], ['rec_td', 'REC TD']],
  K:  [], DEF: [],
}

/* Usage + efficiency — the stuff casual apps hide. Last season only. */
const USAGE = [
  ['snap_pct', 'Snap share', '%'],
  ['touch', 'Touches', ''],
  ['rec_tgt', 'Targets', ''],
  ['tgt_share', 'Target share', '%'],
  ['catch_pct', 'Catch rate', '%'],
  ['ypc', 'Yards per carry', ''],
  ['ypt', 'Yards per target', ''],
  ['rush_rz_att', 'Red-zone carries', ''],
  ['rec_rz_tgt', 'Red-zone targets', ''],
  ['rush_btkl', 'Broken tackles', ''],
  ['rush_yac', 'Yards after contact', ''],
  ['rec_drop', 'Drops', ''],
  ['anytime_tds', 'Total TDs', ''],
  ['ppg', 'Fantasy pts/game', ''],
]

export default function PlayerCard({ p, projKey, myTurn, busy, onDraft, onQueue, queued, onClose }) {
  const [tab, setTab] = useState('overview')
  const [imgFail, setImgFail] = useState(false)
  const [dragY, setDragY] = useState(0)
  const startY = React.useRef(null)

  // swipe the sheet down to dismiss
  const onTouchStart = e => { startY.current = e.touches[0].clientY }
  const onTouchMove = e => {
    if (startY.current == null) return
    const dy = e.touches[0].clientY - startY.current
    if (dy > 0) setDragY(dy)
  }
  const onTouchEnd = () => {
    if (dragY > 110) onClose()
    setDragY(0); startY.current = null
  }
  const proj = p.projd || {}
  const ly = p.lyd || {}
  const isDef = p.pos === 'DEF'
  const rows = SEASON_ROWS[p.pos] || []
  const hasSeason = rows.some(([k]) => proj[k] != null || ly[k] != null)
  const usage = USAGE.filter(([k]) => ly[k] != null)

  return (
    <div className="sheetback" onClick={() => !busy && onClose()}>
      <div className="sheet tall" onClick={e => e.stopPropagation()}
        style={dragY ? { transform: `translateY(${dragY}px)` } : undefined}>
        <div className="sheet-grab" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} />
        <button className="sheet-close" onClick={onClose} aria-label="Close">✕</button>

        {/* ---- hero — faint team watermark behind, NFL-style ---- */}
        <div className="pc-hero">
          {teamLogo(p.team) && <img className="pc-water" src={teamLogo(p.team)} alt="" />}
          <div className="pc-shot">
            {imgFail || isDef
              ? <div className="pic" style={{width:66,height:66}}><span className={'ph pos-' + p.pos}>{p.pos}</span></div>
              : <img src={headshot(p.id)} alt="" onError={() => setImgFail(true)} />}
          </div>
          <div className="pc-id">
            <div className="pc-name">{p.name}</div>
            <div className="pc-sub">
              {teamLogo(p.team) && <img className="pc-logo" src={teamLogo(p.team)} alt="" />}
              <span className={'posbadge bg-' + p.pos}>{p.pos}</span>
              {p.team || 'FA'}{p.numj ? ` · #${p.numj}` : ''}
            </div>
            {p.inj && <div className="pc-inj">{p.inj}</div>}
          </div>
        </div>

        {/* ---- headline strip: labels above values, rank in the hexagon ---- */}
        <div className="pc-topstats">
          <div><b>{n(p.bye)}</b><span>BYE WK</span></div>
          <div><b>{n(p[projKey])}</b><span>2026 PROJ</span></div>
          <div className="pc-hex">
            <div className="hex">
              <div>
                <span>{p.pos} RNK</span>
                <b>{n(p.prank)}</b>
              </div>
            </div>
          </div>
          <div><b>{n(p.adp)}</b><span>ADP</span></div>
          <div><b>{n((p.lyd || {}).ppg)}</b><span>'25 PPG</span></div>
        </div>

        <div className="pc-tabs">
          <button className={tab === 'overview' ? 'on' : ''} onClick={() => setTab('overview')}>Overview</button>
          <button className={tab === 'stats' ? 'on' : ''} onClick={() => setTab('stats')}>Stats</button>
          <button className={tab === 'usage' ? 'on' : ''} onClick={() => setTab('usage')}>Usage</button>
          <button className={tab === 'bio' ? 'on' : ''} onClick={() => setTab('bio')}>Bio</button>
        </div>

        <div className="pc-body">
          {tab === 'overview' && (
            <>
              {hasSeason ? (
                <>
                  <div className="pc-h">Season stats</div>
                  <div className="statgrid">
                    <div className="sg-head">
                      <span />{rows.map(([k, lab]) => <span key={k}>{lab}</span>)}<span>FPTS</span>
                    </div>
                    <div className="sg-row">
                      <span className="sg-lab">PROJ 2026</span>
                      {rows.map(([k]) => <span key={k}>{n(proj[k])}</span>)}
                      <span className="sg-fpts">{n(p[projKey])}</span>
                    </div>
                    <div className="sg-row">
                      <span className="sg-lab">2025</span>
                      {rows.map(([k]) => <span key={k}>{n(ly[k])}</span>)}
                      <span className="sg-fpts">{n(ly.pts_ppr)}</span>
                    </div>
                  </div>
                </>
              ) : (
                <div className="hint pad">
                  {isDef ? 'Team defense — no individual stat line.' : 'No stat line available for this player.'}
                </div>
              )}

              {ly.pos_rank_ppr && (
                <div className="pc-callout">
                  Finished <strong>{p.pos}{ly.pos_rank_ppr}</strong> in 2025
                  {ly.ppg ? <> at <strong>{ly.ppg}</strong> points per game</> : null}
                  {ly.gp ? <> across <strong>{ly.gp}</strong> games</> : null}.
                </div>
              )}

              <div className="pc-h">2026 projection</div>
              {Object.keys(proj).length ? (
                <div className="kvgrid">
                  {proj.gp != null && <div><span>Games</span><b>{proj.gp}</b></div>}
                  {proj.touch != null && <div><span>Touches</span><b>{proj.touch}</b></div>}
                  {proj.rush_yd != null && <div><span>Rush yards</span><b>{proj.rush_yd}</b></div>}
                  {proj.rec_yd != null && <div><span>Rec yards</span><b>{proj.rec_yd}</b></div>}
                  {proj.pass_yd != null && <div><span>Pass yards</span><b>{proj.pass_yd}</b></div>}
                  {(proj.rush_td != null || proj.rec_td != null || proj.pass_td != null) &&
                    <div><span>Total TDs</span><b>{(proj.rush_td || 0) + (proj.rec_td || 0) + (proj.pass_td || 0)}</b></div>}
                </div>
              ) : <div className="hint pad">No projection published.</div>}
            </>
          )}

          {tab === 'stats' && (
            <>
              <div className="pc-h">2025 full line</div>
              {Object.keys(ly).length ? (
                <div className="kvgrid wide">
                  {[['gp', 'Games played'], ['gs', 'Games started'], ['pts_ppr', 'Fantasy points (PPR)'],
                    ['ppg', 'Points per game'], ['pos_rank_ppr', 'Position finish'],
                    ['pass_cmp', 'Completions'], ['pass_att', 'Attempts'], ['pass_yd', 'Passing yards'],
                    ['pass_td', 'Passing TDs'], ['pass_int', 'Interceptions'],
                    ['rush_att', 'Carries'], ['rush_yd', 'Rushing yards'], ['ypc', 'Yards per carry'],
                    ['rush_td', 'Rushing TDs'], ['rec', 'Receptions'], ['rec_tgt', 'Targets'],
                    ['rec_yd', 'Receiving yards'], ['ypr', 'Yards per catch'], ['rec_td', 'Receiving TDs'],
                    ['anytime_tds', 'Total touchdowns']]
                    .filter(([k]) => ly[k] != null)
                    .map(([k, lab]) => (
                      <div key={k}><span>{lab}</span><b>{k === 'pos_rank_ppr' ? `${p.pos}${ly[k]}` : ly[k]}</b></div>
                    ))}
                </div>
              ) : <div className="hint pad">No 2025 stats — rookie, or did not play.</div>}
            </>
          )}

          {tab === 'usage' && (
            <>
              <div className="pc-h">2025 usage &amp; efficiency</div>
              {usage.length ? (
                <>
                  {ly.snap_pct != null && (
                    <div className="barstat">
                      <div className="bs-top"><span>Snap share</span><b>{ly.snap_pct}%</b></div>
                      <div className="bs-track"><i style={{ width: Math.min(100, ly.snap_pct) + '%' }} /></div>
                      <div className="bs-note">{ly.off_snp} of {ly.tm_off_snp} team snaps</div>
                    </div>
                  )}
                  {ly.tgt_share != null && (
                    <div className="barstat">
                      <div className="bs-top"><span>Target share</span><b>{ly.tgt_share}%</b></div>
                      <div className="bs-track"><i style={{ width: Math.min(100, ly.tgt_share * 2) + '%' }} /></div>
                      <div className="bs-note">{ly.rec_tgt} targets</div>
                    </div>
                  )}
                  <div className="kvgrid wide">
                    {usage.filter(([k]) => k !== 'snap_pct' && k !== 'tgt_share').map(([k, lab, unit]) => (
                      <div key={k}><span>{lab}</span><b>{ly[k]}{unit}</b></div>
                    ))}
                  </div>
                </>
              ) : <div className="hint pad">No usage data for 2025.</div>}
              <p className="pc-source">
                Usage from Sleeper's official 2025 stat feed. Routes run and air yards aren't in any
                free source, so they're not shown rather than guessed.
              </p>
            </>
          )}

          {tab === 'bio' && (
            <div className="kvgrid wide">
              {p.age != null && <div><span>Age</span><b>{p.age}</b></div>}
              {p.exp != null && <div><span>Experience</span><b>{p.exp === 0 ? 'Rookie' : `${p.exp} yrs`}</b></div>}
              {p.ht && <div><span>Height</span><b>{p.ht}</b></div>}
              {p.wt != null && <div><span>Weight</span><b>{p.wt} lb</b></div>}
              {p.numj != null && <div><span>Number</span><b>#{p.numj}</b></div>}
              {p.col && <div><span>College</span><b>{p.col}</b></div>}
              {p.dc != null && <div><span>Depth chart</span><b>{p.dc}</b></div>}
              {p.team && <div><span>Team</span><b>{p.team}</b></div>}
              {p.bye != null && <div><span>Bye week</span><b>{p.bye}</b></div>}
              {p.inj && <div><span>Status</span><b className="warn">{p.inj}</b></div>}
            </div>
          )}
        </div>

        <div className="pc-actions">
          <button className="btn secondary" onClick={onQueue}>{queued ? '★ Queued' : '☆ Queue'}</button>
          {/* green, not red — in this design language red means bad news,
              and drafting a guy is the happiest tap in the app */}
          <button className="btn big good flex" disabled={!myTurn || busy} onClick={onDraft}>
            {busy ? 'Drafting…' : myTurn ? 'Draft him' : 'Not your turn'}
          </button>
        </div>
      </div>
    </div>
  )
}
