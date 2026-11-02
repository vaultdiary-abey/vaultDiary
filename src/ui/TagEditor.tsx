import { useState, type KeyboardEvent } from 'react'
import { addTag, removeTag, suggestTags, type TagCount } from '../model/tags'

/** Tags on an entry: chips with remove buttons, and an input that suggests known tags. */
export function TagEditor({
  tags,
  known,
  onChange,
}: {
  tags: string[]
  known: TagCount[]
  onChange: (tags: string[]) => void
}) {
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const suggestions = focused ? suggestTags(known, text, tags) : []
  const add = (raw: string) => {
    const next = addTag(tags, raw)
    if (next !== tags) onChange(next)
    setText('')
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === ',') && text.trim()) {
      e.preventDefault()
      add(text)
    } else if (e.key === 'Backspace' && !text && tags.length) {
      onChange(tags.slice(0, -1))
    }
  }
  return (
    <div className="tag-editor">
      <div className="chips">
        {tags.map((t) => (
          <span key={t} className="chip selected">
            #{t}
            <button
              className="chip-x"
              onClick={() => onChange(removeTag(tags, t))}
              aria-label={`Remove tag ${t}`}
            >
              ✕
            </button>
          </span>
        ))}
        <input
          className="tag-input"
          value={text}
          placeholder={tags.length ? 'Add tag' : 'Add tags'}
          aria-label="Add a tag"
          onChange={(e) => {
            const v = e.target.value
            // Typing a comma adds what came before it.
            if (v.includes(',')) {
              for (const part of v.split(',').slice(0, -1)) add(part)
              setText(v.split(',').pop() ?? '')
            } else setText(v)
          }}
          onKeyDown={onKey}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            // Let a tap on a suggestion land first.
            setTimeout(() => setFocused(false), 150)
            if (text.trim()) add(text)
          }}
          autoCapitalize="none"
          autoCorrect="off"
          enterKeyHint="done"
        />
      </div>
      {suggestions.length > 0 && (
        <div className="chips suggestions" role="listbox" aria-label="Tag suggestions">
          {suggestions.map((s) => (
            <button
              key={s}
              className="chip"
              role="option"
              aria-selected={false}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => add(s)}
            >
              #{s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
