import { countdown, fmtDraft, fmtDraftShort } from '../src/when.js'

let pass = 0, fail = 0
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)) }

const NOW = Date.parse('2026-08-12T12:00:00Z')
const at = (ms) => new Date(NOW + ms).toISOString()

console.log('=== countdown ===')
ok('null when there is no time', countdown(null) === null)
ok('null on garbage', countdown('not a date') === null)

let c = countdown(at(2 * 86400000 + 3 * 3600000 + 14 * 60000), NOW)
ok('days show d/h/m', c.text === '2d 3h 14m', c.text)
ok('  and it is not in the past', c.past === false)

c = countdown(at(3 * 3600000 + 5 * 60000), NOW)
ok('under a day drops the days', c.text === '3h 5m', c.text)

c = countdown(at(4 * 60000 + 30000), NOW)
ok('under an hour shows m/s', c.text === '4m 30s', c.text)

c = countdown(at(42000), NOW)
ok('under a minute shows seconds', c.text === '42s', c.text)

/* the case that matters: a draft time that has come and gone must not
   count UP forever — that is what makes an app look broken on the day */
c = countdown(at(-60000), NOW)
ok('a passed draft reads as arrived', c.past === true && !/\d+m/.test(c.text), JSON.stringify(c))
c = countdown(at(0), NOW)
ok('exactly on the minute counts as arrived', c.past === true, JSON.stringify(c))
c = countdown(at(-9 * 86400000), NOW)
ok('nine days late still reads as arrived', c.past === true, c.text)

/* no rounding lies: 59.9 minutes must not print as "1h 0m" */
c = countdown(at(59 * 60000 + 59000), NOW)
ok('59m59s does not round up to an hour', c.text === '59m 59s', c.text)
c = countdown(at(86400000 - 1000), NOW)
ok('one second under a day stays in hours', c.text === '23h 59m', c.text)

console.log('\n=== formatting ===')
const iso = '2026-08-09T20:00:00.000Z'
ok('long form has a weekday and a time', /day/i.test(fmtDraft(iso)) && /:\d\d/.test(fmtDraft(iso)), fmtDraft(iso))
ok('short form is short', fmtDraftShort(iso).length < fmtDraft(iso).length,
   `${fmtDraftShort(iso)} vs ${fmtDraft(iso)}`)
ok('no time returns null, not "Invalid Date"', fmtDraft(null) === null && fmtDraftShort(null) === null)
ok('garbage returns null', fmtDraft('nope') === null)

/* stored in UTC, read in local time — the same instant for everyone */
const a = new Date(iso).getTime()
ok('a round-trip through ISO is the same instant',
   new Date(new Date(iso).toISOString()).getTime() === a)

console.log(`\n${'='.repeat(46)}\n${pass} passed, ${fail} failed\n${'='.repeat(46)}`)
process.exit(fail ? 1 : 0)
