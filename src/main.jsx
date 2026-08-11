import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles.css'

/* A single bad row used to blank the entire screen. During a live draft a
   white page is the worst possible outcome, so catch it and show something
   the user can act on — their draft state is all server-side anyway. */
class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null } }
  static getDerivedStateFromError(err) { return { err } }
  componentDidCatch(err, info) { console.error('BLITZ crashed:', err, info) }
  render() {
    if (!this.state.err) return this.props.children
    return (
      <div style={{ padding: 24, color: '#fff', fontFamily: 'Inter, system-ui, sans-serif' }}>
        <h2 style={{ fontSize: 18, marginBottom: 8 }}>Something broke on this screen</h2>
        <p style={{ color: '#9B9B9B', fontSize: 14, lineHeight: 1.5, marginBottom: 16 }}>
          Nothing is lost — your draft and roster live on the server, not in this page.
          Reload and you'll be right back where you were.
        </p>
        <div style={{ display: 'flex', gap: 10, marginBottom: 18 }}>
          <button onClick={() => window.location.reload()}
            style={{ background: '#2FE04B', color: '#04210A', border: 0, borderRadius: 999,
                     padding: '12px 20px', fontWeight: 700, fontSize: 14 }}>Reload</button>
          <button onClick={() => { window.location.hash = '#/'; window.location.reload() }}
            style={{ background: '#161616', color: '#fff', border: '1px solid #333', borderRadius: 999,
                     padding: '12px 20px', fontWeight: 600, fontSize: 14 }}>Go home</button>
        </div>
        <pre style={{ color: '#6E6E6E', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {String(this.state.err?.message || this.state.err)}
        </pre>
      </div>
    )
  }
}

createRoot(document.getElementById('root')).render(
  <Boundary><App /></Boundary>
)
