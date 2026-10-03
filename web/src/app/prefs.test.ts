import { describe, expect, it } from 'vitest'
import { isValidName, loadProfile, PALETTE, saveProfile } from './prefs'
import { memoryStorage } from './storage'

describe('profile', () => {
  it('round-trips through storage, trimming the name', () => {
    const storage = memoryStorage()
    saveProfile(storage, { name: '  Sam ', color: PALETTE[3] })
    expect(loadProfile(storage)).toEqual({ name: 'Sam', color: PALETTE[3] })
  })

  it('starts with no name and a palette color picked at random', () => {
    expect(loadProfile(memoryStorage(), () => 0)).toEqual({ name: '', color: PALETTE[0] })
    expect(loadProfile(memoryStorage(), () => 0.99)).toEqual({ name: '', color: PALETTE[PALETTE.length - 1] })
  })

  it('ignores a color that is not in the palette and data that is not a profile', () => {
    const storage = memoryStorage()
    storage.setItem('popcorn.profile', JSON.stringify({ name: 'Sam', color: '#000000' }))
    expect(loadProfile(storage, () => 0)).toEqual({ name: 'Sam', color: PALETTE[0] })
    storage.setItem('popcorn.profile', '{broken')
    expect(loadProfile(storage, () => 0)).toEqual({ name: '', color: PALETTE[0] })
    storage.setItem('popcorn.profile', '42')
    expect(loadProfile(storage, () => 0)).toEqual({ name: '', color: PALETTE[0] })
  })
})

describe('isValidName', () => {
  it('needs 1 to 32 characters after trimming', () => {
    expect(isValidName('')).toBe(false)
    expect(isValidName('   ')).toBe(false)
    expect(isValidName('A')).toBe(true)
    expect(isValidName('a'.repeat(32))).toBe(true)
    expect(isValidName('a'.repeat(33))).toBe(false)
    expect(isValidName('🍿'.repeat(32))).toBe(true)
  })
})
