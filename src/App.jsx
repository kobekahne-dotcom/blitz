import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { supabase, ensureSession } from './supabase.js'
import { slotForPick, roundOfPick, pickInRound } from './snake.js'

/* ============================================================
   Hash router: #/           home (create or join)
                #/join/CODE  join with code prefilled
                #/league/ID  lobby → draft room
   ============================================================ */

function useHashRoute() {
  const [hash, setHash] = useState(window.location.hash || '#/')
  useEffect(() => {
    const fn = () => setHash(window.location.hash || '#/')
    window.addEventListener('hashchange', fn)
    return () => window.removeEventListener('hashchange', fn)
  }, [])
  return hash
}
const go = (h) => { window.location.hash = h }

/* ============================================================
   "Add to home screen" prompt. Android gets a real install button;
   iOS has no API for it, so it gets the actual tap-by-tap instruction.
   ============================================================ */
function InstallPrompt() {
  const [deferred, setDeferred] = useState(null)
  const [show, setShow] = useState(false)

  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
  const isAndroid = /android/i.test(navigator.userAgent)

  useEffect(() => {
    if (standalone || localStorage.getItem('blitz-install-dismissed')) return
    const onPrompt = (e) => { e.preventDefault(); setDeferred(e); setShow(true) }
    window.addEventListener('beforeinstallprompt', onPrompt)
    // iOS never fires that event — show the manual instruction instead
    if (isIOS) setShow(true)
    return () => window.removeEventListener('beforeinstallprompt', onPrompt)
  }, [standalone, isIOS])

  if (!show || standalone) return null

  const dismiss = () => { localStorage.setItem('blitz-install-dismissed', '1'); setShow(false) }
  const install = async () => {
    if (!deferred) return
    deferred.prompt()
    await deferred.userChoice
    setDeferred(null); setShow(false)
  }

  return (
    <div className="installbar">
      <img src="/blitz/icon-192.png" alt="" width="38" height="38" />
      <div className="itext">
        <strong>Add BLITZ to your home screen</strong>
        {isIOS
          ? <span>Tap the Share button <b>⎋</b> below, then <b>Add to Home Screen</b>.</span>
          : <span>Opens full screen like a real app — no browser bars during the draft.</span>}
      </div>
      {!isIOS && deferred && <button className="btn small" onClick={install}>Install</button>}
      <button className="ix" onClick={dismiss} aria-label="Dismiss">✕</button>
    </div>
  )
}

export default function App() {
  const hash = useHashRoute()
  const [session, setSession] = useState(null)
  const [authErr, setAuthErr] = useState(null)

  useEffect(() => {
    ensureSession().then(setSession).catch(e => setAuthErr(e.message))
  }, [])

  let body
  if (authErr) {
    body = (
      <div className="wrap">
        <div className="err">
          Could not sign in: {authErr}
          <div style={{ marginTop: 8 }}>
            <button className="btn small" onClick={() => { setAuthErr(null); ensureSession().then(setSession).catch(e => setAuthErr(e.message)) }}>Retry</button>
          </div>
        </div>
      </div>
    )
  } else if (!session) {
    body = <div className="loading"><span className="spinner" />Connecting…</div>
  } else if (hash.startsWith('#/league/')) {
    body = <League leagueId={hash.slice('#/league/'.length)} uid={session.user.id} />
  } else if (hash.startsWith('#/join/')) {
    body = <Home uid={session.user.id} prefillCode={hash.slice('#/join/'.length)} />
  } else {
    body = <Home uid={session.user.id} prefillCode="" />
  }

  return (
    <>
      <div className="topbar">
        <div className="logo" style={{ cursor: 'pointer' }} onClick={() => go('#/')}>BL<span>I</span>TZ</div>
        <div className="microlabel" style={{ color: 'rgba(255,255,255,0.7)' }}>Draft Room · 2026</div>
      </div>
      <InstallPrompt />
      {body}
    </>
  )
}

/* ============================================================
   HOME — create a league or join with a code
   ============================================================ */
function Home({ uid, prefillCode }) {
  const [mode, setMode] = useState(prefillCode ? 'join' : 'create')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  // create form
  const [name, setName] = useState('')
  const [teamName, setTeamName] = useState('')
  const [numTeams, setNumTeams] = useState(10)
  const [rounds, setRounds] = useState(15)
  const [scoring, setScoring] = useState('ppr')
  const [secs, setSecs] = useState(90)

  // join form
  const [code, setCode] = useState(prefillCode)
  const [joinTeam, setJoinTeam] = useState('')

  // recovery form (dead phone / new device)
  const [recCode, setRecCode] = useState(prefillCode)
  const [claimCode, setClaimCode] = useState('')

  const recover = async () => {
    setBusy(true); setErr(null)
    const { data, error } = await supabase.rpc('claim_team', {
      p_join_code: recCode, p_claim_code: claimCode,
    })
    setBusy(false)
    if (error) { setErr(error.message); return }
    go('#/league/' + data.league_id)
  }

  const create = async () => {
    setBusy(true); setErr(null)
    const { data, error } = await supabase.rpc('create_league', {
      p_name: name, p_num_teams: Number(numTeams), p_rounds: Number(rounds),
      p_scoring: scoring, p_pick_seconds: Number(secs), p_team_name: teamName,
    })
    setBusy(false)
    if (error) { setErr(error.message); return }
    go('#/league/' + data.league_id)
  }

  const join = async () => {
    setBusy(true); setErr(null)
    const { data, error } = await supabase.rpc('join_league', {
      p_join_code: code, p_team_name: joinTeam,
    })
    setBusy(false)
    if (error) { setErr(error.message); return }
    go('#/league/' + data.league_id)
  }

  return (
    <div className="wrap" style={{ maxWidth: 520 }}>
      <div className="tabs">
        <button className={mode === 'create' ? 'on' : ''} onClick={() => setMode('create')}>Create</button>
        <button className={mode === 'join' ? 'on' : ''} onClick={() => setMode('join')}>Join</button>
        <button className={mode === 'recover' ? 'on' : ''} onClick={() => setMode('recover')}>Recover</button>
      </div>
      {err && <div className="err">{err}</div>}

      {mode === 'create' ? (
        <div className="card">
          <div className="field"><label className="microlabel">League name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="The Boys 2026" /></div>
          <div className="field"><label className="microlabel">Your team name</label>
            <input value={teamName} onChange={e => setTeamName(e.target.value)} placeholder="Kobe's Killers" /></div>
          <div className="field"><label className="microlabel">Teams</label>
            <select value={numTeams} onChange={e => setNumTeams(e.target.value)}>
              {[4,6,8,10,12,14,16].map(n => <option key={n} value={n}>{n} teams</option>)}
            </select></div>
          <div className="field"><label className="microlabel">Rounds</label>
            <select value={rounds} onChange={e => setRounds(e.target.value)}>
              {[8,10,12,13,14,15,16,18,20].map(n => <option key={n} value={n}>{n} rounds</option>)}
            </select></div>
          <div className="field"><label className="microlabel">Scoring (used for rankings & autopick)</label>
            <select value={scoring} onChange={e => setScoring(e.target.value)}>
              <option value="ppr">Full PPR</option>
              <option value="half">Half PPR</option>
              <option value="std">Standard</option>
            </select></div>
          <div className="field"><label className="microlabel">Pick clock</label>
            <select value={secs} onChange={e => setSecs(e.target.value)}>
              {[30,60,90,120,180,300].map(n => <option key={n} value={n}>{n} seconds</option>)}
            </select></div>
          <button className="btn block" disabled={busy || !name.trim() || !teamName.trim()} onClick={create}>
            {busy ? 'Creating…' : 'Create league'}
          </button>
        </div>
      ) : mode === 'join' ? (
        <div className="card">
          <div className="field"><label className="microlabel">League code</label>
            <input value={code} onChange={e => setCode(e.target.value)} placeholder="8-letter code from your invite" /></div>
          <div className="field"><label className="microlabel">Your team name</label>
            <input value={joinTeam} onChange={e => setJoinTeam(e.target.value)} placeholder="Team name" /></div>
          <button className="btn block" disabled={busy || !code.trim()} onClick={join}>
            {busy ? 'Joining…' : 'Join league'}
          </button>
          <p style={{ marginTop: 10, fontSize: 13, color: 'var(--dim)' }}>
            Already joined on this device? Same button gets you back in.
          </p>
        </div>
      ) : (
        <div className="card">
          <div className="notice">
            Switched phones, cleared your browser, or lost your team? Enter the league code
            and your 5-character recovery code to take your team back on this device.
          </div>
          <div className="field"><label className="microlabel">League code</label>
            <input value={recCode} onChange={e => setRecCode(e.target.value)} placeholder="8-letter league code" /></div>
          <div className="field"><label className="microlabel">Your recovery code</label>
            <input value={claimCode} onChange={e => setClaimCode(e.target.value.toUpperCase())}
              placeholder="5 characters" maxLength={5} style={{ textTransform: 'uppercase', letterSpacing: '0.15em' }} /></div>
          <button className="btn block" disabled={busy || !recCode.trim() || claimCode.length < 5} onClick={recover}>
            {busy ? 'Recovering…' : 'Get my team back'}
          </button>
          <p style={{ marginTop: 10, fontSize: 13, color: 'var(--dim)' }}>
            Don't know your code? Ask your commissioner — they can see everyone's.
          </p>
        </div>
      )}
    </div>
  )
}

/* ============================================================
   LEAGUE — loads everything, decides lobby vs draft room.
   ALL state rebuilds from the database on every (re)connect.
   ============================================================ */
function League({ leagueId, uid }) {
  const [state, setState] = useState({ phase: 'loading' })
  const [connIssue, setConnIssue] = useState(false)
  const chanRef = useRef(null)
  const stateRef = useRef(state)
  stateRef.current = state

  const refetch = useCallback(async () => {
    try {
      const [lg, tm, dr] = await Promise.all([
        supabase.from('leagues').select('*').eq('id', leagueId).single(),
        supabase.from('teams').select('*').eq('league_id', leagueId).order('draft_slot', { ascending: true, nullsFirst: false }),
        supabase.from('drafts').select('*').eq('league_id', leagueId).single(),
      ])
      if (lg.error || tm.error || dr.error) {
        throw new Error((lg.error || tm.error || dr.error).message)
      }
      let picks = []
      if (dr.data.status !== 'pending') {
        const pk = await supabase.from('picks').select('*').eq('draft_id', dr.data.id).order('pick_no')
        if (pk.error) throw new Error(pk.error.message)
        picks = pk.data
      }
      setConnIssue(false)
      setState({ phase: 'ready', league: lg.data, teams: tm.data, draft: dr.data, picks })
    } catch (e) {
      // keep showing the last good state if we have one; flag the connection
      if (stateRef.current.phase === 'ready') setConnIssue(true)
      else setState({ phase: 'error', message: e.message })
    }
  }, [leagueId])

  // realtime + reconnect + polling fallback
  useEffect(() => {
    refetch()
    const ch = supabase
      .channel('league-' + leagueId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'picks' }, refetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'drafts' }, refetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'teams' }, refetch)
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') { setConnIssue(false); refetch() }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setConnIssue(true)
      })
    chanRef.current = ch

    const poll = setInterval(refetch, 15000) // belt-and-braces vs missed realtime events
    const onVis = () => { if (!document.hidden) refetch() }
    const onOnline = () => refetch()
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('online', onOnline)
    return () => {
      supabase.removeChannel(ch)
      clearInterval(poll)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('online', onOnline)
    }
  }, [leagueId, refetch])

  if (state.phase === 'loading') return <div className="loading"><span className="spinner" />Loading league…</div>
  if (state.phase === 'error') return (
    <div className="wrap">
      <div className="err">
        {state.message.includes('0 rows') || state.message.includes('multiple (or no) rows')
          ? "You're not in this league on this device. Go back and join with the league code."
          : state.message}
        <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
          <button className="btn small" onClick={refetch}>Retry</button>
          <button className="btn small secondary" onClick={() => go('#/')}>Home</button>
        </div>
      </div>
    </div>
  )

  const { league, teams, draft, picks } = state
  return draft.status === 'pending'
    ? <Lobby league={league} teams={teams} draft={draft} uid={uid} connIssue={connIssue} />
    : <DraftRoom league={league} teams={teams} draft={draft} picks={picks} uid={uid} connIssue={connIssue} refetch={refetch} />
}

/* ============================================================
   LOBBY — share link, who's in, commissioner starts
   ============================================================ */
function Lobby({ league, teams, draft, uid, connIssue }) {
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const isCommish = league.commissioner_uid === uid
  const myTeam = teams.find(t => t.owner_uid === uid)
  const shareUrl = window.location.origin + window.location.pathname + '#/join/' + league.join_code
  const [editingId, setEditingId] = useState(null)
  const [editName, setEditName] = useState('')

  const saveName = async (teamId) => {
    setBusy(true); setErr(null)
    const { error } = await supabase.rpc('rename_team', { p_team_id: teamId, p_name: editName })
    setBusy(false)
    if (error) { setErr(error.message); return }
    setEditingId(null)
  }

  const removeTeam = async (t) => {
    if (!window.confirm(`Remove "${t.name}" from the league? This cannot be undone.`)) return
    setBusy(true); setErr(null)
    const { error } = await supabase.rpc('remove_team', { p_team_id: t.id })
    setBusy(false)
    if (error) setErr(error.message)
  }

  const start = async () => {
    if (!window.confirm(`Start the draft with ${teams.length} teams? Draft order is randomized and no one else can join.`)) return
    setBusy(true); setErr(null)
    const { error } = await supabase.rpc('start_draft', { p_league_id: league.id })
    setBusy(false)
    if (error) setErr(error.message)
  }

  const copy = async () => {
    try { await navigator.clipboard.writeText(shareUrl); setCopied(true); setTimeout(() => setCopied(false), 2000) }
    catch { /* clipboard blocked — the code is visible anyway */ }
  }

  return (
    <div className="wrap" style={{ maxWidth: 640 }}>
      {connIssue && <div className="statusband reconnecting">Reconnecting… showing the last known state.</div>}
      <h2 style={{ marginBottom: 4 }}>{league.name}</h2>
      <div className="microlabel" style={{ marginBottom: 12 }}>
        {league.scoring === 'ppr' ? 'Full PPR' : league.scoring === 'half' ? 'Half PPR' : 'Standard'} ·
        {' '}{league.rounds} rounds · {league.pick_seconds}s clock
      </div>

      {err && <div className="err">{err}</div>}

      <div className="card">
        <div className="microlabel" style={{ marginBottom: 8 }}>Invite your league</div>
        <div className="sharebox">
          <code>{shareUrl}</code>
          <button className="btn small secondary" onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--dim)', marginTop: 8 }}>
          Or tell them the code: <strong style={{ color: 'var(--ink)' }}>{league.join_code}</strong>
        </p>
      </div>

      <div className="card">
        <div className="microlabel" style={{ marginBottom: 4 }}>
          Teams — {teams.length} of {league.num_teams} joined
        </div>
        {teams.map(t => {
          const canEdit = isCommish || t.owner_uid === uid
          const canRemove = isCommish && t.owner_uid !== league.commissioner_uid
          return (
            <div className="teamline" key={t.id}>
              <div className={'slotnum' + (t.draft_slot ? '' : ' unset')}>{t.draft_slot ?? '–'}</div>
              {editingId === t.id ? (
                <>
                  <input
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') saveName(t.id); if (e.key === 'Escape') setEditingId(null) }}
                    maxLength={40} autoFocus
                    style={{ flex: 1, minWidth: 0, padding: '7px 9px', border: '1px solid var(--blue)', borderRadius: 2 }}
                  />
                  <button className="btn small" disabled={busy} onClick={() => saveName(t.id)}>Save</button>
                  <button className="btn small secondary" disabled={busy} onClick={() => setEditingId(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <div style={{ fontWeight: 600, flex: 1, minWidth: 0 }}>{t.name}</div>
                  {t.owner_uid === uid && <span className="microlabel">you</span>}
                  {t.owner_uid === league.commissioner_uid && <span className="microlabel" style={{ color: 'var(--blue)' }}>commish</span>}
                  {canEdit && t.claim_code && (
                    <code style={{
                      background: '#F5F7F9', border: '1px solid var(--line)', padding: '3px 7px',
                      fontSize: 12, fontWeight: 800, letterSpacing: '0.1em',
                    }}>{t.claim_code}</code>
                  )}
                  {canEdit && (
                    <button className="qbtn" title="Rename"
                      onClick={() => { setEditingId(t.id); setEditName(t.name); setErr(null) }}>✎</button>
                  )}
                  {canRemove && (
                    <button className="qbtn" title="Remove this team" style={{ color: 'var(--red)', borderColor: '#F5B5B5' }}
                      onClick={() => removeTeam(t)}>✕</button>
                  )}
                </>
              )}
            </div>
          )
        })}
        {myTeam?.claim_code && (
          <div className="notice" style={{ marginTop: 10, marginBottom: 0 }}>
            <strong>Write down your recovery code: {myTeam.claim_code}</strong><br />
            If your phone dies or you switch devices mid-draft, that code plus the league code
            gets your team back. Without it you're locked out.
          </div>
        )}
        {isCommish && (
          <p style={{ marginTop: 8, fontSize: 13, color: 'var(--dim)' }}>
            You can see everyone's recovery codes — screenshot this before you start.
            If someone gets locked out tonight, read them their code.
          </p>
        )}
      </div>

      {isCommish ? (
        <>
          <div className="notice">Draft order is randomized when you hit start. Anyone not joined by then plays from the couch.</div>
          <button className="btn block danger" disabled={busy || teams.length < 2} onClick={start}>
            {busy ? 'Starting…' : `Start draft with ${teams.length} ${teams.length === 1 ? 'team' : 'teams'}`}
          </button>
        </>
      ) : (
        <div className="notice">Waiting for the commissioner to start the draft. This page updates on its own.</div>
      )}
    </div>
  )
}

/* ============================================================
   DRAFT ROOM
   ============================================================ */
function DraftRoom({ league, teams, draft, picks, uid, connIssue, refetch }) {
  const [players, setPlayers] = useState(null)
  const [playersErr, setPlayersErr] = useState(null)
  const [tab, setTab] = useState('players')
  const [q, setQ] = useState('')
  const [posFilter, setPosFilter] = useState('ALL')
  const [confirmP, setConfirmP] = useState(null)
  const [actErr, setActErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [queue, setQueue] = useState([])
  const [now, setNow] = useState(Date.now())

  const myTeam = teams.find(t => t.owner_uid === uid)
  const isCommish = league.commissioner_uid === uid
  const totalPicks = league.num_teams * league.rounds
  const done = draft.status === 'complete' || draft.current_pick > totalPicks

  const curSlot = done ? null : slotForPick(draft.current_pick, league.num_teams)
  const teamOnClock = done ? null : teams.find(t => t.draft_slot === curSlot)
  const myTurn = !!(myTeam && teamOnClock && teamOnClock.id === myTeam.id && draft.status === 'active')

  const takenIds = useMemo(() => new Set(picks.map(p => p.player_id)), [picks])
  const pickByNo = useMemo(() => { const m = new Map(); picks.forEach(p => m.set(p.pick_no, p)); return m }, [picks])
  const teamById = useMemo(() => { const m = new Map(); teams.forEach(t => m.set(t.id, t)); return m }, [teams])

  // players load — once, from OUR database (RLS: readable reference data)
  useEffect(() => {
    let live = true
    supabase.from('players').select('*').then(({ data, error }) => {
      if (!live) return
      if (error) { setPlayersErr(error.message); return }
      setPlayers(data)
    })
    return () => { live = false }
  }, [])

  // my queue
  const loadQueue = useCallback(async () => {
    if (!myTeam) return
    const { data } = await supabase.from('queues').select('*').eq('team_id', myTeam.id).order('rank')
    if (data) setQueue(data)
  }, [myTeam?.id])
  useEffect(() => { loadQueue() }, [loadQueue])

  // server-clock autopick heartbeat — EVERY client fires it; DB locking dedupes
  useEffect(() => {
    if (draft.status !== 'active') return
    const iv = setInterval(() => {
      supabase.rpc('autopick_if_expired', { p_draft_id: draft.id })
        .then(({ data }) => { if (data && data.fired) refetch() })
        .catch(() => {})
    }, 5000)
    return () => clearInterval(iv)
  }, [draft.id, draft.status, refetch])

  // countdown ticker
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(iv)
  }, [])
  const deadlineMs = draft.pick_deadline ? new Date(draft.pick_deadline).getTime() : null
  const secsLeft = deadlineMs ? Math.max(0, Math.round((deadlineMs - now) / 1000)) : null

  const playerById = useMemo(() => {
    const m = new Map(); (players || []).forEach(p => m.set(p.id, p)); return m
  }, [players])

  const projKey = league.scoring === 'ppr' ? 'ppr' : league.scoring === 'half' ? 'half' : 'std'

  const available = useMemo(() => {
    if (!players) return []
    let list = players.filter(p => !takenIds.has(p.id))
    if (posFilter !== 'ALL') list = list.filter(p => p.pos === posFilter)
    if (q.trim()) {
      const s = q.trim().toLowerCase()
      list = list.filter(p => p.name.toLowerCase().includes(s) || (p.team || '').toLowerCase().includes(s))
    }
    return list.sort((a, b) => {
      const aa = a.adp ?? 9999, bb = b.adp ?? 9999
      if (aa !== bb) return aa - bb
      return (b[projKey] ?? 0) - (a[projKey] ?? 0)
    })
  }, [players, takenIds, posFilter, q, projKey])

  const doPick = async (p) => {
    if (!myTeam) return
    setBusy(true); setActErr(null)
    const { error } = await supabase.rpc('make_pick', {
      p_draft_id: draft.id, p_team_id: myTeam.id, p_player_id: p.id,
    })
    setBusy(false); setConfirmP(null)
    if (error) { setActErr(error.message); refetch() }
  }

  const toggleQueue = async (p) => {
    if (!myTeam) return
    const inQ = queue.find(x => x.player_id === p.id)
    if (inQ) {
      await supabase.from('queues').delete().eq('team_id', myTeam.id).eq('player_id', p.id)
    } else {
      const maxRank = queue.reduce((m, x) => Math.max(m, x.rank), 0)
      await supabase.from('queues').insert({ team_id: myTeam.id, player_id: p.id, rank: maxRank + 1 })
    }
    loadQueue()
  }

  const moveQueue = async (item, dir) => {
    const idx = queue.findIndex(x => x.player_id === item.player_id)
    const swap = queue[idx + dir]
    if (!swap) return
    await Promise.all([
      supabase.from('queues').update({ rank: swap.rank }).eq('team_id', myTeam.id).eq('player_id', item.player_id),
      supabase.from('queues').update({ rank: item.rank }).eq('team_id', myTeam.id).eq('player_id', swap.player_id),
    ])
    loadQueue()
  }

  const commish = async (fn, args = {}) => {
    setBusy(true); setActErr(null)
    const { error } = await supabase.rpc(fn, { p_draft_id: draft.id, ...args })
    setBusy(false)
    if (error) setActErr(error.message)
  }

  const queueIds = new Set(queue.map(x => x.player_id))
  const myPicks = picks.filter(p => myTeam && p.team_id === myTeam.id)

  return (
    <div className="wrap">
      {connIssue && <div className="statusband reconnecting">Reconnecting… showing the last known state. Picks still go through when you tap.</div>}

      {/* status band / clock */}
      {done ? (
        <div className="statusband complete">Draft complete — {picks.length} picks. Rosters are saved below.</div>
      ) : draft.status === 'paused' ? (
        <div className="statusband paused">Draft paused by the commissioner.</div>
      ) : (
        <div className={'onclock' + (myTurn ? ' me' : '')}>
          <div className="clockbig">{secsLeft != null ? `${Math.floor(secsLeft / 60)}:${String(secsLeft % 60).padStart(2, '0')}` : '—'}</div>
          <div className="who">
            <div className="microlabel">Pick {draft.current_pick} of {totalPicks} · Round {roundOfPick(draft.current_pick, league.num_teams)}</div>
            <div className="name">{teamOnClock ? teamOnClock.name : '—'}</div>
          </div>
          {myTurn && <div className="yourturn">You're on the clock</div>}
        </div>
      )}

      {actErr && <div className="err">{actErr}</div>}

      {/* commissioner bar */}
      {isCommish && !done && (
        <div className="card commishbar">
          <span className="microlabel">Commissioner</span>
          {draft.status === 'active' && <button className="btn small secondary" disabled={busy} onClick={() => commish('pause_draft')}>Pause</button>}
          {draft.status === 'paused' && <button className="btn small" disabled={busy} onClick={() => commish('resume_draft')}>Resume</button>}
          <button className="btn small secondary" disabled={busy || picks.length === 0}
            onClick={() => { if (window.confirm('Undo the last pick?')) commish('undo_last_pick') }}>Undo last pick</button>
          {draft.status === 'active' && <button className="btn small secondary" disabled={busy} onClick={() => commish('extend_clock', { p_seconds: 30 })}>+30s</button>}
        </div>
      )}

      <div className="draftgrid">
        <div>
          {/* the board */}
          <div className="boardscroll">
            <table className="board">
              <thead>
                <tr>
                  <th></th>
                  {teams.map(t => <th key={t.id}>{t.draft_slot}. {t.name.slice(0, 12)}</th>)}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: league.rounds }, (_, r) => r + 1).map(round => (
                  <tr key={round}>
                    <td className="roundcell">R{round}</td>
                    {teams.map(t => {
                      // overall pick number for this cell
                      const inRound = round % 2 === 1 ? t.draft_slot : league.num_teams - t.draft_slot + 1
                      const pickNo = (round - 1) * league.num_teams + inRound
                      const pk = pickByNo.get(pickNo)
                      const pl = pk ? playerById.get(pk.player_id) : null
                      const isCurrent = !done && pickNo === draft.current_pick
                      return (
                        <td key={t.id} className={(isCurrent ? 'current ' : '') + (pk && pk.auto ? 'autopicked' : '')}>
                          {pk && pl ? (
                            <>
                              <span className="pickname">{pl.name}</span>
                              <span className="pickmeta"><span className={'pos-' + pl.pos}>{pl.pos}</span> {pl.team || 'FA'} · {pickNo}</span>
                            </>
                          ) : pk ? (
                            <span className="pickname">{pk.player_id}</span>
                          ) : (
                            <span className="pickmeta">{pickNo}</span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          {/* tabs: players / queue / roster / feed */}
          <div className="tabs" style={{ marginTop: 12 }}>
            <button className={tab === 'players' ? 'on' : ''} onClick={() => setTab('players')}>Players</button>
            <button className={tab === 'queue' ? 'on' : ''} onClick={() => setTab('queue')}>Queue{queue.length ? ` (${queue.length})` : ''}</button>
            <button className={tab === 'roster' ? 'on' : ''} onClick={() => setTab('roster')}>My team</button>
            <button className={tab === 'feed' ? 'on' : ''} onClick={() => setTab('feed')}>Feed</button>
          </div>

          {tab === 'players' && (
            <div className="card">
              {playersErr && <div className="err">Players failed to load: {playersErr} <button className="btn small" onClick={() => window.location.reload()}>Reload</button></div>}
              {!players && !playersErr && <div className="loading"><span className="spinner" />Loading players…</div>}
              {players && (
                <>
                  <div className="searchrow">
                    <input placeholder="Search player or team…" value={q} onChange={e => setQ(e.target.value)} />
                  </div>
                  <div className="poschips" style={{ marginBottom: 8 }}>
                    {['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map(p => (
                      <button key={p} className={posFilter === p ? 'on' : ''} onClick={() => setPosFilter(p)}>{p}</button>
                    ))}
                  </div>
                  {available.slice(0, 60).map(p => (
                    <div className="playerrow" key={p.id}>
                      <div className="pinfo">
                        <div className="pname">{p.name}</div>
                        <div className="pmeta">
                          <span className={'pos-' + p.pos}>{p.pos}</span> {p.team || 'FA'} · Bye {p.bye ?? '—'}
                        </div>
                      </div>
                      <div className="pnum"><span className="microlabel">ADP</span>{p.adp ?? '—'}</div>
                      <div className="pnum"><span className="microlabel">Proj</span>{p[projKey] ?? '—'}</div>
                      <div className="rowbtns">
                        <button className={'qbtn' + (queueIds.has(p.id) ? ' on' : '')} title="Queue" onClick={() => toggleQueue(p)}>★</button>
                        <button className="draftbtn" disabled={!myTurn || busy} onClick={() => setConfirmP(p)}>DRAFT</button>
                      </div>
                    </div>
                  ))}
                  {available.length > 60 && <div style={{ padding: 8, color: 'var(--dim)', fontSize: 13 }}>Showing top 60 — search to narrow.</div>}
                  {available.length === 0 && <div style={{ padding: 8, color: 'var(--dim)' }}>No players match.</div>}
                </>
              )}
            </div>
          )}

          {tab === 'queue' && (
            <div className="card">
              {queue.length === 0 && <div style={{ color: 'var(--dim)' }}>Star players in the Players tab. If the clock runs out on you, autopick takes from your queue first.</div>}
              {queue.map((x, i) => {
                const p = playerById.get(x.player_id)
                const gone = takenIds.has(x.player_id)
                return (
                  <div className="qrow" key={x.player_id} style={gone ? { opacity: 0.4, textDecoration: 'line-through' } : {}}>
                    <div className="qrank">{i + 1}</div>
                    <div className="qname">{p ? p.name : x.player_id}</div>
                    <div className="meta">{p ? `${p.pos} ${p.team || 'FA'}` : ''}{gone ? ' · taken' : ''}</div>
                    <button className="qbtn" onClick={() => moveQueue(x, -1)} disabled={i === 0}>↑</button>
                    <button className="qbtn" onClick={() => moveQueue(x, 1)} disabled={i === queue.length - 1}>↓</button>
                    <button className="qbtn" onClick={() => toggleQueue({ id: x.player_id })}>✕</button>
                  </div>
                )
              })}
            </div>
          )}

          {tab === 'roster' && (
            <div className="card">
              {!myTeam && <div style={{ color: 'var(--dim)' }}>You're viewing this draft — you don't have a team in it.</div>}
              {myTeam && myPicks.length === 0 && <div style={{ color: 'var(--dim)' }}>No picks yet. Your roster builds here as you draft.</div>}
              {myPicks.map(pk => {
                const p = playerById.get(pk.player_id)
                return (
                  <div className="rosterslot" key={pk.id}>
                    <span className={'rpos ' + (p ? 'pos-' + p.pos : '')}>{p ? p.pos : ''}</span>
                    <span className="rname">{p ? p.name : pk.player_id}</span>
                    <span className="meta" style={{ color: 'var(--dim)', fontSize: 12 }}>
                      {p ? (p.team || 'FA') + ' · Bye ' + (p.bye ?? '—') : ''} · R{roundOfPick(pk.pick_no, league.num_teams)}
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          {tab === 'feed' && (
            <div className="card">
              {picks.length === 0 && <div style={{ color: 'var(--dim)' }}>Picks land here as they happen.</div>}
              {[...picks].reverse().slice(0, 40).map(pk => {
                const p = playerById.get(pk.player_id)
                const t = teamById.get(pk.team_id)
                return (
                  <div className="feeditem" key={pk.id}>
                    <span className="microlabel">R{roundOfPick(pk.pick_no, league.num_teams)}·{pickInRound(pk.pick_no, league.num_teams)}</span>
                    <strong>{t ? t.name : '?'}</strong> selected <strong>{p ? p.name : pk.player_id}</strong>
                    {p && <span style={{ color: 'var(--dim)' }}> {p.pos} {p.team || 'FA'}</span>}
                    {pk.auto && <span style={{ color: 'var(--dim)' }}> (auto)</span>}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* confirm modal */}
      {confirmP && (
        <div className="modalback" onClick={() => !busy && setConfirmP(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{confirmP.name}</h3>
            <div className="meta">
              <span className={'pos-' + confirmP.pos}>{confirmP.pos}</span> {confirmP.team || 'FA'} · Bye {confirmP.bye ?? '—'} ·
              Proj {confirmP[projKey] ?? '—'} · ADP {confirmP.adp ?? '—'}
            </div>
            <div className="btnrow">
              <button className="btn secondary" disabled={busy} onClick={() => setConfirmP(null)}>Cancel</button>
              <button className="btn danger" disabled={busy || !myTurn} onClick={() => doPick(confirmP)}>
                {busy ? 'Drafting…' : 'Draft him'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
