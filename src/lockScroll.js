import { useEffect } from 'react'

/* Freeze the page behind an open sheet.
   `overflow: hidden` alone does NOT hold on iOS Safari — the page still
   rubber-bands and scrolls under the sheet, which is exactly what makes
   an app feel like a web page. Pinning the body with position:fixed at a
   negative offset is the thing that actually works, and the offset has
   to be restored on close or the page jumps back to the top.

   Nested sheets (player card opened from inside another sheet) are
   handled with a counter, so the inner one closing doesn't unfreeze
   the page while the outer one is still open. */
let depth = 0
let savedY = 0

export function useScrollLock(active = true) {
  useEffect(() => {
    if (!active) return
    if (depth === 0) {
      savedY = window.scrollY || window.pageYOffset || 0
      const b = document.body.style
      b.position = 'fixed'
      b.top = `-${savedY}px`
      b.left = '0'
      b.right = '0'
      b.width = '100%'
      b.overflow = 'hidden'
    }
    depth++
    return () => {
      depth--
      if (depth === 0) {
        const b = document.body.style
        b.position = ''; b.top = ''; b.left = ''; b.right = ''
        b.width = ''; b.overflow = ''
        // instant, not smooth — a smooth scroll here reads as a glitch
        window.scrollTo({ top: savedY, behavior: 'instant' })
      }
    }
  }, [active])
}
