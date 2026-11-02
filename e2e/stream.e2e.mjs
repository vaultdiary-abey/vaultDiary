// Phase 3 milestone B: streaming playback through the service worker.
//   APP_URL=http://localhost:4174/ node e2e/stream.e2e.mjs   (production-like build: needs the
//   real service worker). Makes a 2-minute test video with ffmpeg (VP8/Opus WebM, ~38 MB).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(
  require.resolve('playwright', {
    paths: [process.cwd(), ...(process.env.NODE_PATH ?? '').split(':')],
  }),
)
const URL = process.env.APP_URL ?? 'http://localhost:4174/'
const SHOTS = 'e2e/screenshots'
mkdirSync(SHOTS, { recursive: true })
const PASS = 'correct horse battery staple'

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`)
  console.log(`  ✓ ${msg}`)
}

const video = process.env.TEST_VIDEO ?? join(mkdtempSync(join(tmpdir(), 'vd-stream-')), 'v.webm')
if (!existsSync(video)) {
  execFileSync('ffmpeg', [
    ...['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25'],
    ...['-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '120', '-c:v', 'libvpx'],
    ...['-b:v', '3M', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', video],
  ])
}
const videoBytes = readFileSync(video)

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('dialog', (d) => d.accept())

const verdict = () => page.getByTestId('stream-verdict').innerText()
const report = () => page.getByTestId('stream-report').innerText()

async function waitVerdict() {
  await page.waitForFunction(
    () =>
      /Streaming works|FAILED/.test(
        document.querySelector('[data-testid=stream-verdict]')?.textContent ?? '',
      ),
    null,
    { timeout: 60000 },
  )
  return verdict()
}

async function seekChecks(prefix) {
  for (const [button, line] of [
    ['Middle', 'seek to middle: ok'],
    ['Last 5 s', 'seek to end: ok'],
  ]) {
    await page.getByRole('button', { name: button }).click()
    await page.waitForFunction(
      (l) => document.querySelector('[data-testid=stream-report]').textContent.includes(l),
      line,
      { timeout: 60000 },
    )
    assert(true, `${prefix}: ${button.toLowerCase()} works`)
  }
  const t = await page.evaluate(() => document.querySelector('video').currentTime)
  assert(t > 110, `${prefix}: playing near the end (${t.toFixed(1)} s)`)
}

console.log('Stream test page, locked (file from this device, encrypted in memory)')
await page.goto(`${URL}#/stream-test`)
await page
  .waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 30000 })
  .catch(() => {})
await page.reload()
await page.getByRole('heading', { name: 'Streaming test' }).waitFor()
await page.locator('#st-file').setInputFiles(video)
const v1 = await waitVerdict()
assert(v1.startsWith('Streaming works'), `media requests go through the service worker (${v1})`)
await seekChecks('local')
assert(/0 errors/.test(await report()), 'no read errors')
await page.screenshot({ path: `${SHOTS}/b1-stream-test.png`, fullPage: true })

console.log('Set up a vault with a video attachment')
async function setupVault(p, name, bytes) {
  await p.goto(URL)
  await p.getByRole('button', { name: 'Sign in with Google' }).click()
  await p.getByRole('button', { name: 'Start' }).click()
  await p.getByLabel('Passphrase', { exact: true }).fill(PASS)
  await p.getByLabel('Repeat passphrase').fill(PASS)
  await p.getByRole('button', { name: 'Continue' }).click()
  await p.locator('.word-grid li').first().waitFor()
  const words = (await p.locator('.word-grid li').allInnerTexts()).map((t) => t.split(/\s+/).pop())
  await p.getByLabel('I have written down').check()
  await p.getByRole('button', { name: 'Continue' }).click()
  const labels = await p.locator('label[for^="cw"]').allInnerTexts()
  for (const [i, label] of labels.entries()) {
    await p.locator(`#cw${i}`).fill(words[Number(label.replace(/\D/g, '')) - 1])
  }
  await p.getByRole('button', { name: 'Create vault' }).click()
  await p.getByRole('heading', { name: 'Today' }).waitFor()
  await p.getByRole('link', { name: '+ New entry' }).click()
  await p.getByLabel('Title').fill('Holiday video')
  await p.locator('input[type=file][multiple]').setInputFiles({
    name,
    mimeType: 'video/webm',
    buffer: bytes,
  })
  await p.locator('.attachments li', { hasText: name }).waitFor()
  await p.waitForTimeout(1200)
  await p.getByRole('button', { name: 'Done' }).click()
  await p.getByRole('heading', { name: 'Holiday video' }).waitFor()
  const queued = () =>
    p.evaluate(
      () =>
        new Promise((resolve) => {
          const r = indexedDB.open('vaultdiary')
          r.onsuccess = () => {
            const q = r.result.transaction('uploads').objectStore('uploads').count()
            q.onsuccess = () => {
              r.result.close()
              resolve(q.result)
            }
          }
        }),
    )
  for (let i = 0; (await queued()) > 0; i++) {
    if (i > 180) throw new Error('uploads did not finish')
    await p.waitForTimeout(1000)
  }
}
await setupVault(page, 'holiday.webm', videoBytes)
assert(true, 'video uploaded to (fake) Drive: no local copy left')

console.log('Stream test page, unlocked (attachment streamed from Drive)')
await page.evaluate(() => {
  window.__fakeDrive.downloads.length = 0
  window.__fakeDrive.ranges.length = 0
})
await page.goto(`${URL}#/stream-test`)
await page.getByRole('button', { name: 'holiday.webm' }).click()
const v2 = await waitVerdict()
assert(v2.startsWith('Streaming works'), `Drive attachment streams (${v2})`)
await seekChecks('drive')
const drive = await page.evaluate(() => {
  const d = window.__fakeDrive
  const vdf = [...d.files.values()].filter((f) => f.name.endsWith('.vdf'))
  const big = vdf.sort((a, b) => b.data.length - a.data.length)[0]
  const ranges = d.ranges.filter((r) => r[0] === big.id)
  return {
    size: big.data.length,
    fullDownloads: d.downloads.filter((id) => id === big.id).length,
    ranges: ranges.length,
    bytes: ranges.reduce((n, r) => n + r[2] - r[1] + 1, 0),
  }
})
assert(drive.fullDownloads === 0, 'the video was never downloaded whole')
assert(drive.ranges > 1, `${drive.ranges} Range requests to Drive`)
assert(
  drive.bytes < drive.size,
  `only part of the file was fetched (${(drive.bytes / 1e6).toFixed(1)} of ${(drive.size / 1e6).toFixed(1)} MB)`,
)

console.log('The attachment viewer streams the video')
await page.evaluate(() => {
  window.__fakeDrive.downloads.length = 0
  window.__fakeDrive.ranges.length = 0
})
await page.goto(`${URL}#/timeline`)
await page.locator('.entry-card', { hasText: 'Holiday video' }).click()
await page.getByRole('button', { name: 'Open holiday.webm' }).click()
const viewer = page.getByRole('dialog', { name: 'holiday.webm' })
await viewer.locator('[data-streaming=yes] video').waitFor()
const vid = viewer.locator('video')
await page.waitForFunction(() => document.querySelector('.viewer video')?.readyState >= 1)
const src = await vid.getAttribute('src')
assert(/\/stream\/[0-9a-f]{32}\/holiday\.webm$/.test(src), 'plays from a same-origin stream URL')
assert(!(await viewer.getByText(/decrypts all of it into memory/).count()), 'no size warning')
await vid.evaluate((v) => v.play())
await page.waitForFunction(() => document.querySelector('.viewer video').currentTime > 1)
assert(true, 'playback starts')
const fullDownloads = () =>
  page.evaluate(() => {
    const d = window.__fakeDrive
    const big = [...d.files.values()].sort((a, b) => b.data.length - a.data.length)[0]
    return d.downloads.filter((id) => id === big.id).length
  })
assert((await fullDownloads()) === 0, 'without downloading the whole file')

console.log('Google sign-in expires while playing')
await page.evaluate(() => (window.__fakeDrive.authExpired = true))
await vid.evaluate((v) => {
  v.currentTime = 75
  return v.play().catch(() => {})
})
await viewer.locator('.viewer-signin').waitFor({ timeout: 30000 })
assert(await vid.evaluate((v) => v.paused), 'playback pauses and Continue is offered')
await page.evaluate(() => (window.__fakeDrive.authExpired = false))
await viewer.locator('.viewer-signin').getByRole('button', { name: 'Continue' }).click()
await viewer.locator('.viewer-signin').waitFor({ state: 'detached' })
await page.waitForFunction(() => document.querySelector('.viewer video').currentTime > 76, null, {
  timeout: 30000,
})
assert(true, 'after Continue it plays on from where it was')

console.log('Seek to the final seconds')
await vid.evaluate((v) => {
  v.currentTime = v.duration - 3
  return v.play().catch(() => {})
})
await page.waitForFunction(() => document.querySelector('.viewer video').ended, null, {
  timeout: 30000,
})
assert(true, 'plays to the end')
assert((await fullDownloads()) === 0, 'still never downloaded whole')

const streamStatus = (url) => page.evaluate((u) => fetch(u).then((r) => r.status), url)
assert((await streamStatus(src)) === 206 || (await streamStatus(src)) === 200, 'stream open')
await viewer.getByRole('button', { name: 'Close' }).click()
assert((await streamStatus(src)) === 404, 'closing the player ends the stream')

console.log('Locking ends a stream')
await page.getByRole('button', { name: 'Open holiday.webm' }).click()
await viewer.locator('[data-streaming=yes] video').waitFor()
const src2 = await viewer.locator('video').getAttribute('src')
// The viewer covers the top bar; lock the way auto-lock would, with the player still open.
await page.getByRole('button', { name: 'Lock now' }).dispatchEvent('click')
await page.getByLabel('Passphrase').waitFor()
assert((await streamStatus(src2)) === 404, 'locking ends the stream')

console.log('Without a service worker: the full-decrypt player')
const noSw = await browser.newContext({
  viewport: { width: 390, height: 844 },
  serviceWorkers: 'block',
})
const page2 = await noSw.newPage()
page2.on('pageerror', (e) => errors.push(e.message))
page2.on('dialog', (d) => d.accept())
const clip = join(mkdtempSync(join(tmpdir(), 'vd-clip-')), 'clip.webm')
execFileSync('ffmpeg', [
  ...['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25'],
  ...['-t', '5', '-c:v', 'libvpx', clip],
])
await setupVault(page2, 'clip.webm', readFileSync(clip))
await page2.getByRole('button', { name: 'Open clip.webm' }).click()
const v2el = page2.getByRole('dialog', { name: 'clip.webm' }).locator('video')
await v2el.waitFor()
assert((await v2el.getAttribute('src')).startsWith('blob:'), 'falls back to decrypting in memory')
await page2.waitForFunction(() => document.querySelector('.viewer video')?.readyState >= 1)
assert(true, 'and plays')
await noSw.close()

assert(errors.length === 0, `no page errors (${errors.join(' | ')})`)
await browser.close()
console.log('\nStream e2e: all good.')
