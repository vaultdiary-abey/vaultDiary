import { useController } from './controllerContext'
import { useRoute } from './router'
import { Shell } from './Shell'
import { Calendar } from './screens/Calendar'
import { DayView } from './screens/DayView'
import { EntryPage, NewEntry } from './screens/EntryPage'
import { Settings } from './screens/Settings'
import { Setup } from './screens/Setup'
import { Insights } from './screens/Insights'
import { Templates } from './screens/Templates'
import { Timeline } from './screens/Timeline'
import { PlacesView } from './screens/PlacesView'
import { ResetPassphrase, Unlock } from './screens/Unlock'
import { Finding, Unconfigured, Welcome } from './screens/Welcome'
import { Spinner, UpdateBanner } from './components'
import { PrintView } from './PrintView'
import { StreamTest } from './screens/StreamTest'

function Unlocked() {
  const c = useController()
  const route = useRoute()
  if (c.printRange) return <PrintView range={c.printRange} includeLocations={c.printLocations} />
  let page
  switch (route.name) {
    case 'day':
      page = <DayView date={route.date} />
      break
    case 'entry':
      page = <EntryPage key={route.id} id={route.id} edit={route.edit} />
      break
    case 'new':
      page = <NewEntry date={route.date} template={route.template} prompt={route.prompt} />
      break
    case 'timeline':
      page = (
        <Timeline
          key={`${route.tag ?? ''}|${route.place ?? ''}`}
          tag={route.tag}
          place={route.place ?? null}
        />
      )
      break
    case 'places':
      page = <PlacesView />
      break
    case 'templates':
      page = <Templates edit={route.edit} />
      break
    case 'insights':
      page = <Insights year={route.year} />
      break
    case 'calendar':
      page = <Calendar month={route.month} />
      break
    case 'settings':
      page = <Settings />
      break
    case 'streamtest':
      page = null
      break
  }
  return <Shell route={route}>{page}</Shell>
}

export function App() {
  const c = useController()
  const route = useRoute()
  // Diagnostics page: works whether the diary is locked or not.
  if (route.name === 'streamtest' && c.phase !== 'boot') {
    return (
      <main className="content">
        <StreamTest />
      </main>
    )
  }
  if (c.phase === 'unlocked') return <Unlocked />
  return (
    <>
      <UpdateBanner top />
      <Gate />
    </>
  )
}

function Gate() {
  const c = useController()
  switch (c.phase) {
    case 'boot':
      return (
        <main className="gate">
          <Spinner label="Starting…" />
        </main>
      )
    case 'unconfigured':
      return <Unconfigured />
    case 'signedOut':
      return <Welcome />
    case 'finding':
      return <Finding />
    case 'setup':
      return <Setup />
    case 'locked':
      return <Unlock />
    case 'resetPassphrase':
      return <ResetPassphrase />
    case 'unlocked':
      return null
  }
}
