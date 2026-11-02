// Entry templates (stored encrypted in settings.vds, synced between devices).
import { useState, type FormEvent } from 'react'
import { liveTemplates, saveTemplate, deleteTemplate, type Template } from '../../model/settings'
import { tagCounts } from '../../model/tags'
import { Card, ErrorNote } from '../components'
import { useController } from '../controllerContext'
import { href, navigate } from '../router'
import { TagEditor } from '../TagEditor'

function TemplateForm({ template }: { template: Template | null }) {
  const c = useController()
  const session = c.session!
  const [name, setName] = useState(template?.name ?? '')
  const [title, setTitle] = useState(template?.title ?? '')
  const [body, setBody] = useState(template?.body ?? '')
  const [tags, setTags] = useState<string[]>(template?.tags ?? [])
  const [error, setError] = useState<string | null>(null)
  const known = tagCounts(session.list().map((i) => (i.kind === 'entry' ? i.entry : i.summary)))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      await session.saveSettings(
        saveTemplate(session.settings, { id: template?.id, name, title, body, tags }),
      )
      navigate({ name: 'templates', edit: null }, true)
    } catch (err) {
      setError((err as Error).message)
    }
  }
  const remove = async () => {
    if (!template || !confirm(`Delete the template "${template.name}"? Entries made with it stay.`))
      return
    await session.saveSettings(deleteTemplate(session.settings, template.id))
    navigate({ name: 'templates', edit: null }, true)
  }

  return (
    <form className="stack" onSubmit={submit}>
      <h1>{template ? 'Edit template' : 'New template'}</h1>
      <div className="field">
        <label htmlFor="tpl-name">Template name</label>
        <input
          id="tpl-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Gratitude, Workout, Evening review"
          maxLength={60}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="tpl-title">Entry title</label>
        <input
          id="tpl-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Empty: the date and entry number"
          maxLength={120}
        />
      </div>
      <div className="field">
        <label htmlFor="tpl-body">Entry text (Markdown)</label>
        <textarea
          id="tpl-body"
          className="body-input template-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={'## Three good things\n1. \n2. \n3. \n\n## Tomorrow I want to'}
        />
      </div>
      <div className="field">
        <span className="label-like">Tags added to the entry</span>
        <TagEditor tags={tags} known={known} onChange={setTags} />
      </div>
      <ErrorNote message={error} onClose={() => setError(null)} />
      <div className="row">
        <button className="primary" type="submit">
          Save template
        </button>
        <a className="ghost button-like" href={href({ name: 'templates', edit: null })}>
          Cancel
        </a>
        {template && (
          <button type="button" className="ghost danger" onClick={() => void remove()}>
            Delete
          </button>
        )}
      </div>
    </form>
  )
}

export function Templates({ edit }: { edit: string | null }) {
  const c = useController()
  const session = c.session
  if (!session || c.readOnly) return null
  const templates = liveTemplates(session.settings)
  if (edit) {
    const template = templates.find((t) => t.id === edit) ?? null
    return (
      <div className="page">
        <TemplateForm key={edit} template={template} />
      </div>
    )
  }
  return (
    <div className="page">
      <h1>Templates</h1>
      <p className="muted small">
        Start an entry from a template on the Today page. Templates are encrypted and sync to your
        other devices.
      </p>
      <Card>
        {templates.length === 0 ? (
          <p className="small">No templates yet.</p>
        ) : (
          <ul className="template-list">
            {templates.map((t) => (
              <li key={t.id}>
                <a href={href({ name: 'templates', edit: t.id })}>
                  <strong>{t.name}</strong>
                  <span className="muted small">
                    {t.title || 'Date · Entry n'}
                    {t.tags.length ? ` · ${t.tags.map((x) => `#${x}`).join(' ')}` : ''}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
        <a className="primary button-like" href={href({ name: 'templates', edit: 'new' })}>
          New template
        </a>
      </Card>
      <p>
        <a href={href({ name: 'settings' })}>‹ Settings</a>
      </p>
    </div>
  )
}
