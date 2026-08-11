import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from './supabase.js'

const go = (h) => { window.location.hash = h }

export default function Home({ uid, prefillCode }) {
  const [leagues, setLeagues] = useState(null)
  const [sheet, setSheet] = useState(prefillCode ? 'join' : null)
  const [err, setErr] = useState(null)
  const [confirmDel, setConfirmDel] = useState(null)
  const [busyDel, setBusyDel] = useState(false)

  const load = useCallback(async () => {
    const { data: teams } = await supabase
      .from('teams').select('id,name,league_id,draft_slot').eq('owner_uid', uid)
    const ids = (teams || []).map(t => t.league_id)
    if (!ids.length) { setLeagues([]); return }
    const [{ data: lgs }, { data: drafts }] = await Promise.all([
      supabase.from('leagues').select('*').in('id', ids),
      supabase.from('drafts').select('league_id,status,current_pick').in('league_id', ids),
    ])
    const dmap = new Map((drafts || []).map(d => [d.league_id, d]))
    setLeagues((lgs || []).map(l => ({
      ...l, myTeam: teams.find(t => t.league_id === l.id), draft: dmap.get(l.id),
    })).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)))
  }, [uid])

  useEffect(() => { load() }, [load])

  const remove = async (l) => {
    setBusyDel(true); setErr(null)
    const { error } = await supabase.rpc('delete_league', { p_league_id: l.id })
    setBusyDel(false); setConfirmDel(null)
    if (error) setErr(error.message); else load()
  }

  const removeAllMocks = async () => {
    setBusyDel(true); setErr(null)
    const mocks = (leagues || []).filter(l => l.is_mock && l.commissioner_uid === uid)
    for (const m of mocks) {
      const { error } = await supabase.rpc('delete_league', { p_league_id: m.id })
      if (error) { setErr(error.message); break }
    }
    setBusyDel(false); setConfirmDel(null)
    load()
  }

  return (
    <div className="wrap">
      <div className="homeactions">
        <button className="key" onClick={() => setSheet('mock')}>Mock Draft</button>
        <button onClick={() => setSheet('create')}>Create League</button>
        <button onClick={() => setSheet('join')}>Join League</button>
        <button onClick={() => setSheet('recover')}>Recover Team</button>
      </div>

      {err && <div className="err">{err}</div>}

      <div className="sect">
        <h2>My Leagues</h2>
        {leagues && leagues.some(l => l.is_mock && l.commissioner_uid === uid)
          ? <button className="linkbtn" onClick={() => setConfirmDel('ALL_MOCKS')}>Clear mock drafts</button>
          : leagues && <span className="right">{leagues.length}</span>}
      </div>

      {leagues === null && <div className="loading"><span className="spinner" />Loading</div>}

      {leagues && !leagues.length && (
        <div className="empty">
          <strong>No leagues yet</strong>
          <p>Run a mock draft to try it, or create a league and send the link to your friends.</p>
        </div>
      )}

      {leagues && leagues.map(l => {
        const st = l.draft?.status || 'pending'
        const label = st === 'pending' ? 'Waiting to start'
          : st === 'active' ? `Drafting · pick ${l.draft.current_pick}`
          : st === 'paused' ? 'Paused' : 'Draft complete'
        return (
          <div className="lgrow" key={l.id} onClick={() => go('#/league/' + l.id)}>
            <div className="lgcrest">{l.name.slice(0, 1).toUpperCase()}</div>
            <div className="who">
              <div className="lgname">
                {l.name}
                {l.is_mock && <span className="badge mock">MOCK</span>}
                {l.commissioner_uid === uid && <span className="badge you">COMMISH</span>}
              </div>
              <div className="lgmeta">
                {l.myTeam?.name}<span className="dot">·</span>{l.num_teams} teams
                <span className="dot">·</span>{l.rounds} rds<span className="dot">·</span>{l.scoring.toUpperCase()}
              </div>
              <div className={'lgstate s-' + st}>{label}</div>
            </div>
            {l.commissioner_uid === uid && (
              <button className="delbtn" aria-label={'Delete ' + l.name}
                onClick={e => { e.stopPropagation(); setConfirmDel(l) }}>Delete</button>
            )}
          </div>
        )
      })}

      {sheet && <Sheet kind={sheet} close={() => setSheet(null)} prefillCode={prefillCode} />}

      {confirmDel && (
        <div className="sheetback" onClick={() => !busyDel && setConfirmDel(null)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <div className="sheet-grab" />
            <h3>{confirmDel === 'ALL_MOCKS' ? 'Clear mock drafts?' : 'Delete this league?'}</h3>
            <p className="sheet-note">
              {confirmDel === 'ALL_MOCKS'
                ? `This removes every mock draft you created — ${(leagues || []).filter(l => l.is_mock && l.commissioner_uid === uid).length} of them. Real leagues are untouched.`
                : `"${confirmDel.name}" and its draft will be gone for everyone in it. This can't be undone.`}
            </p>
            <button className="btn block big danger" disabled={busyDel}
              onClick={() => confirmDel === 'ALL_MOCKS' ? removeAllMocks() : remove(confirmDel)}>
              {busyDel ? 'Deleting…' : (confirmDel === 'ALL_MOCKS' ? 'Clear them' : 'Delete')}
            </button>
            <button className="btn block secondary" disabled={busyDel}
              onClick={() => setConfirmDel(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

function Sheet({ kind, close, prefillCode }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [name, setName] = useState('')
  const [teamName, setTeamName] = useState('')
  const [numTeams, setNumTeams] = useState(10)
  const rounds = 15   // BLITZ drafts are always 15 rounds
  const [scoring, setScoring] = useState('ppr')
  const [secs, setSecs] = useState(90)
  const [slot, setSlot] = useState(1)
  const [code, setCode] = useState(prefillCode || '')
  const [claim, setClaim] = useState('')
  const [flexTE, setFlexTE] = useState(false)

  const run = async (fn, args, onOk) => {
    setBusy(true); setErr(null)
    const { data, error } = await supabase.rpc(fn, args)
    setBusy(false)
    if (error) { setErr(error.message); return }
    onOk(data)
  }
  const titles = { mock: 'Mock Draft', create: 'Create League', join: 'Join League', recover: 'Recover Team' }

  return (
    <div className="sheetback" onClick={() => !busy && close()}>
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="sheet-grab" />
        <button className="sheet-close" onClick={close} aria-label="Close">✕</button>
        <h3>{titles[kind]}</h3>
        {err && <div className="err" style={{ margin: '0 0 12px' }}>{err}</div>}

        {kind === 'mock' && (
          <>
            <p className="sheet-note">Every other seat is played by the computer. Starts immediately.</p>
            <div className="row2">
              <F label="Teams"><select value={numTeams} onChange={e => setNumTeams(+e.target.value)}>
                {[4, 6, 8, 10, 12, 14, 16].map(n => <option key={n} value={n}>{n}</option>)}</select></F>
              <F label="Your pick"><select value={slot} onChange={e => setSlot(+e.target.value)}>
                {Array.from({ length: numTeams }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}</option>)}</select></F>
            </div>
            <div className="row2">
              <F label="Rounds"><div className="fixedval">15</div></F>
              <F label="Scoring"><select value={scoring} onChange={e => setScoring(e.target.value)}>
                <option value="ppr">Full PPR</option><option value="half">Half PPR</option><option value="std">Standard</option>
              </select></F>
            </div>
            <F label="Clock"><select value={secs} onChange={e => setSecs(+e.target.value)}>
              <option value={30}>30 seconds</option><option value={60}>60 seconds</option>
              <option value={90}>90 seconds</option><option value={180}>3 minutes</option>
              <option value={600}>10 minutes</option></select></F>
            <button className="btn block big" disabled={busy}
              onClick={() => run('create_mock_draft', {
                p_num_teams: numTeams, p_rounds: 15, p_scoring: scoring,
                p_pick_seconds: secs, p_my_slot: Math.min(slot, numTeams), p_team_name: 'My Team',
              }, d => go('#/league/' + d.league_id))}>
              {busy ? 'Setting up' : 'Start Mock Draft'}
            </button>
          </>
        )}

        {kind === 'create' && (
          <>
            <F label="League name"><input value={name} onChange={e => setName(e.target.value)} /></F>
            <F label="Your team name"><input value={teamName} onChange={e => setTeamName(e.target.value)} /></F>
            <div className="row2">
              <F label="Teams"><select value={numTeams} onChange={e => setNumTeams(+e.target.value)}>
                {[4, 6, 8, 10, 12, 14, 16].map(n => <option key={n} value={n}>{n}</option>)}</select></F>
              <F label="Rounds"><div className="fixedval">15</div></F>
            </div>
            <div className="row2">
              <F label="Scoring"><select value={scoring} onChange={e => setScoring(e.target.value)}>
                <option value="ppr">Full PPR</option><option value="half">Half PPR</option><option value="std">Standard</option>
              </select></F>
              <F label="Clock"><select value={secs} onChange={e => setSecs(+e.target.value)}>
                {[30, 60, 90, 120, 180, 300].map(n => <option key={n} value={n}>{n}s</option>)}</select></F>
            </div>
            <label className="togglerow">
              <input type="checkbox" checked={flexTE} onChange={e => setFlexTE(e.target.checked)} />
              <span>
                <strong>Tight ends can fill the flex</strong>
                <small>Off = flex is RB/WR only</small>
              </span>
            </label>
            <button className="btn block big" disabled={busy || !name.trim() || !teamName.trim()}
              onClick={() => run('create_league', {
                p_name: name, p_num_teams: numTeams, p_rounds: 15, p_scoring: scoring,
                p_pick_seconds: secs, p_team_name: teamName,
              }, async d => {
                if (flexTE) await supabase.rpc('set_flex_te', { p_league_id: d.league_id, p_on: true })
                go('#/league/' + d.league_id)
              })}>
              {busy ? 'Creating' : 'Create League'}
            </button>
          </>
        )}

        {kind === 'join' && (
          <>
            <F label="League code"><input value={code} onChange={e => setCode(e.target.value)} /></F>
            <F label="Your team name"><input value={teamName} onChange={e => setTeamName(e.target.value)} /></F>
            <button className="btn block big" disabled={busy || !code.trim()}
              onClick={() => run('join_league', { p_join_code: code, p_team_name: teamName },
                d => go('#/league/' + d.league_id))}>
              {busy ? 'Joining' : 'Join League'}
            </button>
          </>
        )}

        {kind === 'recover' && (
          <>
            <p className="sheet-note">New phone or cleared browser? Your recovery code puts you back on your team.</p>
            <F label="League code"><input value={code} onChange={e => setCode(e.target.value)} /></F>
            <F label="Recovery code"><input value={claim} maxLength={5}
              onChange={e => setClaim(e.target.value.toUpperCase())}
              style={{ textTransform: 'uppercase', letterSpacing: '.15em' }} /></F>
            <button className="btn block big" disabled={busy || !code.trim() || claim.length < 5}
              onClick={() => run('claim_team', { p_join_code: code, p_claim_code: claim },
                d => go('#/league/' + d.league_id))}>
              {busy ? 'Recovering' : 'Get My Team Back'}
            </button>
          </>
        )}

        <button className="btn block secondary" onClick={close} disabled={busy}>Cancel</button>
      </div>
    </div>
  )
}

const F = ({ label, children }) => (
  <div className="field"><label className="microlabel">{label}</label>{children}</div>
)
