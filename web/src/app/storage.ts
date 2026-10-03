export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/**
 * localStorage or sessionStorage, or an in-memory stand-in when the browser
 * blocks storage (some private modes do). Writes never throw.
 */
export function browserStorage(kind: 'localStorage' | 'sessionStorage'): StorageLike {
  try {
    const storage = globalThis[kind]
    storage.setItem('popcorn.probe', '1')
    storage.removeItem('popcorn.probe')
    return {
      getItem: (key) => storage.getItem(key),
      setItem: (key, value) => {
        try {
          storage.setItem(key, value)
        } catch {
          // Full or blocked: remembering is a convenience, not a requirement.
        }
      },
      removeItem: (key) => storage.removeItem(key),
    }
  } catch {
    return memoryStorage()
  }
}

export function memoryStorage(): StorageLike {
  const items = new Map<string, string>()
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  }
}
