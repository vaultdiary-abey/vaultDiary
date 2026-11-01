// Checks recovery/recovery.html in a real browser, offline, against the committed fixture:
//   node e2e/recovery.e2e.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(
  require.resolve('playwright', {
    paths: [process.cwd(), ...(process.env.NODE_PATH ?? '').split(':')],
  }),
)

const FIXTURE = 'tests/fixtures/sample-vault'
const secrets = JSON.parse(readFileSync(join(FIXTURE, 'secrets.json'), 'utf8'))

function walk(dir, base = dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, base, out)
    else out.push(p.slice(base.length + 1))
  }
  return out
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`)
  console.log(`  ✓ ${msg}`)
}

const browser = await chromium.launch()
const context = await browser.newContext({ acceptDownloads: true, offline: true })
const page = await context.newPage()
const requests = []
page.on('request', (r) => {
  if (!/^(file|blob|data):/.test(r.url())) requests.push(r.url())
})
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
// RECOVERY_HTML=… checks another copy, e.g. an older recovery.html against today's fixture.
await page.goto(`file://${resolve(process.env.RECOVERY_HTML ?? 'recovery/recovery.html')}`)

async function run(label, files, secret, words) {
  console.log(label)
  await page.getByRole('button', { name: 'Clear' }).click()
  await page.locator('#pick-zip').setInputFiles(files)
  await page.getByText('vault.json: found').waitFor()
  await page.locator(words ? '#mode-words' : '#mode-pass').check()
  await page.locator(words ? '#words' : '#passphrase').fill(secret)
  await page.getByRole('button', { name: 'Decrypt' }).click()
  await page.locator('#status.ok, #status.error').waitFor()
  return page.locator('#status').innerText()
}

const folderFiles = walk(join(FIXTURE, 'VaultDiary')).map((p) => join(FIXTURE, 'VaultDiary', p))

let status = await run('Wrong passphrase', folderFiles, 'not the passphrase', false)
assert(status === 'Wrong passphrase.', 'wrong passphrase fails cleanly')
status = await run('Wrong words', folderFiles, 'abandon '.repeat(23) + 'art', true)
assert(/do not belong/.test(status), 'wrong recovery words fail cleanly')

status = await run('Fixture folder files + passphrase', folderFiles, secrets.passphrase, false)
assert(status.startsWith('Done. Everything decrypted'), `decrypted (${status})`)
assert((await page.locator('#results li').count()) === 8, '4 entries and 4 files listed')
const [dl] = await Promise.all([
  page.waitForEvent('download'),
  page.getByRole('button', { name: 'Download everything (.zip)' }).click(),
])
const zipPath = await dl.path()
const { execFileSync } = await import('node:child_process')
const listing = execFileSync('unzip', ['-Z1', zipPath]).toString().trim().split('\n').sort()
const expected = walk(join(FIXTURE, 'expected'))
  .map((p) => `VaultDiary-recovered/${p}`)
  .sort()
assert(JSON.stringify(listing) === JSON.stringify(expected), 'zip has the expected layout')
for (const p of expected) {
  const got = execFileSync('unzip', ['-p', zipPath, p])
  const want = readFileSync(join(FIXTURE, 'expected', p.replace('VaultDiary-recovered/', '')))
  if (!got.equals(want)) throw new Error(`Mismatch in ${p}`)
}
assert(true, 'every recovered file is byte-identical to the expected export')

const extra = process.argv[2]
if (extra) {
  status = await run(`Extra zip ${extra} + words`, [extra], process.argv[3], true)
  assert(status.startsWith('Done'), `extra zip decrypted (${status})`)
}

assert(requests.length === 0, `no network requests (${requests.join(', ')})`)
assert(errors.length === 0, `no page errors (${errors.join(' | ')})`)
await browser.close()
