import React, { useEffect, useRef, useState } from 'react'
import { supabase } from './supabase.js'

/* League chat.

   Messages arrive over the same realtime channel the draft uses, so a
   message shows up without anyone refreshing. Consecutive messages from
   the same team are grouped the way a phone messages app groups them. */

const stamp = iso => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
const dayOf = iso => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })

export default function Chat({ league, myTeam, teams, onClose }) {
  const [msgs, setMsgs] = useState(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const endRef = useRef(null)
  const name = id => teams.find(t => t.id === id)?.name || 'Someone'

  const load = async () => {
    const { data } = await supabase.from('league_chat')
      .select('*').eq('league_id', league.id).order('id', { ascending: false }).limit(200)
    setMsgs((data || []).reverse())
  }

  useEffect(() => {
    load()
    const ch = supabase.channel('chat-' + league.id)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'league_chat', filter: `league_id=eq.${league.id}` },
        payload => setMsgs(m => (m || []).some(x => x.id === payload.new.id) ? m : [...(m || []), payload.new]))
      .subscribe()
    // the realtime socket can drop on a phone; a slow poll covers it
    const iv = setInterval(load, 20000)
    return () => { supabase.removeChannel(ch); clearInterval(iv) }
  }, [league.id])

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [msgs?.length])

  const send = async () => {
    const body = text.trim()
    if (!body || busy) return
    setBusy(true); setErr(null)
    const { error } = await supabase.rpc('post_chat', { p_league_id: league.id, p_body: body })
    setBusy(false)
    if (error) { setErr(error.message); return }
    setText('')
    load()
  }

  return (
    <div className="wrap chatwrap">
      <div className="sect">
        <div>
          <h1>League chat</h1>
          <div className="microlabel">{league.name}</div>
        </div>
        <button className="btn small secondary" onClick={onClose}>Done</button>
      </div>

      {err && <div className="err">{err}</div>}

      <div className="chatlog">
        {msgs === null && <div className="loading"><span className="spinner" />Loading…</div>}
        {msgs && !msgs.length && (
          <div className="empty"><strong>Nothing yet</strong>
            <p>Trash talk, trade offers, complaints about the kicker.</p></div>
        )}
        {msgs && msgs.map((m, i) => {
          const mine = m.team_id === myTeam?.id
          const prev = msgs[i - 1]
          const newDay = !prev || dayOf(prev.created_at) !== dayOf(m.created_at)
          // group runs from the same team within a few minutes
          const grouped = prev && !newDay && prev.team_id === m.team_id &&
            (new Date(m.created_at) - new Date(prev.created_at)) < 5 * 60 * 1000
          return (
            <React.Fragment key={m.id}>
              {newDay && <div className="chatday">{dayOf(m.created_at)}</div>}
              <div className={'chatline' + (mine ? ' mine' : '') + (grouped ? ' grouped' : '')}>
                {!grouped && (
                  <div className="chatwho">
                    {mine ? 'You' : name(m.team_id)}
                    <span className="chattime">{stamp(m.created_at)}</span>
                  </div>
                )}
                <div className={'chatbubble' + (m.kind === 'bot' ? ' bot' : '')}>{m.body}</div>
              </div>
            </React.Fragment>
          )
        })}
        <div ref={endRef} />
      </div>

      <div className="chatbar">
        <input
          value={text} maxLength={500} placeholder="Message your league"
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') send() }}
        />
        <button className="btn small" disabled={busy || !text.trim()} onClick={send}>
          {busy ? '…' : 'Send'}
        </button>
      </div>
    </div>
  )
}
