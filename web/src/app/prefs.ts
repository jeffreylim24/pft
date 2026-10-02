// The name and color someone picks in the lobby, remembered in localStorage.
import { MAX_NAME_CHARS, nameLength } from '../protocol/schemas'
import type { StorageLike } from './storage'

export const PALETTE = ['#e4572e', '#f2a541', '#59a96a', '#2e86ab', '#7b6cf6', '#e055a5'] as const

const KEY = 'popcorn.profile'

export interface Profile {
  name: string
  color: string
}

export function isValidName(name: string): boolean {
  const n = nameLength(name)
  return n >= 1 && n <= MAX_NAME_CHARS
}

/** The saved profile, or an empty name and a random palette color. */
export function loadProfile(storage: StorageLike, random: () => number = Math.random): Profile {
  const fallback: Profile = { name: '', color: PALETTE[Math.floor(random() * PALETTE.length)] }
  let saved: unknown
  try {
    saved = JSON.parse(storage.getItem(KEY) ?? 'null')
  } catch {
    return fallback
  }
  if (typeof saved !== 'object' || saved === null) return fallback
  const { name, color } = saved as Record<string, unknown>
  return {
    name: typeof name === 'string' ? name : '',
    color: typeof color === 'string' && (PALETTE as readonly string[]).includes(color) ? color : fallback.color,
  }
}

export function saveProfile(storage: StorageLike, profile: Profile): void {
  storage.setItem(KEY, JSON.stringify({ name: profile.name.trim(), color: profile.color }))
}
