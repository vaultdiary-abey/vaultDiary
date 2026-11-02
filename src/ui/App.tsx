import { useController } from './controllerContext'
import { useRoute } from './router'
import { Shell } from './Shell'
import { Calendar } from './screens/Calendar'
import { DayView } from './screens/DayView'
import { EntryPage, NewEntry } from './screens/EntryPage'
import { Settings } from './screens/Settings'
import { Setup } from './screens/Setup'
import { Insights } from './screens/Insights'
import { Timeline } from './screens/Timeline'
import { ResetPassphrase, Unlock } from './screens/Unlock'
import { Finding, Unconfigured, Welcome } from './screens/Welcome'
import { Spinner, UpdateBanner } from './components'

function Unlocked() {
  const route = useRoute()
  let page
  switch (route.name) {
    case 'day':
      page = <DayView date={route.date} />
      break
    case 'entry':
      page = <EntryPage key={route.id} id={route.id} edit={route.edit} />
      break
    case 'new':
      page = <NewEntry date={route.date} />
      break
    case 'timeline':
      page = <Timeline key={route.tag ?? ''} tag={route.tag} />
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
  }
  return <Shell route={route}>{page}</Shell>
}

export function App() {
  const c = useController()
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
