const RAW_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '').trim()
/** The placeholder from .env.example: Google rejects it with "Error 401: invalid_client". */
const EXAMPLE_CLIENT_ID = '1234567890-abcdef.apps.googleusercontent.com'

/** Why the configured client ID can't work, or null if it looks usable. */
export const CLIENT_ID_PROBLEM: string | null = !RAW_CLIENT_ID
  ? 'This build has no Google OAuth client ID.'
  : RAW_CLIENT_ID === EXAMPLE_CLIENT_ID
    ? 'VITE_GOOGLE_CLIENT_ID is still the example value from .env.example.'
    : !/^[0-9]+-[0-9a-z]+\.apps\.googleusercontent\.com$/.test(RAW_CLIENT_ID)
      ? `VITE_GOOGLE_CLIENT_ID doesn't look like a web OAuth client ID ("${RAW_CLIENT_ID}").`
      : null
export const CLIENT_ID: string = CLIENT_ID_PROBLEM ? '' : RAW_CLIENT_ID
/** Build-time flag: hides every create, edit, delete and upload action. */
export const READ_ONLY: boolean = import.meta.env.VITE_READ_ONLY === 'true'
/**
 * In-browser fake Drive for `npm run dev:fake` and the e2e build (`npm run build:e2e`, mode
 * "e2e", never deployed). Always false in production builds: MODE is replaced at build time, so
 * the fake Drive code is dropped (CI checks dist/ for it).
 */
export const FAKE_DRIVE: boolean =
  (import.meta.env.DEV || import.meta.env.MODE === 'e2e') &&
  import.meta.env.VITE_FAKE_DRIVE === 'true'
