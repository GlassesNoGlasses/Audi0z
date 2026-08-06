import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TagChip } from './TagChip'

describe('TagChip', () => {
  it('paints the registry colour with readable ink', () => {
    render(<TagChip name="slowed" color="#e0a35c" className="song-tag" />)
    const chip = screen.getByText('slowed')
    expect(chip).toHaveClass('song-tag')
    expect(chip).toHaveStyle({ backgroundColor: '#e0a35c', color: '#000000' })
  })

  it('stays unstyled for a tag the registry has never heard of', () => {
    render(<TagChip name="bootleg" className="song-tag" />)
    expect(screen.getByText('bootleg')).not.toHaveAttribute('style')
  })
})
