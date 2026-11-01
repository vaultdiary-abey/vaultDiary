// Service worker registration. A new deployment is not activated behind the user's back: the
// app shows "Update available — reload" (see UpdateBanner) so a stale copy doesn't keep running
// and an open editor isn't reloaded mid-sentence.
import { registerSW } from 'virtual:pwa-register'

const CHECK_EVERY = 60 * 60_000

/** Returns a function that activates the waiting version and reloads the page. */
export function registerServiceWorker(onUpdateAvailable: () => void): () => Promise<void> {
  if (import.meta.env.DEV) return async () => location.reload()
  const update = registerSW({
    immediate: true,
    onNeedRefresh: onUpdateAvailable,
    onRegisteredSW(_url, registration) {
      if (!registration) return
      // Installed home-screen apps can stay open for days: look for a new version regularly
      // and whenever the app comes back to the foreground.
      const check = () => {
        if (navigator.onLine) void registration.update().catch(() => {})
      }
      setInterval(check, CHECK_EVERY)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check()
      })
    },
  })
  return () => update(true)
}
