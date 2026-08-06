import type { ReactElement } from 'react'
import { readableTextColor } from '../lib/format'

interface TagChipProps {
  name: string
  /** The registry's colour; a tag the registry has never heard of comes without one. */
  color?: string
  className: string
}

/** The one pill for a tag name — the row and the row menu draw the same chip. */
export function TagChip({ name, color, className }: TagChipProps): ReactElement {
  return (
    <span
      className={className}
      style={color ? { background: color, color: readableTextColor(color) } : undefined}
    >
      {name}
    </span>
  )
}
