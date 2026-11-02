/// <reference lib="webworker" />
// The app's service worker. Same behaviour as the Workbox-generated one it replaces (Phase 3,
// milestone B), plus streaming playback:
//   - precaches the app shell and serves index.html for navigations (offline use);
//   - activates a new version only when the page asks (the "Update available — Reload" prompt);
//   - never touches Google requests;
//   - answers <scope>stream/<token>/… media requests with bytes it asks the page for.
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import {
  STREAM_PROTOCOL_VERSION,
  streamToken,
  type PageToWorker,
  type PingReply,
} from './stream/protocol'
import { linkTo, streamResponse, type PageLink } from './stream/workerHandler'

declare const self: ServiceWorkerGlobalScope

/** token → id of the page that registered it. Lost when the worker restarts; then we search. */
const owners = new Map<string, string>()

self.addEventListener('message', (event) => {
  const data = event.data as PageToWorker | { type: 'SKIP_WAITING' } | undefined
  if (!data || typeof data !== 'object') return
  switch (data.type) {
    case 'SKIP_WAITING':
      void self.skipWaiting()
      break
    case 'vd-stream-ping': {
      const reply: PingReply = { type: 'vd-stream-pong', version: STREAM_PROTOCOL_VERSION }
      event.ports[0]?.postMessage(reply)
      break
    }
    case 'vd-stream-register':
      if (event.source && 'id' in event.source) owners.set(data.token, event.source.id)
      break
    case 'vd-stream-unregister':
      owners.delete(data.token)
      break
  }
})

async function candidates(token: string, clientId: string): Promise<PageLink[]> {
  const ids = [owners.get(token), clientId].filter((id): id is string => !!id)
  const seen = new Set<string>()
  const out: PageLink[] = []
  for (const id of ids) {
    const client = await self.clients.get(id)
    if (client && !seen.has(client.id)) {
      seen.add(client.id)
      out.push(linkTo(client))
    }
  }
  // Worker restarted, or the browser didn't say which page made the request: ask them all.
  for (const client of await self.clients.matchAll({ type: 'window' })) {
    if (!seen.has(client.id)) {
      seen.add(client.id)
      out.push(linkTo(client))
    }
  }
  return out
}

// Registered before Workbox's routes, so stream requests never reach them.
self.addEventListener('fetch', (event) => {
  const token = streamToken(event.request.url, self.registration.scope)
  if (!token) return
  event.respondWith(
    candidates(token, event.clientId || event.resultingClientId).then((pages) =>
      streamResponse(event.request, token, pages),
    ),
  )
})

precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: [/recovery\.html$/] }),
)
