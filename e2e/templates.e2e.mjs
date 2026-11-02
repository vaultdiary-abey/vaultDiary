// Templates, writing prompts and the default title.
//   APP_URL=http://localhost:4174/ node e2e/templates.e2e.mjs   (production-like build)
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

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('dialog', (d) => d.accept())
await page.goto(URL)

await page.getByRole('button', { name: 'Sign in with Google' }).click()
await page.getByRole('button', { name: 'Start' }).click()
await page.getByLabel('Passphrase', { exact: true }).fill(PASS)
await page.getByLabel('Repeat passphrase').fill(PASS)
await page.getByRole('button', { name: 'Continue' }).click()
await page.locator('.word-grid li').first().waitFor()
const words = (await page.locator('.word-grid li').allInnerTexts()).map((t) => t.split(/\s+/).pop())
await page.getByLabel('I have written down').check()
await page.getByRole('button', { name: 'Continue' }).click()
const labels = await page.locator('label[for^="cw"]').allInnerTexts()
for (const [i, label] of labels.entries()) {
  await page.locator(`#cw${i}`).fill(words[Number(label.replace(/\D/g, '')) - 1])
}
await page.getByRole('button', { name: 'Create vault' }).click()
await page.getByRole('heading', { name: 'Today' }).waitFor()

console.log('Default title')
await page.getByRole('link', { name: '+ New entry' }).click()
const placeholder = await page.getByLabel('Title').getAttribute('placeholder')
assert(/ · Entry 1$/.test(placeholder), `title field suggests "${placeholder}"`)
await page.getByLabel('Entry text').fill('No title typed here')
await page.waitForTimeout(1200)
await page.getByRole('button', { name: 'Done' }).click()
await page.getByRole('heading', { name: placeholder }).waitFor()
assert(true, 'saved with the date and entry number as its title')
await page.getByRole('link', { name: 'Today' }).click()
await page.getByRole('link', { name: '+ New entry' }).click()
assert(
  /· Entry 2$/.test(await page.getByLabel('Title').getAttribute('placeholder')),
  'the second entry of the day is "Entry 2"',
)
await page.getByRole('button', { name: 'Discard' }).click()

console.log('Writing prompt')
await page.getByRole('link', { name: 'Today' }).click()
const prompt1 = await page.locator('.prompt-text').innerText()
await page.getByRole('button', { name: 'Another' }).click()
const prompt2 = await page.locator('.prompt-text').innerText()
assert(prompt1 !== prompt2, 'Another shows a different prompt')
await page.screenshot({ path: `${SHOTS}/d1-today-prompt.png`, fullPage: true })
await page.getByRole('link', { name: 'Write about this' }).click()
await page.getByLabel('Entry text').waitFor()
assert(
  (await page.getByLabel('Entry text').inputValue()).startsWith(`> ${prompt2}`),
  'the entry starts with the prompt',
)
await page.getByLabel('Entry text').press('End')
await page.getByLabel('Entry text').pressSequentially('My answer.')
await page.waitForTimeout(1200)
await page.getByRole('button', { name: 'Done' }).click()
await page.locator('.markdown blockquote').waitFor()

console.log('Templates')
await page.getByRole('link', { name: 'Settings' }).click()
await page.getByRole('link', { name: 'Manage templates' }).click()
await page.getByRole('link', { name: 'New template' }).click()
await page.getByLabel('Template name').fill('Gratitude')
await page.getByLabel('Entry text (Markdown)').fill('## Three good things\n1. \n2. \n3. ')
await page.getByLabel('Add a tag').fill('gratitude')
await page.getByLabel('Add a tag').press('Enter')
await page.getByRole('button', { name: 'Save template' }).click()
await page.locator('.template-list', { hasText: 'Gratitude' }).waitFor()
await page.screenshot({ path: `${SHOTS}/d2-templates.png`, fullPage: true })
assert(true, 'template saved')
await page.getByRole('link', { name: 'Today' }).click()
await page.locator('.template-picker').getByRole('link', { name: 'Gratitude' }).click()
await page.getByLabel('Entry text').waitFor()
assert(
  (await page.getByLabel('Entry text').inputValue()).startsWith('## Three good things'),
  'new entry starts from the template text',
)
assert(
  await page.locator('.tag-editor .chip', { hasText: '#gratitude' }).isVisible(),
  'with its tags',
)
await page.getByLabel('Entry text').press('End')
await page.getByLabel('Entry text').pressSequentially('Sunshine')
await page.waitForTimeout(1200)
await page.getByRole('button', { name: 'Done' }).click()
await page.getByRole('heading', { name: / · Entry 3$/ }).waitFor()
assert(true, 'template entry gets the default title (3rd today)')

console.log('Prompt switch')
await page.getByRole('link', { name: 'Today' }).click()
await page.getByRole('button', { name: 'Hide prompts' }).click()
await page.locator('.prompt-card').waitFor({ state: 'detached' })
await page.getByRole('link', { name: 'Settings' }).click()
assert(
  !(await page.getByLabel('Show a writing prompt on the Today page').isChecked()),
  'Hide prompts turns the setting off',
)

console.log('settings.vds is stored encrypted')
const stored = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const r = indexedDB.open('vaultdiary')
      r.onsuccess = () => {
        const q = r.result.transaction('kv').objectStore('kv').get('settingsData')
        q.onsuccess = () => {
          const v = q.result?.value
          resolve(
            v && {
              magic: String.fromCharCode(...v.slice(0, 4)),
              plain: new TextDecoder().decode(v).includes('Three good things'),
            },
          )
        }
      }
    }),
)
assert(stored && stored.magic === 'VDV1' && !stored.plain, 'templates are encrypted locally')
const onDrive = await page
  .waitForFunction(
    () =>
      [...window.__fakeDrive.files.values()].some((f) => f.name === 'settings.vds' && !f.trashed),
    null,
    { timeout: 15000 },
  )
  .then(
    () => true,
    () => false,
  )
assert(onDrive, 'settings.vds uploaded to Drive')

assert(errors.length === 0, `no page errors (${errors.join(' | ')})`)
await browser.close()
console.log('\nTemplates e2e: all good.')
