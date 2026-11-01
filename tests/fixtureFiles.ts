import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export const FIXTURE = 'tests/fixtures/sample-vault'
export const SECRETS = JSON.parse(readFileSync(join(FIXTURE, 'secrets.json'), 'utf8')) as {
  passphrase: string
  recoveryWords: string
  /** Stand-in PRF output for the fixture's passkey slot (base64). */
  passkeyPrfOutput: string
}

export function walk(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) visit(full)
      else out.set(relative(root, full).split('\\').join('/'), readFileSync(full))
    }
  }
  visit(root)
  return out
}
