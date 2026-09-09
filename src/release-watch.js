import fs from 'node:fs'
import { basename, dirname, join } from 'node:path'

const WATCH_RESOURCE_ERRORS = new Set(['ENOSPC', 'EMFILE', 'ENFILE'])

/** Watch one file across atomic replacements, polling when native watcher resources are exhausted. */
export function watchFileChanges(path, onChange, { onFallback, onError } = {}) {
  let closed = false
  const notify = () => { if (!closed) onChange() }
  let stop
  try {
    const watcher = fs.watch(dirname(path), { persistent: false }, (_event, filename) => {
      if (filename == null || String(filename) === basename(path)) notify()
    })
    if (onError) watcher.on('error', (error) => { if (!closed) onError(error) })
    stop = () => watcher.close()
  } catch (error) {
    if (!WATCH_RESOURCE_ERRORS.has(error?.code)) throw error
    const listener = (current, previous) => {
      // watchFile reports an initial missing file with two empty stats.
      if (current.nlink === 0 && previous.nlink === 0) return
      notify()
    }
    fs.watchFile(path, { persistent: false, interval: 1000 }, listener)
    stop = () => fs.unwatchFile(path, listener)
    onFallback?.(error)
  }
  return {
    close() {
      if (closed) return
      closed = true
      stop()
    },
  }
}

/** Watch the active release pointer without requiring native watcher capacity. */
export function watchCurrentRelease(releasesDir, onChange, options) {
  return watchFileChanges(join(releasesDir, 'current.json'), onChange, options)
}
