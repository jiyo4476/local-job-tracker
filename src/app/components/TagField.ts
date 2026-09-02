import { useState } from 'preact/hooks';
import { html } from '../html';
import {
  addTag,
  removeTagAt,
  TAXONOMY_GROUP_COPY,
  type TaxonomyField,
} from '../../lib/taxonomyFields';

interface Props {
  field: TaxonomyField;
  tags: string[];
  onChange: (tags: string[]) => void;
}

export function TagField({ field, tags, onChange }: Props) {
  const [pending, setPending] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const copy = TAXONOMY_GROUP_COPY[field];

  const commit = () => {
    const raw = pending;
    if (!raw.trim()) {
      setPending('');
      return;
    }

    const parts = raw
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    let next = tags;
    for (const part of parts) {
      const result = addTag(field, next, part);
      if (!result.ok) {
        setError(result.error);
        setPending(part);
        return;
      }
      next = result.tags;
    }

    setError(undefined);
    setPending('');
    onChange(next);
  };

  const remove = (index: number) => {
    onChange(removeTagAt(tags, index));
  };

  const helpId = `help-${field}`;
  const errorId = `error-${field}`;
  const describedBy = error ? `${helpId} ${errorId}` : helpId;

  return html`
    <fieldset class="tag-group">
      <legend>${copy.label}</legend>
      <p class="tag-help" id=${helpId}>${copy.helpText}</p>
      ${
        tags.length === 0
          ? html`<p class="tag-empty">${copy.emptyState}</p>`
          : html`
              <ul class="tag-list">
                ${tags.map(
                  (tag, index) => html`
                    <li class="tag-chip">
                      <span>${tag}</span>
                      <button
                        type="button"
                        aria-label="Remove ${tag} from ${copy.label}"
                        onClick=${() => {
                          remove(index);
                        }}
                      >
                        ×
                      </button>
                    </li>
                  `,
                )}
              </ul>
            `
      }
      <div class="tag-add-row">
        <input
          value=${pending}
          placeholder=${copy.addLabel}
          aria-label=${copy.addLabel}
          aria-describedby=${describedBy}
          onInput=${(event: Event) => {
            setPending((event.target as HTMLInputElement).value);
          }}
          onKeyDown=${(event: KeyboardEvent) => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault();
              commit();
            }
          }}
        />
        <button type="button" onClick=${commit}>Add</button>
      </div>
      ${error ? html`<div id=${errorId} role="alert" class="field-error">${error}</div>` : null}
    </fieldset>
  `;
}
