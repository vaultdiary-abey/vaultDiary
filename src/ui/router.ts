import { useSyncExternalStore } from 'react'

export type Route =
  | { name: 'day'; date: string | null }
  | { name: 'entry'; id: string; edit: boolean }
  | { name: 'new'; date: string | null }
  | { name: 'timeline'; tag: string | null }
  | { name: 'insights'; year: number | null }
  | { name: 'calendar'; month: string | null }
  | { name: 'settings' }

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
    case 'new':
      return { name: 'new', date: date(a) }
    case 'timeline': {
      let tag: string | null = null
      if (a === 'tag' && b) {
        try {
          tag = decodeURIComponent(b)
        } catch {
          tag = null
        }
      }
      return { name: 'timeline', tag }
    }
    case 'insights':
      return { name: 'insights', year: a && /^\d{4}$/.test(a) ? Number(a) : null }
    case 'calendar':
      return { name: 'calendar', month: a && /^\d{4}-\d{2}$/.test(a) ? a : null }
    case 'settings':
      return { name: 'settings' }
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
    case 'new':
      return route.date ? `#/new/${route.date}` : '#/new'
    case 'timeline':
      return route.tag ? `#/timeline/tag/${encodeURIComponent(route.tag)}` : '#/timeline'
    case 'insights':
      return route.year ? `#/insights/${route.year}` : '#/insights'
    case 'calendar':
      return route.month ? `#/calendar/${route.month}` : '#/calendar'
    case 'settings':
      return '#/settings'
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
