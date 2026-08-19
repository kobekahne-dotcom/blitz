import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from './supabase.js'
import { useScrollLock } from './lockScroll.js'

/* Trades.

   Two screens: the list of offers waiting on you, and the builder. The
   builder shows both rosters side by side because that is the actual
   question — what leaves and what arrives — and it refuses to let you
   send something the database would reject anyway. */

const LABEL = {
  pending: 'Waiting', accepted: 'Accepted', rejected: 'Rejected',
  cancelled: 'Pulled back', vetoed: 'Vetoed', executed: 'Completed', invalid: "Couldn't complete",
}

function Row({ p, on, toggle, side }) {
  if (!p) return null
  return (
    <button className={'traderow' + (on ? ' on ' + side : '')} onClick={toggle}>
      <span className={'posbadge bg-' + p.pos}>{p.pos}</span>
      <span className="tname">{p.name}</span>
      <span className="tteam">{p.team || 'FA'}</span>
      <span className="tmark">{on ? '✓' : ''}</span>
    </button>
  )
}

export function TradeBuilder({ league, myTeam, teams, roster, byId, onClose, onDone }) {
  useScrollLock()
  const others = teams.filter(t => t.id !== myTeam.id)
  const [to, setTo] = useState(others[0]?.id || null)
  const [give, setGive] = useState([])
  const [get, setGet] = useState([])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [warn, setWarn] = useState(null)

  const mine = useMemo(() => roster.filter(r => r.team_id === myTeam.id)
    .map(r => byId.get(r.player_id)).filter(Boolean)
    .sort((a, b) => (b.ppr || 0) - (a.ppr || 0)), [roster, myTeam.id, byId])
  const theirs = useMemo(() => roster.filter(r => r.team_id === to)
    .map(r => byId.get(r.player_id)).filter(Boolean)
    .sort((a, b) => (b.ppr || 0) - (a.ppr || 0)), [roster, to, byId])

  const flip = (arr, set, id) =>
    set(arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id])

  /* Ask the database whether this is legal BEFORE offering it, so the
     answer is the real rule rather than a second guess written here. */
  useEffect(() => {
    let live = true
    if (!to || (!give.length && !get.length)) { setWarn(null); return }
    supabase.rpc('trade_problem', {
      p_league_id: league.id, p_from: myTeam.id, p_to: to, p_give: give, p_get: get,
    }).then(({ data }) => { if (live) setWarn(data || null) })
    return () => { live = false }
  }, [to, give, get, league.id, myTeam.id])

  const send = async () => {
    setBusy(true); setErr(null)
    const { error } = await supabase.rpc('propose_trade', {
      p_from_team: myTeam.id, p_to_team: to, p_give: give, p_get: get,
      p_note: note.trim() || null,
    })
    setBusy(false)
    if (error) { setErr(error.message); return }
    onDone()
  }

  return (
    <div className="sheetback" onClick={() => !busy && onClose()}>
      <div className="sheet tall" onClick={e => e.stopPropagation()}>
        <div className="sheet-top">
          <div className="sheet-grab" />
          <button className="sheet-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <h3>Propose a trade</h3>

        <div className="field">
          <label className="microlabel">Trade with</label>
          <select value={to || ''} onChange={e => { setTo(e.target.value); setGet([]) }}>
            {others.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>

        <div className="pc-h">You send{give.length ? ` — ${give.length}` : ''}</div>
        {mine.map(p => (
          <Row key={p.id} p={p} side="give" on={give.includes(p.id)}
            toggle={() => flip(give, setGive, p.id)} />
        ))}

        <div className="pc-h">You get{get.length ? ` — ${get.length}` : ''}</div>
        {theirs.map(p => (
          <Row key={p.id} p={p} side="get" on={get.includes(p.id)}
            toggle={() => flip(get, setGet, p.id)} />
        ))}

        <div className="field mt14">
          <label className="microlabel">Message (optional)</label>
          <input value={note} maxLength={140} onChange={e => setNote(e.target.value)}
            placeholder="why this works for both of you" />
        </div>

        {err && <div className="err">{err}</div>}

        <div className="sheet-foot">
          {warn && <div className="warnbar tight">{warn}</div>}
          <button className="btn block big" disabled={busy || !!warn || (!give.length && !get.length)}
            onClick={send}>
            {busy ? 'Sending…'
              : (!give.length && !get.length) ? 'Pick at least one player'
              : `Send: ${give.length} for ${get.length}`}
          </button>
          <button className="btn block secondary" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

export default function Trades({ league, myTeam, teams, roster, byId, onReload }) {
  const [rows, setRows] = useState(null)
  const [build, setBuild] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const teamName = id => teams.find(t => t.id === id)?.name || '—'

  const load = async () => {
    const { data } = await supabase.from('trades')
      .select('*').eq('league_id', league.id).order('id', { ascending: false }).limit(40)
    setRows(data || [])
  }
  useEffect(() => { load() }, [league.id])

  /* Accepted trades execute when their review window closes — same
     heartbeat pattern as the draft clock and waivers. */
  useEffect(() => {
    const go = () => supabase.rpc('process_trades', { p_league_id: league.id })
      .then(({ data }) => { if (data?.executed || data?.blocked) { load(); onReload?.() } })
      .catch(() => {})
    go()
    const iv = setInterval(go, 60000)
    return () => clearInterval(iv)
  }, [league.id])

  const act = async (fn, args) => {
    setBusy(true); setErr(null)
    const { data, error } = await supabase.rpc(fn, args)
    setBusy(false)
    if (error) { setErr(error.message); return }
    // respond_trade REPORTS a stale trade rather than throwing
    if (data && data.ok === false) setErr(data.reason || 'That trade could not be completed.')
    await load(); onReload?.()
  }

  const names = ids => (ids || []).map(id => byId.get(id)?.name || id).join(', ') || 'nothing'

  return (
    <div>
      {err && <div className="err">{err}</div>}
      <button className="btn block" onClick={() => setBuild(true)}>Propose a trade</button>

      {rows === null && <div className="loading"><span className="spinner" />Loading trades…</div>}
      {rows && !rows.length && (
        <div className="empty"><strong>No trades yet</strong>
          <p>Offers you send and receive show up here.</p></div>
      )}

      {rows && rows.map(t => {
        const incoming = t.to_team_id === myTeam?.id
        const outgoing = t.from_team_id === myTeam?.id
        const live = t.status === 'pending'
        return (
          <div className="tradecard" key={t.id}>
            <div className="tchead">
              <span className="microlabel">
                {incoming ? `${teamName(t.from_team_id)} → you`
                  : outgoing ? `you → ${teamName(t.to_team_id)}`
                  : `${teamName(t.from_team_id)} → ${teamName(t.to_team_id)}`}
              </span>
              <span className={'tstat s-' + t.status}>{LABEL[t.status] || t.status}</span>
            </div>
            <div className="tcline"><s>{incoming ? 'You get' : 'They get'}</s><b>{names(t.from_players)}</b></div>
            <div className="tcline"><s>{incoming ? 'You send' : 'You get'}</s><b>{names(t.to_players)}</b></div>
            {t.note && <div className="tcnote">“{t.note}”</div>}
            {t.reason && <div className="tcnote bad">{t.reason}</div>}

            {live && incoming && (
              <div className="btnrow mt10">
                <button className="btn small secondary" disabled={busy}
                  onClick={() => act('respond_trade', { p_trade_id: t.id, p_accept: false })}>Reject</button>
                <button className="btn small good" disabled={busy}
                  onClick={() => act('respond_trade', { p_trade_id: t.id, p_accept: true })}>Accept</button>
              </div>
            )}
            {live && outgoing && (
              <button className="btn small secondary mt10" disabled={busy}
                onClick={() => act('cancel_trade', { p_trade_id: t.id })}>Pull it back</button>
            )}
            {t.status === 'accepted' && !incoming && !outgoing && (
              <button className="btn small secondary mt10" disabled={busy}
                onClick={() => act('veto_trade', { p_trade_id: t.id, p_team_id: myTeam.id })}>
                Vote to veto
              </button>
            )}
          </div>
        )
      })}

      {build && myTeam && (
        <TradeBuilder league={league} myTeam={myTeam} teams={teams} roster={roster} byId={byId}
          onClose={() => setBuild(false)}
          onDone={() => { setBuild(false); load() }} />
      )}
    </div>
  )
}
