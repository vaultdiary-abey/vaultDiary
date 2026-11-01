// Passkey unlock end to end, with Chromium's virtual WebAuthn authenticator (PRF enabled).
//   npm run dev:fake            (in another terminal)
//   node e2e/passkey.e2e.mjs    (URL defaults to http://localhost:5173/)
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
const NEWPASS = 'another long passphrase'

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`)
  console.log(`  ✓ ${msg}`)
}

const AUTHENTICATOR = {
  protocol: 'ctap2',
  ctap2Version: 'ctap2_1',
  transport: 'internal',
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
}

async function open(browser, { prf = true, noWebAuthn = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  if (noWebAuthn) await context.addInitScript(() => delete window.PublicKeyCredential)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('dialog', (d) => d.accept())
  await page.goto(URL)
  let cdp = null
  let authenticatorId = null
  if (!noWebAuthn) {
    cdp = await context.newCDPSession(page)
    await cdp.send('WebAuthn.enable')
    ;({ authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { ...AUTHENTICATOR, hasPrf: prf },
    }))
  }
  return { context, page, errors, cdp, authenticatorId }
}

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
  return words
}

async function addPasskey(page, label) {
  await page.getByRole('link', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Add passkey' }).click()
  await page.getByLabel('Your passphrase').fill('wrong passphrase!!')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByText('Your passphrase is wrong.').waitFor()
  await page.getByLabel('Your passphrase').fill(PASS)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Create passkey' }).click()
}

const vaultJson = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('vaultdiary')
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const get = req.result.transaction('kv').objectStore('kv').get('vaultJson')
          get.onsuccess = () => resolve(JSON.parse(get.result.value))
          get.onerror = () => reject(get.error)
        }
      }),
  )

const browser = await chromium.launch()

console.log('Add a passkey (PRF supported)')
const a = await open(browser)
const { page } = a
await setupVault(page)
await addPasskey(page, 'Test laptop')
await page.getByText('Step 3 of 3').waitFor()
await page.getByLabel('Name').fill('Test laptop')
await page.getByRole('button', { name: 'Confirm with passkey' }).click()
await page.getByText('"Test laptop" can now unlock your diary').waitFor()
assert(await page.locator('.passkey-list li', { hasText: 'Test laptop' }).isVisible(), 'listed')
let vault = await vaultJson(page)
const slot = vault.wrappers.find((w) => w.type === 'webauthn-prf')
assert(
  slot && slot.label === 'Test laptop' && slot.rpId === 'localhost' && slot.id.length === 32,
  'vault.json has a webauthn-prf wrapper for this host',
)
assert(
  /^[A-Za-z0-9_-]+$/.test(slot.credentialId) && /^[A-Za-z0-9_-]{43}$/.test(slot.prfSalt),
  'credentialId and prfSalt are base64url',
)
assert(!JSON.stringify(vault).includes('Test entry'), 'nothing readable in vault.json')
await page.screenshot({ path: `${SHOTS}/p1-passkey-added.png`, fullPage: true })

console.log('Unlock with the passkey')
await page.getByRole('button', { name: 'Lock now' }).click()
await page.getByRole('button', { name: 'Unlock with passkey' }).waitFor()
await page.screenshot({ path: `${SHOTS}/p2-unlock-passkey.png`, fullPage: true })
await page.getByRole('button', { name: 'Unlock with passkey' }).click()
await page.getByRole('button', { name: 'Lock now' }).waitFor()
assert(true, 'passkey unlock opens the diary (no new passphrase asked)')

console.log('Reload, then unlock offline from the cached vault.json')
await page.reload()
await page.getByRole('button', { name: 'Unlock with passkey' }).click()
await page.getByRole('button', { name: 'Lock now' }).waitFor()
assert(true, 'passkey unlock after a reload')
await a.context.setOffline(true)
await page.getByRole('button', { name: 'Lock now' }).click()
await page.getByRole('button', { name: 'Unlock with passkey' }).click()
await page.getByRole('button', { name: 'Lock now' }).waitFor()
await a.context.setOffline(false)
assert(true, 'passkey unlock works offline')

console.log('Passphrase still works; changing it keeps the passkey')
await page.getByRole('button', { name: 'Lock now' }).click()
await page.getByRole('button', { name: 'Use passphrase' }).click()
await page.getByLabel('Passphrase').fill(PASS)
await page.getByRole('button', { name: 'Unlock', exact: true }).click()
await page.getByRole('link', { name: 'Settings' }).click()
await page.getByLabel('Current passphrase').fill(PASS)
await page.getByLabel('New passphrase', { exact: true }).fill(NEWPASS)
await page.getByLabel('Repeat new passphrase').fill(NEWPASS)
await page.getByRole('button', { name: 'Change passphrase' }).click()
await page.getByText('Passphrase changed').waitFor()
vault = await vaultJson(page)
assert(
  JSON.stringify(vault.wrappers.find((w) => w.type === 'webauthn-prf')) === JSON.stringify(slot),
  'passkey wrapper unchanged by the passphrase change',
)
await page.getByRole('button', { name: 'Lock now' }).click()
await page.getByRole('button', { name: 'Unlock with passkey' }).click()
await page.getByRole('button', { name: 'Lock now' }).waitFor()
assert(true, 'passkey still unlocks after the passphrase change')

console.log('Failure falls back to the passphrase with a clear message')
await page.getByRole('button', { name: 'Lock now' }).click()
await a.cdp.send('WebAuthn.setUserVerified', {
  authenticatorId: a.authenticatorId,
  isUserVerified: false,
})
await page.getByRole('button', { name: 'Unlock with passkey' }).click()
await page.getByLabel('Passphrase').waitFor({ timeout: 30000 })
const message = await page.locator('.note-error').innerText()
assert(/passphrase/i.test(message), `fallback message shown ("${message}")`)
await page.getByLabel('Passphrase').fill(NEWPASS)
await page.getByRole('button', { name: 'Unlock', exact: true }).click()
await page.getByRole('button', { name: 'Lock now' }).waitFor()
assert(true, 'passphrase unlock after a failed passkey attempt')
await a.cdp.send('WebAuthn.setUserVerified', {
  authenticatorId: a.authenticatorId,
  isUserVerified: true,
})

console.log('Remove the passkey')
await page.getByRole('link', { name: 'Settings' }).click()
await page.locator('.passkey-list li', { hasText: 'Test laptop' }).getByRole('button').click()
await page.getByText('No passkeys yet.').waitFor()
vault = await vaultJson(page)
assert(!vault.wrappers.some((w) => w.type === 'webauthn-prf'), 'wrapper removed from vault.json')
assert(
  vault.wrappers.some((w) => w.type === 'passphrase') &&
    vault.wrappers.some((w) => w.type === 'recovery'),
  'passphrase and recovery wrappers kept',
)
await page.getByRole('button', { name: 'Lock now' }).click()
await page.getByLabel('Passphrase').waitFor()
assert(
  !(await page.getByRole('button', { name: 'Unlock with passkey' }).isVisible()),
  'unlock screen no longer offers a passkey',
)
assert(a.errors.length === 0, `no page errors (${a.errors.join(' | ')})`)
await a.context.close()

console.log('Authenticator without PRF: nothing is saved')
const b = await open(browser, { prf: false })
await setupVault(b.page)
await addPasskey(b.page, 'No PRF')
await b.page.getByText("can't unlock the diary").waitFor()
vault = await vaultJson(b.page)
assert(!vault.wrappers.some((w) => w.type === 'webauthn-prf'), 'no wrapper saved without PRF')
await b.page.screenshot({ path: `${SHOTS}/p3-no-prf.png`, fullPage: true })
await b.context.close()

console.log('Browser without WebAuthn: the option is hidden and explained')
const c = await open(browser, { noWebAuthn: true })
await setupVault(c.page)
await c.page.getByRole('link', { name: 'Settings' }).click()
await c.page.getByText("This browser doesn't support passkeys.").waitFor()
assert(
  !(await c.page.getByRole('button', { name: 'Add passkey' }).isVisible()),
  'Add passkey hidden',
)
await c.page.screenshot({ path: `${SHOTS}/p4-no-webauthn.png`, fullPage: true })
await c.context.close()

await browser.close()
console.log('\nPasskey e2e: all good.')
