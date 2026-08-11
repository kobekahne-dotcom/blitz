import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { supabase, ensureSession, fetchAllPlayers } from './supabase.js'
import { slotForPick, roundOfPick, pickInRound } from './snake.js'
import Home from './Home.jsx'
import PlayerCard from './PlayerCard.jsx'
import Season from './Season.jsx'

const go = (h) => { window.location.hash = h }

/* ---------- real player photos, free from Sleeper's CDN ---------- */
const headshot = id => `https://sleepercdn.com/content/nfl/players/${id}.jpg`
const teamLogo = t => t ? `https://sleepercdn.com/images/team_logos/nfl/${t.toLowerCase()}.png` : null

function Avatar({ p, size = 40, eager = false }) {
  const [failed, setFailed] = useState(false)
  const isDef = p.pos === 'DEF'
  const src = isDef ? teamLogo(p.team) : headshot(p.id)
  if (failed || !src) {
    return (
      <div className="pic" style={{ width: size, height: size }}>
        <span className={'ph pos-' + p.pos}>{p.pos}</span>
      </div>
    )
  }
  return (
    <div className={'pic' + (isDef ? ' logo' : '')} style={{ width: size, height: size }}>
      <img src={src} alt="" width={size} height={size} loading={eager ? "eager" : "lazy"} onError={() => setFailed(true)} />
    </div>
  )
}

function useHashRoute() {
  const [hash, setHash] = useState(window.location.hash || '#/')
  useEffect(() => {
    const fn = () => setHash(window.location.hash || '#/')
    window.addEventListener('hashchange', fn)
    return () => window.removeEventListener('hashchange', fn)
  }, [])
  return hash
}

/* ============================================================
   Add to home screen
   ============================================================ */
function InstallPrompt() {
  const [deferred, setDeferred] = useState(null)
  const [show, setShow] = useState(false)
  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)

  useEffect(() => {
    if (standalone || localStorage.getItem('blitz-install-dismissed')) return
    const onPrompt = (e) => { e.preventDefault(); setDeferred(e); setShow(true) }
    window.addEventListener('beforeinstallprompt', onPrompt)
    if (isIOS) setShow(true)
    return () => window.removeEventListener('beforeinstallprompt', onPrompt)
  }, [standalone, isIOS])

  if (!show || standalone) return null
  const dismiss = () => { localStorage.setItem('blitz-install-dismissed', '1'); setShow(false) }

  return (
    <div className="installbar">
      <img src="/blitz/icon-192.png" alt="" width="36" height="36" />
      <div className="itext">
        <strong>Add BLITZ to your home screen</strong>
        {isIOS
          ? <span>Tap Share, then <b>Add to Home Screen</b>. Safari only.</span>
          : <span>Full screen, no browser bars during the draft.</span>}
      </div>
      {!isIOS && deferred && (
        <button className="btn small" onClick={async () => { deferred.prompt(); await deferred.userChoice; setShow(false) }}>Install</button>
      )}
      <button className="ix" onClick={dismiss} aria-label="Dismiss">✕</button>
    </div>
  )
}

/* ============================================================
   APP
   ============================================================ */
export default function App() {
  const hash = useHashRoute()
  const [session, setSession] = useState(null)
  const [authErr, setAuthErr] = useState(null)

  const connect = useCallback(() => {
    setAuthErr(null)
    ensureSession().then(setSession).catch(e => setAuthErr(e.message))
  }, [])
  useEffect(() => { connect() }, [connect])

  let body
  if (authErr) {
    body = (
      <div className="wrap">
        <div className="err">
          {/rate limit/i.test(authErr)
            ? "Too many sign-ins from this network in the last hour. Wait a few minutes and try again."
            : 'Could not sign in: ' + authErr}
          <div style={{ marginTop: 10 }}><button className="btn small" onClick={connect}>Try again</button></div>
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

  const inLeague = hash.startsWith('#/league/')
  return (
    <>
      <div className="topbar">
        {inLeague
          ? <button className="backbtn" onClick={() => go('#/')} aria-label="Home">‹</button>
          : null}
        <div className="logo" onClick={() => go('#/')}>BL<span>I</span>TZ</div>
        <div className="microlabel topsub">Draft Room · 2026</div>
      </div>
      <InstallPrompt />
      {body}
    </>
  )
}

/* ============================================================
   LEAGUE loader — all state rebuilt from the database
   ============================================================ */
function League({ leagueId, uid }) {
  const [state, setState] = useState({ phase: 'loading' })
  const [connIssue, setConnIssue] = useState(false)
  const [showBoard, setShowBoard] = useState(false)
  const stateRef = useRef(state); stateRef.current = state

  const refetch = useCallback(async () => {
    try {
      const [lg, tm, dr] = await Promise.all([
        supabase.from('leagues').select('*').eq('id', leagueId).single(),
        supabase.from('teams').select('*').eq('league_id', leagueId).order('draft_slot', { ascending: true, nullsFirst: false }),
        supabase.from('drafts').select('*').eq('league_id', leagueId).single(),
      ])
      if (lg.error || tm.error || dr.error) throw new Error((lg.error || tm.error || dr.error).message)
      let picks = []
      if (dr.data.status !== 'pending') {
        const pk = await supabase.from('picks').select('*').eq('draft_id', dr.data.id).order('pick_no')
        if (pk.error) throw new Error(pk.error.message)
        picks = pk.data
      }
      setConnIssue(false)
      setState({ phase: 'ready', league: lg.data, teams: tm.data, draft: dr.data, picks })
    } catch (e) {
      if (stateRef.current.phase === 'ready') setConnIssue(true)
      else setState({ phase: 'error', message: e.message })
    }
  }, [leagueId])

  useEffect(() => {
    refetch()
    const ch = supabase.channel('league-' + leagueId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'picks' }, refetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'drafts' }, refetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'teams' }, refetch)
      .subscribe(s => {
        if (s === 'SUBSCRIBED') { setConnIssue(false); refetch() }
        if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') setConnIssue(true)
      })
    const poll = setInterval(refetch, 15000)
    const onVis = () => { if (!document.hidden) refetch() }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('online', refetch)
    return () => {
      supabase.removeChannel(ch); clearInterval(poll)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('online', refetch)
    }
  }, [leagueId, refetch])

  if (state.phase === 'loading') return <div className="loading"><span className="spinner" />Loading league…</div>
  if (state.phase === 'error') return (
    <div className="wrap">
      <div className="err">
        {/0 rows|no rows/i.test(state.message)
          ? "You're not in this league on this device. Go home and join with the league code, or use Recover."
          : state.message}
        <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
          <button className="btn small" onClick={refetch}>Retry</button>
          <button className="btn small secondary" onClick={() => go('#/')}>Home</button>
        </div>
      </div>
    </div>
  )

  const { league, teams, draft, picks } = state
  if (draft.status === 'pending') return <Lobby league={league} teams={teams} uid={uid} connIssue={connIssue} />
  if (draft.status === 'complete' && !showBoard) {
    return <SeasonWrap league={league} teams={teams} draft={draft} uid={uid}
             goDraft={() => setShowBoard(true)} />
  }
  return <DraftRoom league={league} teams={teams} draft={draft} picks={picks} uid={uid}
    connIssue={connIssue} refetch={refetch}
    backToSeason={draft.status === 'complete' ? () => setShowBoard(false) : null} />
}

/* ============================================================
   SEASON wrapper — loads players once, owns the player card
   ============================================================ */
function SeasonWrap({ league, teams, draft, uid, goDraft }) {
  const [players, setPlayers] = useState(null)
  const [card, setCard] = useState(null)
  const projKey = league.scoring === 'ppr' ? 'ppr' : league.scoring === 'half' ? 'half' : 'std'

  useEffect(() => {
    fetchAllPlayers().then(setPlayers).catch(() => setPlayers([]))
  }, [])

  if (!players) return <div className="loading"><span className="spinner" />Loading…</div>
  return (
    <>
      <Season league={league} teams={teams} draft={draft} uid={uid} players={players}
        onOpenPlayer={setCard} goDraft={goDraft} />
      {card && (
        <PlayerCard p={card} projKey={projKey} myTurn={false} busy={false}
          queued={false} onQueue={() => {}} onDraft={() => {}}
          onClose={() => setCard(null)} />
      )}
    </>
  )
}

/* ============================================================
   LOBBY
   ============================================================ */
function Lobby({ league, teams, uid, connIssue }) {
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editName, setEditName] = useState('')
  const isCommish = league.commissioner_uid === uid
  const myTeam = teams.find(t => t.owner_uid === uid)
  const shareUrl = window.location.origin + window.location.pathname + '#/join/' + league.join_code

  const call = async (fn, args) => {
    setBusy(true); setErr(null)
    const { error } = await supabase.rpc(fn, args)
    setBusy(false)
    if (error) setErr(error.message)
    return !error
  }

  return (
    <div className="wrap narrow">
      {connIssue && <div className="statusband reconnecting">Reconnecting… showing the last known state.</div>}

      <div className="lobbyhead">
        <h1>{league.name}</h1>
        <div className="microlabel">
          {league.scoring === 'ppr' ? 'Full PPR' : league.scoring === 'half' ? 'Half PPR' : 'Standard'}
          {' · '}{league.rounds} rounds{' · '}{league.pick_seconds}s clock
        </div>
      </div>

      {err && <div className="err">{err}</div>}

      <div className="card">
        <div className="microlabel mb8">Invite your league</div>
        <div className="sharebox">
          <code>{shareUrl}</code>
          <button className="btn small secondary" onClick={async () => {
            try { await navigator.clipboard.writeText(shareUrl); setCopied(true); setTimeout(() => setCopied(false), 1800) } catch {}
          }}>{copied ? 'Copied ✓' : 'Copy'}</button>
        </div>
        <p className="hint">Or read them the code: <strong>{league.join_code}</strong></p>
      </div>

      <div className="card">
        <div className="microlabel mb8">Teams — {teams.length} of {league.num_teams} joined</div>
        {teams.map(t => {
          const canEdit = isCommish || t.owner_uid === uid
          const canRemove = isCommish && t.owner_uid !== league.commissioner_uid
          return (
            <div className="teamline" key={t.id}>
              <div className="slotnum unset">{t.name.slice(0, 1).toUpperCase()}</div>
              {editingId === t.id ? (
                <>
                  <input className="inlineinput" value={editName} maxLength={40} autoFocus
                    onChange={e => setEditName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') call('rename_team', { p_team_id: t.id, p_name: editName }).then(ok => ok && setEditingId(null))
                      if (e.key === 'Escape') setEditingId(null)
                    }} />
                  <button className="btn small" disabled={busy}
                    onClick={() => call('rename_team', { p_team_id: t.id, p_name: editName }).then(ok => ok && setEditingId(null))}>Save</button>
                  <button className="btn small secondary" onClick={() => setEditingId(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <div className="tname">{t.name}</div>
                  {t.owner_uid === uid && <span className="tag">YOU</span>}
                  {t.owner_uid === league.commissioner_uid && <span className="tag blue">COMMISH</span>}
                  {canEdit && t.claim_code && <code className="claimcode">{t.claim_code}</code>}
                  {canEdit && <button className="qbtn" title="Rename"
                    onClick={() => { setEditingId(t.id); setEditName(t.name); setErr(null) }}>✎</button>}
                  {canRemove && <button className="qbtn danger" title="Remove"
                    onClick={() => { if (window.confirm(`Remove "${t.name}"?`)) call('remove_team', { p_team_id: t.id }) }}>✕</button>}
                </>
              )}
            </div>
          )
        })}
        {myTeam?.claim_code && (
          <div className="notice mt10">
            <strong>Your recovery code: {myTeam.claim_code}</strong><br />
            Write it down. If your phone dies mid-draft, that plus the league code gets your team back.
          </div>
        )}
      </div>

      {isCommish ? (
        <>
          <div className="notice">Draft order is randomised when you start. Anyone not in by then is left out.</div>
          <button className="btn block big danger" disabled={busy || teams.length < 2}
            onClick={async () => {
              if (!window.confirm(`Start the draft with ${teams.length} teams? Nobody else can join after this.`)) return
              await call('start_draft', { p_league_id: league.id })
            }}>
            {busy ? 'Starting…' : `Start draft with ${teams.length} ${teams.length === 1 ? 'team' : 'teams'}`}
          </button>
        </>
      ) : (
        <div className="notice">Waiting for the commissioner to start. This updates on its own.</div>
      )}
    </div>
  )
}

/* ============================================================
   DRAFT ROOM
   ============================================================ */

/* A compact, position-aware stat line for the list — last season's real numbers. */
function statLine(p, projKey) {
  const ly = p.lyd || {}, pr = p.projd || {}
  const bit = (v, lab) => v == null ? null : `${v} ${lab}`
  let parts = []
  if (p.pos === 'QB') {
    parts = [bit(ly.pass_yd, 'pass yd'), bit(ly.pass_td, 'TD'), bit(ly.rush_yd, 'rush yd')]
  } else if (p.pos === 'RB') {
    parts = [bit(ly.rush_yd, 'rush yd'), bit(ly.touch, 'touches'), bit(ly.ypc, 'ypc')]
  } else if (p.pos === 'WR' || p.pos === 'TE') {
    parts = [bit(ly.rec, 'rec'), bit(ly.rec_yd, 'yd'), bit(ly.tgt_share, '% tgt share')]
  }
  parts = parts.filter(Boolean)
  if (!parts.length) {
    if (pr.gp) return `${pr.gp} games projected`
    return 'No 2025 stats'
  }
  return "'25: " + parts.join(' · ')
}

const BOT_CAP = { QB: 2, RB: 6, WR: 7, TE: 2, K: 1, DEF: 1 }

function DraftRoom({ league, teams, draft, picks, uid, connIssue, refetch, backToSeason }) {
  const [players, setPlayers] = useState(null)
  const [playersErr, setPlayersErr] = useState(null)
  const [tab, setTab] = useState('players')
  const [q, setQ] = useState('')
  const [posSel, setPosSel] = useState(new Set())   // empty = all
  const [shown, setShown] = useState(75)
  const [rosterState, setRosterState] = useState(null)
  const [confirmP, setConfirmP] = useState(null)
  const [actErr, setActErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [queue, setQueue] = useState([])
  const [now, setNow] = useState(Date.now())
  const [showBoard, setShowBoard] = useState(false)
  const botTimer = useRef(null)

  const myTeam = teams.find(t => t.owner_uid === uid)
  const isCommish = league.commissioner_uid === uid
  const totalPicks = league.num_teams * league.rounds
  const done = draft.status === 'complete' || draft.current_pick > totalPicks

  const curSlot = done ? null : slotForPick(draft.current_pick, league.num_teams)
  const teamOnClock = done ? null : teams.find(t => t.draft_slot === curSlot)
  const myTurn = !!(myTeam && teamOnClock && teamOnClock.id === myTeam.id && draft.status === 'active')

  const takenIds = useMemo(() => new Set(picks.map(p => p.player_id)), [picks])
  const pickByNo = useMemo(() => new Map(picks.map(p => [p.pick_no, p])), [picks])
  const teamById = useMemo(() => new Map(teams.map(t => [t.id, t])), [teams])

  useEffect(() => {
    let live = true
    fetchAllPlayers()
      .then(rows => { if (live) setPlayers(rows) })
      .catch(e => { if (live) setPlayersErr(e.message) })
    return () => { live = false }
  }, [])

  useEffect(() => {
    if (!myTeam) return
    supabase.rpc('required_left', { p_team_id: myTeam.id })
      .then(({ data }) => setRosterState(data || null)).catch(() => {})
  }, [myTeam?.id, picks.length])

  const loadQueue = useCallback(async () => {
    if (!myTeam) return
    const { data } = await supabase.from('queues').select('*').eq('team_id', myTeam.id).order('rank')
    if (data) setQueue(data)
  }, [myTeam?.id])
  useEffect(() => { loadQueue() }, [loadQueue])

  const playerById = useMemo(() => new Map((players || []).map(p => [p.id, p])), [players])
  const projKey = league.scoring === 'ppr' ? 'ppr' : league.scoring === 'half' ? 'half' : 'std'

  /* ---- MOCK: this browser plays every computer team ---- */
  useEffect(() => {
    clearTimeout(botTimer.current)
    if (!league.is_mock || draft.status !== 'active' || done || !players) return
    if (!teamOnClock || teamOnClock.owner_uid === uid) return

    botTimer.current = setTimeout(async () => {
      const mine = picks.filter(p => p.team_id === teamOnClock.id)
      const counts = {}
      for (const pk of mine) {
        const pl = playerById.get(pk.player_id)
        if (pl) counts[pl.pos] = (counts[pl.pos] || 0) + 1
      }
      const round = roundOfPick(draft.current_pick, league.num_teams)
      const late = round > league.rounds - 3
      const cands = players
        .filter(p => !takenIds.has(p.id))
        .filter(p => (counts[p.pos] || 0) < (BOT_CAP[p.pos] ?? 99))
        .filter(p => late || (p.pos !== 'K' && p.pos !== 'DEF'))
        .sort((a, b) => (a.adp ?? 9999) - (b.adp ?? 9999) || (b[projKey] ?? 0) - (a[projKey] ?? 0))
      const pool = cands.slice(0, 3)
      const choice = pool[Math.floor(Math.random() * pool.length)] || cands[0]
      if (!choice) return
      await supabase.rpc('make_pick', {
        p_draft_id: draft.id, p_team_id: teamOnClock.id, p_player_id: choice.id,
      })
      refetch()
    }, 900 + Math.random() * 1600)

    return () => clearTimeout(botTimer.current)
  }, [league.is_mock, draft.current_pick, draft.status, done, players, teamOnClock?.id, uid])

  /* ---- server-clock autopick heartbeat (real leagues) ---- */
  useEffect(() => {
    if (draft.status !== 'active' || league.is_mock) return
    const iv = setInterval(() => {
      supabase.rpc('autopick_if_expired', { p_draft_id: draft.id })
        .then(({ data }) => { if (data?.fired) refetch() }).catch(() => {})
    }, 5000)
    return () => clearInterval(iv)
  }, [draft.id, draft.status, league.is_mock, refetch])

  useEffect(() => { const iv = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(iv) }, [])
  const deadlineMs = draft.pick_deadline ? new Date(draft.pick_deadline).getTime() : null
  const secsLeft = deadlineMs ? Math.max(0, Math.round((deadlineMs - now) / 1000)) : null

  const available = useMemo(() => {
    if (!players) return []
    let list = players.filter(p => !takenIds.has(p.id))
    if (posSel.size) list = list.filter(p => posSel.has(p.pos))
    if (q.trim()) {
      const s = q.trim().toLowerCase()
      list = list.filter(p => p.name.toLowerCase().includes(s) || (p.team || '').toLowerCase().includes(s))
    }
    return list.sort((a, b) => (a.adp ?? 9999) - (b.adp ?? 9999) || (b[projKey] ?? 0) - (a[projKey] ?? 0))
  }, [players, takenIds, posSel, q, projKey])
  useEffect(() => { setShown(75) }, [posSel, q])

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
    if (queue.find(x => x.player_id === p.id)) {
      await supabase.from('queues').delete().eq('team_id', myTeam.id).eq('player_id', p.id)
    } else {
      const max = queue.reduce((m, x) => Math.max(m, x.rank), 0)
      await supabase.from('queues').insert({ team_id: myTeam.id, player_id: p.id, rank: max + 1 })
    }
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
  const lastPick = picks[picks.length - 1]
  const lastPlayer = lastPick ? playerById.get(lastPick.player_id) : null

  return (
    <div className="wrap draftwrap">
      {connIssue && <div className="statusband reconnecting">Reconnecting… picks still go through.</div>}
      {league.is_mock && <div className="mockbar">MOCK DRAFT · COMPUTER PLAYS EVERY OTHER TEAM</div>}

      {/* ---- clock ---- */}
      {done ? (
        <div className="donebar">
          <div>
            <strong>Draft complete</strong>
            <span>{picks.length} picks · your roster is set</span>
          </div>
          {backToSeason && <button className="btn small" onClick={backToSeason}>Go to my team</button>}
        </div>
      ) : draft.status === 'paused' ? (
        <div className="statusband paused">Paused by the commissioner.</div>
      ) : (
        <div className={'clock' + (myTurn ? ' me' : '')}>
          <div className="cl">
            <div className="kick">{myTurn ? "You're on the clock" : 'On the clock'}</div>
            <div className="tm">{teamOnClock ? teamOnClock.name : '—'}</div>
            <div className="mt">Pick {draft.current_pick} of {totalPicks} · Round {roundOfPick(draft.current_pick, league.num_teams)}</div>
          </div>
          <div>
            <div className={'cd' + (secsLeft !== null && secsLeft <= 10 ? ' urgent' : '')}>
              {secsLeft != null ? `${Math.floor(secsLeft / 60)}:${String(secsLeft % 60).padStart(2, '0')}` : '—'}
            </div>
          </div>
        </div>
      )}

      {lastPlayer && !done && (
        <div className="feedline">
          <Avatar p={lastPlayer} size={30} />
          <span><strong>{teamById.get(lastPick.team_id)?.name}</strong> took <strong>{lastPlayer.name}</strong> {lastPlayer.pos} {lastPlayer.team}</span>
          {lastPick.auto && <span className="tag">AUTO</span>}
        </div>
      )}

      {actErr && <div className="err">{actErr}</div>}

      {isCommish && !done && (
        <div className="cbar">
          {draft.status === 'active' && <button className="btn small secondary" disabled={busy} onClick={() => commish('pause_draft')}>Pause</button>}
          {draft.status === 'paused' && <button className="btn small" disabled={busy} onClick={() => commish('resume_draft')}>Resume</button>}
          <button className="btn small secondary" disabled={busy || !picks.length}
            onClick={() => { if (window.confirm('Undo the last pick?')) commish('undo_last_pick') }}>Undo</button>
          {draft.status === 'active' && <button className="btn small secondary" disabled={busy} onClick={() => commish('extend_clock', { p_seconds: 30 })}>+30s</button>}
        </div>
      )}

      <div className="toptabs">
        <button className={tab === 'players' ? 'on' : ''} onClick={() => setTab('players')}>Players</button>
        <button className={tab === 'queue' ? 'on' : ''} onClick={() => setTab('queue')}>Queue{queue.length ? ` ${queue.length}` : ''}</button>
        <button className={tab === 'roster' ? 'on' : ''} onClick={() => setTab('roster')}>My team</button>
        <button className={tab === 'board' ? 'on' : ''} onClick={() => setTab('board')}>Board</button>
      </div>

      {tab === 'players' && (
        <div>
          {playersErr && <div className="err">Players failed to load: {playersErr}
            <button className="btn small" onClick={() => window.location.reload()}>Reload</button></div>}
          {!players && !playersErr && <div className="loading"><span className="spinner" />Loading players…</div>}
          {players && (
            <>
              {rosterState?.forced && (
                <div className="warnbar">
                  <strong>Roster lock</strong> — {rosterState.picks_left} pick{rosterState.picks_left === 1 ? '' : 's'} left
                  and you still need {[...new Set(rosterState.missing || [])].join(', ')}
                  {rosterState.flex_need > 0 ? (rosterState.missing?.length ? ' + flex' : 'a flex (RB/WR/TE)') : ''}.
                  Only those can be drafted now.
                </div>
              )}
              {rosterState && !rosterState.forced && rosterState.owed > 0 && (
                <div className="needline">
                  Still to fill: {[...new Set(rosterState.missing || [])].join(', ') || '—'}
                  {rosterState.flex_need > 0 ? ' + flex' : ''}
                  <span> · {rosterState.picks_left} picks left</span>
                </div>
              )}
              <div className="searchwrap"><input className="search" placeholder="Search players" value={q} onChange={e => setQ(e.target.value)} /></div>
              <div className="chips">
                <button className={posSel.size === 0 ? 'on' : ''} onClick={() => setPosSel(new Set())}>ALL</button>
                {['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map(pos => (
                  <button key={pos} className={posSel.has(pos) ? 'on' : ''}
                    onClick={() => setPosSel(prev => {
                      const next = new Set(prev)
                      next.has(pos) ? next.delete(pos) : next.add(pos)
                      return next
                    })}>{pos}</button>
                ))}
                
              </div>
              <div className="plist">
                {available.slice(0, shown).map((p, i) => (
                  <div className="row tap nopad" key={p.id} onClick={() => setConfirmP(p)}>
                    <div className="rankcell">{p.pos}{p.prank ?? ''}</div>
                    <Avatar p={p} size={38} eager={i < 15} />
                    <div className="who">
                      <div className="nm">
                        {p.name}
                        <span className={'pos pos-' + p.pos}>{p.pos}</span>
                        {p.inj && <span className="qflag">{p.inj.slice(0, 1)}</span>}
                      </div>
                      <div className="sub">
                        {p.team || 'FA'}<span className="dot">·</span>Bye {p.bye ?? '—'}
                        <span className="dot">·</span>{statLine(p, projKey)}
                      </div>
                    </div>
                    <button className={'rowbtn star' + (queueIds.has(p.id) ? ' on' : '')}
                      onClick={e => { e.stopPropagation(); toggleQueue(p) }} title="Queue">★</button>
                    <button className="rowbtn add" disabled={!myTurn || busy} title="Draft"
                      onClick={e => { e.stopPropagation(); doPick(p) }}>+</button>
                    <div className="nums">
                      <div className="num"><b>{p[projKey] ?? '—'}</b><s>PROJ</s></div>
                      <div className="num"><b>{p.adp ?? '—'}</b><s>ADP</s></div>
                    </div>
                  </div>
                ))}
              </div>
              {available.length > shown && (
                <button className="btn block secondary" onClick={() => setShown(n => n + 100)}>
                  Show more — {available.length - shown} left
                </button>
              )}
              {!available.length && <div className="hint pad">No players match.</div>}
            </>
          )}
        </div>
      )}

      {tab === 'queue' && (
        <div>
          {!queue.length && <div className="empty"><strong>Queue is empty</strong>
            <p>Star players on the Players tab. If your clock runs out, autopick takes from here first.</p></div>}
          <div className="plist">
            {queue.map((x, i) => {
              const p = playerById.get(x.player_id)
              const gone = takenIds.has(x.player_id)
              if (!p) return null
              return (
                <div className={'row' + (gone ? ' dim' : '')} key={x.player_id}>
                  <div className="rankcell">{i + 1}</div>
                  <Avatar p={p} size={38} />
                  <div className="who">
                    <div className="nm">{p.name}<span className={'pos pos-' + p.pos}>{p.pos}</span></div>
                    <div className="sub">{p.team || 'FA'}{gone ? ' · taken' : ''}</div>
                  </div>
                  <button className="rowbtn" onClick={() => toggleQueue(p)}>✕</button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {tab === 'roster' && (
        <div>
          {!myTeam && <div className="hint pad">You're watching this draft — you don't have a team in it.</div>}
          {myTeam && !myPicks.length && <div className="empty"><strong>No picks yet</strong><p>Your roster builds here as you draft.</p></div>}
          <div className="plist">
            {myPicks.map(pk => {
              const p = playerById.get(pk.player_id)
              if (!p) return null
              return (
                <div className="row nopad" key={pk.id}>
                  <div className="rankcell">R{roundOfPick(pk.pick_no, league.num_teams)}</div>
                  <Avatar p={p} size={38} />
                  <div className="who">
                    <div className="nm">{p.name}<span className={'pos pos-' + p.pos}>{p.pos}</span></div>
                    <div className="sub">{p.team || 'FA'}<span className="dot">·</span>Bye {p.bye ?? '—'}</div>
                  </div>
                  <div className="nums"><div className="num"><b>{p[projKey] ?? '—'}</b><s>PROJ</s></div></div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {tab === 'board' && (
        <div>
          <div className="boardscroll">
            <table className="board">
              <thead><tr><th className="rc"></th>
                {teams.map(t => <th key={t.id}>{t.name.slice(0, 11)}</th>)}
              </tr></thead>
              <tbody>
                {Array.from({ length: league.rounds }, (_, r) => r + 1).map(round => (
                  <tr key={round}>
                    <td className="rc">{round}</td>
                    {teams.map(t => {
                      const inRound = round % 2 === 1 ? t.draft_slot : league.num_teams - t.draft_slot + 1
                      const pickNo = (round - 1) * league.num_teams + inRound
                      const pk = pickByNo.get(pickNo)
                      const pl = pk ? playerById.get(pk.player_id) : null
                      const cur = !done && pickNo === draft.current_pick
                      return (
                        <td key={t.id} className={(cur ? 'current ' : '') + ''}>
                          {pl ? (<>
                            <span className="bname">{pl.name}</span>
                            <span className="bmeta">{pl.pos} · {pl.team || 'FA'}</span>
                          </>) : <span className="bmeta">{pickNo}</span>}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {confirmP && (
        <PlayerCard
          p={confirmP} projKey={projKey} myTurn={myTurn} busy={busy}
          queued={queueIds.has(confirmP.id)}
          onQueue={() => toggleQueue(confirmP)}
          onDraft={() => doPick(confirmP)}
          onClose={() => setConfirmP(null)}
        />
      )}
    </div>
  )
}
