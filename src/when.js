/* Draft-time formatting.
   The time is stored once, in UTC, and rendered in whoever is looking's
   own time zone — so Kobe setting 1:00 PM reads as 1:00 PM to everyone
   in the league without anyone doing time-zone math. */

export const fmtDraft = (iso) => {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d)) return null
  return d.toLocaleString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

export const fmtDraftShort = (iso) => {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d)) return null
  return d.toLocaleString(undefined, {
    weekday: 'short', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

/* Returns { text, past } — never a bare number, so a draft that has come
   and gone reads as "started" instead of counting up forever. */
export const countdown = (iso, now = Date.now()) => {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (isNaN(t)) return null
  let ms = t - now
  if (ms <= 0) return { text: 'Draft time has arrived', past: true }

  const d = Math.floor(ms / 86400000); ms -= d * 86400000
  const h = Math.floor(ms / 3600000);  ms -= h * 3600000
  const m = Math.floor(ms / 60000);    ms -= m * 60000
  const s = Math.floor(ms / 1000)

  const parts = d ? [`${d}d`, `${h}h`, `${m}m`]
    : h ? [`${h}h`, `${m}m`]
    : m ? [`${m}m`, `${s}s`]
    : [`${s}s`]
  return { text: parts.join(' '), past: false }
}
