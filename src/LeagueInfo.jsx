import { useEffect, useMemo, useState } from 'react'
import { supabase } from './supabase'

/* League Info — ESPN's blueprint.
   The whole screen is drawn from blitz_setting_spec() in the database,
   so a setting added there shows up here with no code change. Values
   come from league_settings(), which reads the real columns the draft
   engine uses — what you read here is what the engine does. */

const fmtDate = (iso) => {
  if (!iso) return 'Not set'
  const d = new Date(iso)
  if (isNaN(d)) return 'Not set'
  return d.toLocaleString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

/* dotted path lookup: "scoring.passing.PTD" */
const at = (obj, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), obj)

function display(spec, value) {
  if (spec.type === 'ts') return fmtDate(value)
  if (value === null || value === undefined) return spec.null_label || 'None'
  if (spec.type === 'bool') return value ? 'Yes' : 'No'
  if (spec.options) {
    const hit = spec.options.find(o => o[0] === value)
    if (hit) return hit[1]
  }
  if (spec.idp) return `${value} (No Limit)`
  if (spec.cap) return `${value} (${spec.cap} max)`
  return String(value)
}

export default function LeagueInfo({ league, teams, uid, onClose, startTab }) {
  const [tab, setTab] = useState(startTab || 'league')
  const [spec, setSpec] = useState(null)
  const [vals, setVals] = useState(null)
  const [activity, setActivity] = useState(null)
  const [edit, setEdit] = useState(null)      // the spec row being changed
  const [err, setErr] = useState(null)

  const load = async () => {
    const [s, v] = await Promise.all([
      supabase.rpc('blitz_setting_spec'),
      supabase.rpc('league_settings', { p_league_id: league.id }),
    ])
    if (s.error) return setErr(s.error.message)
    if (v.error) return setErr(v.error.message)
    setSpec(s.data); setVals(v.data)
  }
  useEffect(() => { load() }, [league.id])

  useEffect(() => {
    if (tab !== 'activity') return
    supabase.from('league_activity')
      .select('id,kind,body,created_at')
      .eq('league_id', league.id)
      .order('created_at', { ascending: false })
      .limit(100)
      .then(({ data, error }) => { if (!error) setActivity(data || []) })
  }, [tab, league.id])

  const isCommish = vals?.meta?.is_commish
  const draftLocked = vals?.meta?.draft_locked

  /* group the spec the way ESPN lays the page out */
  const sections = useMemo(() => {
    if (!spec) return []
    const out = []
    for (const row of spec) {
      let sec = out.find(s => s.name === row.sect)
      if (!sec) { sec = { name: row.sect, groups: [] }; out.push(sec) }
      const gname = row.grp || ''
      let grp = sec.groups.find(g => g.name === gname)
      if (!grp) { grp = { name: gname, rows: [] }; sec.groups.push(grp) }
      grp.rows.push(row)
    }
    return out
  }, [spec])

  const canEdit = (row) =>
    isCommish && row.type !== 'readonly' && !row.idp &&
    !(row.lock === 'draft' && draftLocked)

  const save = async (row, value) => {
    setErr(null)
    const { error } = await supabase.rpc('set_league_option', {
      p_league_id: league.id, p_path: row.path, p_value: value,
    })
    if (error) { setErr(error.message); return false }
    await load()
    setEdit(null)
    return true
  }

  if (err && !spec) return (
    <div className="wrap">
      <div className="sect"><h1>League Info</h1></div>
      <div className="err">{err}</div>
      <div className="px"><button className="btn block secondary" onClick={onClose}>Back</button></div>
    </div>
  )
  if (!spec || !vals) return <div className="loading"><span className="spinner" />Loading settings…</div>

  return (
    <div className="wrap">
      <div className="sect">
        <div>
          <h1>League Info</h1>
          <div className="microlabel">{vals.basic.name}</div>
        </div>
        <button className="btn small secondary" onClick={onClose}>Done</button>
      </div>

      <div className="toptabs">
        <button className={tab === 'league' ? 'on' : ''} onClick={() => setTab('league')}>League</button>
        <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>History</button>
        <button className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>Activity</button>
      </div>

      {err && <div className="err">{err}</div>}

      {tab === 'league' && (
        <div className="px">
          {!isCommish && (
            <p className="lockline">
              Only the league manager can change these.
            </p>
          )}
          {isCommish && draftLocked && (
            <p className="lockline">
              The draft has started, so the roster, team count and draft settings are locked in.
            </p>
          )}

          {sections.map(sec => (
            <div className="infocard" key={sec.name}>
              <div className="infohead">{sec.name}</div>
              {sec.name === 'ROSTER' && (
                <div className="infonote">
                  {vals.roster.QB + vals.roster.RB + vals.roster.WR + vals.roster.TE +
                   vals.roster.RBWR + vals.roster.K + vals.roster.DEF} starters
                  {' · '}{vals.roster.BE} bench{' · '}{vals.meta.rounds} draft rounds
                </div>
              )}
              {sec.groups.map(grp => (
                <div key={grp.name || 'x'}>
                  {grp.name && <div className="infogrp">{grp.name}</div>}
                  {grp.rows.map(row => {
                    const raw = at(vals, row.path)
                    const shown = display(row, raw)
                    const editable = canEdit(row)
                    const neg = typeof raw === 'number' && raw < 0
                    return (
                      <button
                        key={row.path}
                        className={'inforow' + (editable ? ' tap' : '') + (row.idp ? ' idp' : '')}
                        disabled={!editable}
                        onClick={() => editable && setEdit(row)}
                      >
                        <span className="infolabel">{row.label}</span>
                        <span className={'infoval' + (neg ? ' neg' : '')}>
                          {shown}{editable && <i className="chev">›</i>}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {tab === 'history' && (
        <div className="px">
          <div className="infocard">
            <div className="infohead">THIS SEASON</div>
            <div className="inforow"><span className="infolabel">Season</span><span className="infoval">2026</span></div>
            <div className="inforow"><span className="infolabel">Teams</span><span className="infoval">{teams.length}</span></div>
            <div className="inforow"><span className="infolabel">Draft</span><span className="infoval">{fmtDate(vals.draft.at)}</span></div>
            <div className="inforow"><span className="infolabel">Regular Season Matchups</span><span className="infoval">{vals.schedule.regular_matchups}</span></div>
            <div className="inforow"><span className="infolabel">Playoff Teams</span><span className="infoval">{vals.playoffs.teams}</span></div>
          </div>
          <div className="notice">
            This is season one, so there is no history to show yet. Final standings,
            champions and each manager's year-by-year record start filling in here
            once a season finishes.
          </div>
        </div>
      )}

      {tab === 'activity' && (
        <div>
          {activity === null && <div className="loading"><span className="spinner" />Loading…</div>}
          {activity && activity.length === 0 && (
            <div className="empty"><strong>Nothing yet</strong>
              <p>Settings changes, team renames, draft picks and roster moves show up here.</p></div>
          )}
          {activity && activity.map(a => (
            <div className="row nopad" key={a.id}>
              <div className="who">
                <div className="nm">{a.body}</div>
                <div className="sub">{new Date(a.created_at).toLocaleString(undefined,
                  { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {edit && <EditSheet row={edit} current={at(vals, edit.path)} close={() => setEdit(null)} save={save} />}
    </div>
  )
}

/* ---------- one setting at a time, in a bottom sheet ---------- */
function EditSheet({ row, current, close, save }) {
  const [v, setV] = useState(current)
  const [busy, setBusy] = useState(false)

  const commit = async (value) => {
    setBusy(true)
    const ok = await save(row, value === undefined ? null : value)
    setBusy(false)
    if (ok) close()
  }

  return (
    <div className="sheetback" onClick={() => !busy && close()}>
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="sheet-grab" />
        <button className="sheet-close" onClick={close} aria-label="Close">✕</button>
        <h3>{row.label}</h3>

        {row.type === 'choice' && (
          <div className="pickers">
            {row.options.map(o => (
              <button key={String(o[0])} disabled={busy}
                className={'pick' + (o[0] === current ? ' on' : '')}
                onClick={() => commit(o[0])}>{o[1]}</button>
            ))}
            {row.nullable && (
              <button className={'pick' + (current == null ? ' on' : '')} disabled={busy}
                onClick={() => commit(null)}>{row.null_label || 'None'}</button>
            )}
          </div>
        )}

        {row.type === 'bool' && (
          <div className="pickers">
            <button className={'pick' + (current === true ? ' on' : '')} disabled={busy}
              onClick={() => commit(true)}>Yes</button>
            <button className={'pick' + (current === false ? ' on' : '')} disabled={busy}
              onClick={() => commit(false)}>No</button>
          </div>
        )}

        {(row.type === 'int' || row.type === 'num') && (
          <>
            <div className="field">
              <input type="number" inputMode="decimal" value={v ?? ''}
                step={row.type === 'int' ? 1 : 0.5}
                min={row.min} max={row.max}
                onChange={e => setV(e.target.value === '' ? null : Number(e.target.value))} />
            </div>
            {(row.min !== undefined || row.max !== undefined) && (
              <p className="sheet-note">Allowed: {row.min ?? '—'} to {row.max ?? '—'}</p>
            )}
            <button className="btn block" disabled={busy || (v == null && !row.nullable)}
              onClick={() => commit(v)}>Save</button>
            {row.nullable && (
              <button className="btn block secondary mt10" disabled={busy}
                onClick={() => commit(null)}>{row.null_label || 'None'}</button>
            )}
          </>
        )}

        {row.type === 'text' && (
          <>
            <div className="field">
              <input type="text" value={v ?? ''} maxLength={40}
                onChange={e => setV(e.target.value)} />
            </div>
            <button className="btn block" disabled={busy || !String(v || '').trim()}
              onClick={() => commit(String(v).trim())}>Save</button>
          </>
        )}

        {row.type === 'ts' && (
          <>
            <div className="field">
              <input type="datetime-local"
                value={v ? new Date(new Date(v).getTime() - new Date().getTimezoneOffset() * 60000)
                  .toISOString().slice(0, 16) : ''}
                onChange={e => setV(e.target.value ? new Date(e.target.value).toISOString() : null)} />
            </div>
            <p className="sheet-note">Everyone sees this in their own time zone.</p>
            <button className="btn block" disabled={busy || !v} onClick={() => commit(v)}>Save</button>
            <button className="btn block secondary mt10" disabled={busy}
              onClick={() => commit(null)}>Clear</button>
          </>
        )}
      </div>
    </div>
  )
}
