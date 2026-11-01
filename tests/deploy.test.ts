import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CSP } from '../csp.mjs'

describe('Content Security Policy', () => {
  it('firebase.json sends the same CSP as the <meta> tag, plus frame-ancestors', () => {
    const fb = JSON.parse(readFileSync('firebase.json', 'utf8'))
    for (const source of ['/', '/index.html']) {
      const rule = fb.hosting.headers.find((h: { source: string }) => h.source === source)
      const csp = rule.headers.find((h: { key: string }) => h.key === 'Content-Security-Policy')
      expect(csp.value).toBe(`${CSP}; frame-ancestors 'none'`)
    }
  })

  it('only allows Google sign-in and the Drive API as third parties', () => {
    const origins = [...CSP.matchAll(/https:\/\/[^\s;]+/g)].map((m) => m[0])
    expect(new Set(origins)).toEqual(
      new Set([
        'https://accounts.google.com/gsi/client',
        'https://accounts.google.com/gsi/style',
        'https://www.googleapis.com',
        'https://accounts.google.com/gsi/',
      ]),
    )
    expect(CSP).toContain("default-src 'none'")
    expect(CSP).not.toContain('unsafe-inline')
    expect(CSP).not.toMatch(/'unsafe-eval'/)
  })
})

describe('recovery/recovery.html', () => {
  const html = readFileSync('recovery/recovery.html', 'utf8')
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)![1]

  it('is one self-contained file that cannot touch the network', () => {
    expect(csp).toMatch(/^default-src 'none';/)
    expect(csp).not.toMatch(/connect-src|https?:/)
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=|https?:\/\/(?!www\.w3\.org)/)
  })

  it('pins its inline script and style by hash', () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]
    const sha = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`
    expect(csp).toContain(`script-src ${sha(script)} 'wasm-unsafe-eval'`)
    expect(csp).toContain(`style-src ${sha(style)}`)
  })
})

describe('host independence', () => {
  it('no source file hard-codes an app domain (the code uses location.hostname / origin)', () => {
    const files = [
      ...[...walkSource('src')],
      'index.html',
      'vite.config.ts',
      'csp.mjs',
      'firebase.json',
      '.github/workflows/deploy.yml',
    ]
    const banned = /[a-z0-9-]+\.github\.io|\.web\.app|\.firebaseapp\.com/i
    const hits = files.filter((f) => banned.test(readFileSync(f, 'utf8')))
    expect(hits).toEqual([])
  })
})

function* walkSource(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = `${dir}/${name}`
    if (statSync(full).isDirectory()) yield* walkSource(full)
    else if (/\.(ts|tsx|mjs|js|html|css)$/.test(name)) yield full
  }
}
