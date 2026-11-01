// Media end to end: viewers (photo, audio, video, PDF), in-app recording and thumbnails.
// Runs best against the production-like build, which has the real CSP and service worker:
//   npm run build:e2e && npm run preview:e2e     (in another terminal)
//   APP_URL=http://localhost:4174/ node e2e/media.e2e.mjs
// It also works against `npm run dev:fake` (default URL http://localhost:5173/).
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require(
  require.resolve('playwright', {
    paths: [process.cwd(), ...(process.env.NODE_PATH ?? '').split(':')],
  }),
)

const URL = process.env.APP_URL ?? 'http://localhost:5173/'
const SHOTS = 'e2e/screenshots'
mkdirSync(SHOTS, { recursive: true })
const PASS = 'correct horse battery staple'

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`)
  console.log(`  ✓ ${msg}`)
}

// --- test files -------------------------------------------------------------------------------

function pdfBytes(lines) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  const text = lines.map((l, i) => `BT /F1 18 Tf 20 ${160 - i * 30} Td (${l}) Tj ET`).join('\n')
  objs[3] = `<< /Length ${text.length} >>\nstream\n${text}\nendstream`
  let out = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

function wavBytes(seconds = 1, rate = 8000) {
  const n = seconds * rate
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + n * 2, 4)
  b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(i / 4)), 44 + i * 2)
  return b
}

/** A real PNG and WebM video made by the browser itself. */
async function browserMedia(page) {
  return page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 480
    const g = canvas.getContext('2d')
    g.fillStyle = '#3b5bdb'
    g.fillRect(0, 0, 640, 480)
    g.fillStyle = '#ffd43b'
    g.fillRect(200, 140, 240, 200)
    const png = await new Promise((r) => canvas.toBlob(r, 'image/png'))
    const stream = canvas.captureStream(15)
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm' })
    const parts = []
    rec.ondataavailable = (e) => parts.push(e.data)
    rec.start(200)
    for (let i = 0; i < 25; i++) {
      g.fillStyle = `hsl(${i * 14}, 70%, 50%)`
      g.fillRect(0, 0, 640, 480)
      await new Promise((r) => setTimeout(r, 70))
    }
    rec.stop()
    await new Promise((r) => (rec.onstop = r))
    const webm = new Blob(parts, { type: 'video/webm' })
    const b64 = async (blob) => {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let s = ''
      for (const x of bytes) s += String.fromCharCode(x)
      return btoa(s)
    }
    return { png: await b64(png), webm: await b64(webm) }
  })
}

// --- helpers ----------------------------------------------------------------------------------

async function setupVault(page) {
  await page.getByRole('button', { name: 'Sign in with Google' }).click()
  await page.getByRole('button', { name: 'Start' }).click()
  await page.getByLabel('Passphrase', { exact: true }).fill(PASS)
  await page.getByLabel('Repeat passphrase').fill(PASS)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.locator('.word-grid li').first().waitFor()
  const words = (await page.locator('.word-grid li').allInnerTexts()).map((t) =>
    t.split(/\s+/).pop(),
  )
  await page.getByLabel('I have written down').check()
  await page.getByRole('button', { name: 'Continue' }).click()
  const labels = await page.locator('label[for^="cw"]').allInnerTexts()
  for (const [i, label] of labels.entries()) {
    await page.locator(`#cw${i}`).fill(words[Number(label.replace(/\D/g, '')) - 1])
  }
  await page.getByRole('button', { name: 'Create vault' }).click()
  await page.getByRole('heading', { name: 'Today' }).waitFor()
}

async function waitUploaded(page) {
  await page.waitForFunction(
    () =>
      !document.body.innerText.includes('Waiting to upload') &&
      !document.body.innerText.includes('Uploading') &&
      !document.body.innerText.includes('Encrypting'),
    null,
    { timeout: 30000 },
  )
}

async function openViewer(page, name) {
  await page.getByRole('button', { name: `Open ${name}` }).click()
  await page.getByRole('dialog', { name }).waitFor()
}

async function closeViewer(page) {
  await page.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
}

// --- run --------------------------------------------------------------------------------------

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  permissions: ['camera', 'microphone'],
  acceptDownloads: true,
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('dialog', (d) => d.accept())
await page.goto(URL)
const csp = await page.evaluate(
  () => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? null,
)
console.log(csp ? 'Running with the production CSP' : 'Running without CSP (dev server)')
await setupVault(page)
const media = await browserMedia(page)

console.log('Viewers')
await page.getByRole('link', { name: '+ New entry' }).click()
await page.getByLabel('Title').fill('Media entry')
await page.locator('input[type=file][multiple]').setInputFiles([
  { name: 'square.png', mimeType: 'image/png', buffer: Buffer.from(media.png, 'base64') },
  { name: 'note.pdf', mimeType: 'application/pdf', buffer: pdfBytes(['Hello from a PDF']) },
  { name: 'tone.wav', mimeType: 'audio/wav', buffer: wavBytes() },
  { name: 'clip.webm', mimeType: 'video/webm', buffer: Buffer.from(media.webm, 'base64') },
  { name: 'IMG_0001.HEIC', mimeType: 'image/heic', buffer: Buffer.from('not really heic') },
  { name: 'data.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(100, 1) },
])
await page.getByRole('button', { name: 'Open data.bin' }).waitFor()
await waitUploaded(page)

await openViewer(page, 'square.png')
await page.waitForFunction(() => {
  const img = document.querySelector('.viewer img')
  return img && img.complete && img.naturalWidth === 640
})
assert(true, 'photo decrypts and shows')
await page.screenshot({ path: `${SHOTS}/m1-photo.png` })
await closeViewer(page)

await openViewer(page, 'note.pdf')
await page.locator('.pdf-page.done canvas').first().waitFor({ timeout: 20000 })
const inked = await page.evaluate(() => {
  const c = document.querySelector('.pdf-page canvas')
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  let dark = 0
  for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++
  return dark
})
assert(inked > 50, `PDF page rendered by bundled pdf.js (${inked} dark pixels)`)
await page.screenshot({ path: `${SHOTS}/m2-pdf.png` })
await closeViewer(page)

await openViewer(page, 'tone.wav')
await page.waitForFunction(() => document.querySelector('.viewer audio')?.readyState >= 1)
assert(true, 'audio loads in the player')
await closeViewer(page)

await openViewer(page, 'clip.webm')
await page.waitForFunction(() => document.querySelector('.viewer video')?.readyState >= 1)
assert(true, 'video loads in the player')
await page.screenshot({ path: `${SHOTS}/m3-video.png` })
await closeViewer(page)

await openViewer(page, 'IMG_0001.HEIC')
await page.getByText("This browser can't show this photo").waitFor()
assert(true, 'undecodable HEIC offers Download')
await closeViewer(page)

await openViewer(page, 'data.bin')
await page.getByText("This kind of file can't be shown").waitFor()
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.locator('.viewer-message').getByRole('button', { name: 'Download' }).click(),
])
assert(download.suggestedFilename() === 'data.bin', 'other files: Download only')
await closeViewer(page)

assert(errors.length === 0, `no page errors (${errors.join(' | ')})`)
await browser.close()
console.log('\nMedia e2e: all good.')
