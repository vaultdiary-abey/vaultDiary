// Content Security Policy for the app. Used by vite.config.ts (a <meta> tag, so it also applies
// on GitHub Pages) and mirrored in firebase.json (a header, which can also set frame-ancestors).
// A test checks the two stay identical.
//
// The only third-party origin is Google: its sign-in script (Google Identity Services) and the
// Drive REST API. 'wasm-unsafe-eval' is needed for Argon2 (hash-wasm).
export const CSP_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval' https://accounts.google.com/gsi/client",
  "style-src 'self' https://accounts.google.com/gsi/style",
  "img-src 'self' data: blob:",
  // Decrypted audio/video attachments and recordings are played from blob: URLs.
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self' https://www.googleapis.com https://accounts.google.com/gsi/",
  'frame-src https://accounts.google.com/gsi/',
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
]

export const CSP = CSP_DIRECTIVES.join('; ')
