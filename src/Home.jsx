import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from './supabase.js'

const go = (h) => { window.location.hash = h }

/* ============================================================
   HOME — my leagues, mock draft, create, join.
   ============================================================ */
export default function Home({ uid, prefillCode }) {
  const [leagues, setLeagues] = useState(null)
  const [sheet, setSheet] = useState(prefillCode ? 'join' : null)
  const [err, setErr] = useState(null)

  const load = useCallback(async () => {
    const { data: teams } = await supabase
      .from('teams').select('id,name,league_id,draft_slot').eq('owner_uid', uid)
    if (!teams) { setLeagues([]); return }
    const ids = teams.map(t => t.league_id)
    if (!ids.length) { setLeagues([]); return }
    const [{ data: lgs }, { data: drafts }] = await Promise.all([
      supabase.from('leagues').select('*').in('id', ids),
      supabase.from('drafts').select('league_id,status,current_pick').in('league_id', ids),
    ])
    const dmap = new Map((drafts || []).map(d => [d.league_id, d]))
    const rows = (lgs || []).map(l => ({
      ...l,
      myTeam: teams.find(t => t.league_id === l.id),
      draft: dmap.get(l.id),
    })).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    setLeagues(rows)
  }, [uid])

  useEffect(() => { load() }, [load])

  const remove = async (l) => {
    if (!window.confirm(`Delete "${l.name}"? This wipes the league and its draft for everyone.`)) return
    const { error } = await supabase.rpc('delete_league', { p_league_id: l.id })
    if (error) setErr(error.message); else load()
  }

  return (
    <>
      <div className="hero">
        <div className="hero-in">
          <div className="hero-kicker">2026 season</div>
          <h1 className="hero-h1">Draft day starts here</h1>
          <p className="hero-sub">Real projections, live board, no spreadsheet.</p>
        </div>
      </div>

      <div className="wrap">
        {err && <div className="err">{err}</div>}

        <div className="actiongrid">
          <button className="action primary" onClick={() => setSheet('mock')}>
            <span className="a-ic">⚡</span>
            <span className="a-t">Mock draft</span>
            <span className="a-s">Draft against the computer, right now</span>
          </button>
          <button className="action" onClick={() => setSheet('create')}>
            <span className="a-ic">🏈</span>
            <span className="a-t">Create a league</span>
            <span className="a-s">Invite your friends</span>
          </button>
          <button className="action" onClick={() => setSheet('join')}>
            <span className="a-ic">＋</span>
            <span className="a-t">Join a league</span>
            <span className="a-s">Got a code or a link?</span>
          </button>
          <button className="action" onClick={() => setSheet('recover')}>
            <span className="a-ic">↺</span>
            <span className="a-t">Recover my team</span>
            <span className="a-s">New phone or cleared browser</span>
          </button>
        </div>

        <div className="sectionhead">
          <h2>My leagues</h2>
          {leagues && <span className="microlabel">{leagues.length}</span>}
        </div>

        {leagues === null && <div className="loading"><span className="spinner" />Loading…</div>}

        {leagues && leagues.length === 0 && (
          <div className="empty">
            <div className="empty-ic">🏈</div>
            <strong>No leagues yet</strong>
            <p>Run a mock draft to try it out, or create a league and send your friends the link.</p>
          </div>
        )}

        {leagues && leagues.map(l => {
          const st = l.draft?.status || 'pending'
          const label = st === 'pending' ? 'Waiting to start'
            : st === 'active' ? `Drafting · pick ${l.draft.current_pick}`
            : st === 'paused' ? 'Paused' : 'Draft complete'
          return (
            <div className="leaguecard" key={l.id} onClick={() => go('#/league/' + l.id)}>
              <div className="lc-main">
                <div className="lc-top">
                  <strong className="lc-name">{l.name}</strong>
                  {l.is_mock && <span className="tag mock">MOCK</span>}
                  {l.commissioner_uid === uid && <span className="tag">COMMISH</span>}
                </div>
                <div className="lc-meta">{l.myTeam?.name} · {l.num_teams} teams · {l.rounds} rds · {l.scoring.toUpperCase()}</div>
                <div className={'lc-status s-' + st}>{label}</div>
              </div>
              {l.commissioner_uid === uid && (
                <button className="lc-del" title="Delete league"
                  onClick={e => { e.stopPropagation(); remove(l) }}>✕</button>
              )}
            </div>
          )
        })}
      </div>

      {sheet && <Sheet kind={sheet} close={() => setSheet(null)} prefillCode={prefillCode} onErr={setErr} />}
    </>
  )
}

/* ============================================================
   Bottom sheet forms
   ============================================================ */
function Sheet({ kind, close, prefillCode, onErr }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const [name, setName] = useState('')
  const [teamName, setTeamName] = useState('')
  const [numTeams, setNumTeams] = useState(10)
  const [rounds, setRounds] = useState(15)
  const [scoring, setScoring] = useState('ppr')
  const [secs, setSecs] = useState(90)
  const [slot, setSlot] = useState(1)
  const [code, setCode] = useState(prefillCode || '')
  const [claim, setClaim] = useState('')

  const run = async (fn, args, onOk) => {
    setBusy(true); setErr(null)
    const { data, error } = await supabase.rpc(fn, args)
    setBusy(false)
    if (error) { setErr(error.message); return }
    onOk(data)
  }

  const titles = {
    mock: 'Mock draft', create: 'Create a league',
    join: 'Join a league', recover: 'Recover my team',
  }

  return (
    <div className="sheetback" onClick={() => !busy && close()}>
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="sheet-grab" />
        <button className="sheet-close" onClick={close} aria-label="Close">✕</button>
        <h3>{titles[kind]}</h3>
        {err && <div className="err">{err}</div>}

        {kind === 'mock' && (
          <>
            <p className="sheet-note">Every other seat is filled by the computer. It starts the moment you tap.</p>
            <div className="row2">
              <Field label="Teams">
                <select value={numTeams} onChange={e => setNumTeams(+e.target.value)}>
                  {[4, 6, 8, 10, 12, 14, 16].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </Field>
              <Field label="Your pick">
                <select value={slot} onChange={e => setSlot(+e.target.value)}>
                  {Array.from({ length: numTeams }, (_, i) => i + 1).map(n =>
                    <option key={n} value={n}>{n}{n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}</option>)}
                </select>
              </Field>
            </div>
            <div className="row2">
              <Field label="Rounds">
                <select value={rounds} onChange={e => setRounds(+e.target.value)}>
                  {[8, 10, 12, 14, 15, 16].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </Field>
              <Field label="Scoring">
                <select value={scoring} onChange={e => setScoring(e.target.value)}>
                  <option value="ppr">Full PPR</option><option value="half">Half PPR</option><option value="std">Standard</option>
                </select>
              </Field>
            </div>
            <Field label="Clock">
              <select value={secs} onChange={e => setSecs(+e.target.value)}>
                <option value={30}>30 seconds</option><option value={60}>60 seconds</option>
                <option value={90}>90 seconds</option><option value={180}>3 minutes</option>
                <option value={600}>10 minutes (take your time)</option>
              </select>
            </Field>
            <button className="btn block big" disabled={busy}
              onClick={() => run('create_mock_draft', {
                p_num_teams: numTeams, p_rounds: rounds, p_scoring: scoring,
                p_pick_seconds: secs, p_my_slot: Math.min(slot, numTeams), p_team_name: 'My Team',
              }, d => go('#/league/' + d.league_id))}>
              {busy ? 'Setting up…' : 'Start mock draft'}
            </button>
          </>
        )}

        {kind === 'create' && (
          <>
            <Field label="League name"><input value={name} onChange={e => setName(e.target.value)} placeholder="The Boys 2026" /></Field>
            <Field label="Your team name"><input value={teamName} onChange={e => setTeamName(e.target.value)} placeholder="Team name" /></Field>
            <div className="row2">
              <Field label="Teams">
                <select value={numTeams} onChange={e => setNumTeams(+e.target.value)}>
                  {[4, 6, 8, 10, 12, 14, 16].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </Field>
              <Field label="Rounds">
                <select value={rounds} onChange={e => setRounds(+e.target.value)}>
                  {[8, 10, 12, 14, 15, 16, 18, 20].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </Field>
            </div>
            <div className="row2">
              <Field label="Scoring">
                <select value={scoring} onChange={e => setScoring(e.target.value)}>
                  <option value="ppr">Full PPR</option><option value="half">Half PPR</option><option value="std">Standard</option>
                </select>
              </Field>
              <Field label="Clock">
                <select value={secs} onChange={e => setSecs(+e.target.value)}>
                  {[30, 60, 90, 120, 180, 300].map(n => <option key={n} value={n}>{n}s</option>)}
                </select>
              </Field>
            </div>
            <button className="btn block big" disabled={busy || !name.trim() || !teamName.trim()}
              onClick={() => run('create_league', {
                p_name: name, p_num_teams: numTeams, p_rounds: rounds, p_scoring: scoring,
                p_pick_seconds: secs, p_team_name: teamName,
              }, d => go('#/league/' + d.league_id))}>
              {busy ? 'Creating…' : 'Create league'}
            </button>
          </>
        )}

        {kind === 'join' && (
          <>
            <Field label="League code"><input value={code} onChange={e => setCode(e.target.value)} placeholder="8-character code" /></Field>
            <Field label="Your team name"><input value={teamName} onChange={e => setTeamName(e.target.value)} placeholder="Team name" /></Field>
            <button className="btn block big" disabled={busy || !code.trim()}
              onClick={() => run('join_league', { p_join_code: code, p_team_name: teamName },
                d => go('#/league/' + d.league_id))}>
              {busy ? 'Joining…' : 'Join league'}
            </button>
          </>
        )}

        {kind === 'recover' && (
          <>
            <p className="sheet-note">New phone, cleared browser, or lost your team? Your recovery code puts you back on it.</p>
            <Field label="League code"><input value={code} onChange={e => setCode(e.target.value)} placeholder="8-character code" /></Field>
            <Field label="Recovery code">
              <input value={claim} onChange={e => setClaim(e.target.value.toUpperCase())} maxLength={5}
                placeholder="5 characters" style={{ textTransform: 'uppercase', letterSpacing: '.15em' }} />
            </Field>
            <button className="btn block big" disabled={busy || !code.trim() || claim.length < 5}
              onClick={() => run('claim_team', { p_join_code: code, p_claim_code: claim },
                d => go('#/league/' + d.league_id))}>
              {busy ? 'Recovering…' : 'Get my team back'}
            </button>
          </>
        )}

        <button className="btn block secondary" onClick={close} disabled={busy}>Cancel</button>
      </div>
    </div>
  )
}

function Field({ label, children }) {
  return <div className="field"><label className="microlabel">{label}</label>{children}</div>
}
