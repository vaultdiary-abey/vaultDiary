import { useSyncExternalStore } from 'react'

export type Route =
  | { name: 'day'; date: string | null }
  | { name: 'entry'; id: string; edit: boolean }
  | { name: 'new'; date: string | null; template?: string | null; prompt?: number | null }
  | { name: 'templates'; edit: string | null }
  | { name: 'timeline'; tag: string | null; place?: string | null }
  /** Places entries were written at, with counts (Timeline → Places). */
  | { name: 'places' }
  | { name: 'insights'; year: number | null }
  | { name: 'calendar'; month: string | null }
  | { name: 'settings' }
  /** Diagnostics: does streaming playback work in this browser? Works locked or unlocked. */
  | { name: 'streamtest' }

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  const [head, a, b] = parts
  const date = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)
  switch (head) {
    case 'day':
      return { name: 'day', date: date(a) }
    case 'entry':
      return a && /^[0-9a-f]{32}$/.test(a)
        ? { name: 'entry', id: a, edit: b === 'edit' }
        : { name: 'day', date: null }
    case 'new': {
      const [, , kind, value] = parts
      return {
        name: 'new',
        date: date(a),
        template: kind === 't' && value && /^[0-9a-f]{32}$/.test(value) ? value : null,
        prompt: kind === 'p' && value && /^-?\d{1,4}$/.test(value) ? Number(value) : null,
      }
    }
    case 'templates':
      return { name: 'templates', edit: a === 'new' || (a && /^[0-9a-f]{32}$/.test(a)) ? a : null }
    case 'timeline': {
      let value: string | null = null
      if ((a === 'tag' || a === 'place') && b) {
        try {
          value = decodeURIComponent(b)
        } catch {
          value = null
        }
      }
      return a === 'place'
        ? { name: 'timeline', tag: null, place: value }
        : { name: 'timeline', tag: a === 'tag' ? value : null }
    }
    case 'places':
      return { name: 'places' }
    case 'insights':
      return { name: 'insights', year: a && /^\d{4}$/.test(a) ? Number(a) : null }
    case 'calendar':
      return { name: 'calendar', month: a && /^\d{4}-\d{2}$/.test(a) ? a : null }
    case 'settings':
      return { name: 'settings' }
    case 'stream-test':
      return { name: 'streamtest' }
    default:
      return { name: 'day', date: null }
  }
}

export function href(route: Route): string {
  switch (route.name) {
    case 'day':
      return route.date ? `#/day/${route.date}` : '#/'
    case 'entry':
      return `#/entry/${route.id}${route.edit ? '/edit' : ''}`
    case 'new': {
      const base = `#/new/${route.date ?? 'today'}`
      if (route.template) return `${base}/t/${route.template}`
      if (route.prompt !== null && route.prompt !== undefined) return `${base}/p/${route.prompt}`
      return route.date ? base : '#/new'
    }
    case 'templates':
      return route.edit ? `#/templates/${route.edit}` : '#/templates'
    case 'timeline':
      if (route.place) return `#/timeline/place/${encodeURIComponent(route.place)}`
      return route.tag ? `#/timeline/tag/${encodeURIComponent(route.tag)}` : '#/timeline'
    case 'places':
      return '#/places'
    case 'insights':
      return route.year ? `#/insights/${route.year}` : '#/insights'
    case 'calendar':
      return route.month ? `#/calendar/${route.month}` : '#/calendar'
    case 'settings':
      return '#/settings'
    case 'streamtest':
      return '#/stream-test'
  }
}

export function navigate(route: Route, replace = false): void {
  const target = href(route)
  if (replace) {
    history.replaceState(null, '', target)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  } else {
    location.hash = target
  }
}

function subscribe(cb: () => void) {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => location.hash)
  return parseRoute(hash)
}
