// Browser side of passkey unlock: feature detection and navigator.credentials calls with the
// WebAuthn PRF extension. The crypto lives in src/crypto/passkey.ts.
//
// There is no server. Assertions are not verified by anyone; what protects the diary is that
// the authenticator only releases the PRF output after user verification (see SECURITY.md).
import { own, randomBytes, toBase64Url, toHex } from '../crypto/bytes'

export interface PasskeySupport {
  available: boolean
  /** Plain-words explanation when not available. */
  reason: string | null
}

type Caps = Record<string, boolean | undefined>
type PkcStatic = typeof PublicKeyCredential & {
  getClientCapabilities?: () => Promise<Caps>
  signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void>
}

function pkc(): PkcStatic | null {
  return typeof window !== 'undefined' && 'PublicKeyCredential' in window
    ? (window.PublicKeyCredential as PkcStatic)
    : null
}

/** Can this browser *probably* use a passkey to unlock? The final word is prf.enabled. */
export async function passkeySupport(): Promise<PasskeySupport> {
  const P = pkc()
  if (!window.isSecureContext || !P || !navigator.credentials) {
    return { available: false, reason: "This browser doesn't support passkeys." }
  }
  try {
    if (!(await P.isUserVerifyingPlatformAuthenticatorAvailable())) {
      return {
        available: false,
        reason:
          'This device has no built-in way to verify you for a passkey (Face ID, Touch ID, ' +
          'fingerprint or screen lock), or it is turned off.',
      }
    }
  } catch {
    return { available: false, reason: "This browser doesn't support passkeys." }
  }
  try {
    const caps = P.getClientCapabilities ? await P.getClientCapabilities() : null
    if (caps && caps['extension:prf'] === false) {
      return {
        available: false,
        reason:
          "This browser's passkeys can't unlock the diary (they don't support the PRF " +
          'feature). Try Safari 18 or newer, or Chrome with Google Password Manager.',
      }
    }
  } catch {
    // getClientCapabilities is new; without it we find out when the passkey is made.
  }
  return { available: true, reason: null }
}

/** True if navigator.credentials.get can be tried at all (for showing the unlock button). */
export function canTryPasskey(): boolean {
  return (
    typeof window !== 'undefined' && window.isSecureContext && !!pkc() && !!navigator.credentials
  )
}

/** Authenticator AAGUIDs of common passkey providers (only used for a default label). */
const PROVIDERS: Record<string, string> = {
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'icloud-keychain',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'icloud-keychain',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'google-password-manager',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'chrome-on-mac',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'windows-hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'windows-hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'windows-hello',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'bitwarden',
  '53414d53-554e-4700-0000-000000000000': 'samsung-pass',
}

function aaguidOf(authData: Uint8Array): string | null {
  // rpIdHash(32) flags(1) signCount(4) then, if AT (0x40) is set, aaguid(16).
  if (authData.length < 53 || !(authData[32] & 0x40)) return null
  const h = toHex(authData.subarray(37, 53))
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

function platform(): 'iphone' | 'ipad' | 'mac' | 'android' | 'windows' | 'other' {
  const ua = navigator.userAgent
  if (/iPhone|iPod/.test(ua)) return 'iphone'
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ipad'
  if (/Android/.test(ua)) return 'android'
  if (/Macintosh/.test(ua)) return 'mac'
  if (/Windows/.test(ua)) return 'windows'
  return 'other'
}

export function defaultPasskeyLabel(provider: string): string {
  const p = platform()
  if (provider === 'google-password-manager') return 'Google passkey'
  if (provider === 'windows-hello') return 'Windows Hello'
  if (provider === '1password') return '1Password passkey'
  if (provider === 'bitwarden') return 'Bitwarden passkey'
  if (provider === 'samsung-pass') return 'Samsung Pass'
  if (p === 'iphone') return 'iPhone Face ID'
  if (p === 'ipad') return 'iPad passkey'
  if (p === 'mac') return provider === 'icloud-keychain' ? 'Mac (iCloud Keychain)' : 'Mac passkey'
  if (p === 'android') return 'Google passkey'
  return 'Passkey'
}

/** A user-facing message for a failed navigator.credentials call. */
export function webauthnErrorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name
  if (name === 'NotAllowedError' || name === 'AbortError') {
    return 'The passkey request was cancelled or timed out.'
  }
  if (name === 'InvalidStateError') {
    return 'This password manager already has a Vault Diary passkey for this address.'
  }
  if (name === 'SecurityError') return "Passkeys can't be used at this address."
  if (name === 'NotSupportedError') return "This browser can't make this kind of passkey."
  return (e as Error)?.message || 'The passkey request failed.'
}

export interface CreatedPasskey {
  credentialId: Uint8Array<ArrayBuffer>
  prfEnabled: boolean
  provider: string
  defaultLabel: string
}

export async function createPasskey(options: {
  rpId: string
  userName: string
  excludeCredentialIds: Uint8Array[]
}): Promise<CreatedPasskey> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { id: options.rpId, name: 'Vault Diary' },
      user: { id: randomBytes(16), name: options.userName, displayName: 'Vault Diary' },
      challenge: randomBytes(32),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 }, // ES256
        { type: 'public-key', alg: -257 }, // RS256
      ],
      // No authenticatorAttachment: both Apple and Google password managers may offer to save.
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
      excludeCredentials: options.excludeCredentialIds.map((id) => ({
        type: 'public-key' as const,
        id: own(id),
      })),
      attestation: 'none',
      timeout: 120_000,
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null
  if (!cred) throw new Error('No passkey was created.')
  const ext = cred.getClientExtensionResults() as { prf?: { enabled?: boolean } }
  let provider = 'unknown'
  try {
    const response = cred.response as AuthenticatorAttestationResponse
    if (typeof response.getAuthenticatorData === 'function') {
      const aaguid = aaguidOf(new Uint8Array(response.getAuthenticatorData()))
      if (aaguid) provider = PROVIDERS[aaguid] ?? 'unknown'
    }
  } catch {
    // only used for a label
  }
  return {
    credentialId: new Uint8Array(cred.rawId),
    prfEnabled: ext.prf?.enabled === true,
    provider,
    defaultLabel: defaultPasskeyLabel(provider),
  }
}

export interface PrfResult {
  credentialId: Uint8Array<ArrayBuffer>
  /** null when the authenticator returned no PRF result. */
  prfOutput: Uint8Array<ArrayBuffer> | null
}

/**
 * Asks for one of the given passkeys and evaluates the PRF with that passkey's own salt
 * (evalByCredential). With a single credential at setup, plain `eval` is used.
 */
export async function evaluatePrf(
  rpId: string,
  slots: { credentialId: Uint8Array; prfSalt: Uint8Array }[],
  mode: 'eval' | 'evalByCredential' = 'evalByCredential',
): Promise<PrfResult> {
  const prf =
    mode === 'eval'
      ? { eval: { first: own(slots[0].prfSalt) } }
      : {
          evalByCredential: Object.fromEntries(
            slots.map((s) => [toBase64Url(s.credentialId), { first: own(s.prfSalt) }]),
          ),
        }
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      rpId,
      allowCredentials: slots.map((s) => ({
        type: 'public-key' as const,
        id: own(s.credentialId),
      })),
      userVerification: 'required',
      timeout: 120_000,
      extensions: { prf } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null
  if (!assertion) throw new Error('No passkey was used.')
  const ext = assertion.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer | ArrayBufferView } }
  }
  const first = ext.prf?.results?.first
  const prfOutput = first
    ? first instanceof ArrayBuffer
      ? new Uint8Array(first)
      : own(new Uint8Array(first.buffer, first.byteOffset, first.byteLength))
    : null
  return { credentialId: new Uint8Array(assertion.rawId), prfOutput }
}

/** Tells the password manager a removed passkey is no longer used (where supported). */
export async function signalRemovedPasskey(rpId: string, credentialId: string): Promise<void> {
  try {
    await pkc()?.signalUnknownCredential?.({ rpId, credentialId })
  } catch {
    // best effort
  }
}
