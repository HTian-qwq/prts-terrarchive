/** Follow the persisted skin without remounting the Agent or losing session data. */
export const isRhineSkin = shared => shared?.effective().uiSkin === 'rhine-lab'

export function followRhineSkin(shared, mount) {
  let disposers = [], mounted = false, stopped = false
  const unmount = () => {
    mounted = false
    const previous = disposers
    disposers = []
    for (const dispose of previous.reverse()) dispose()
  }
  const sync = () => {
    if (stopped || isRhineSkin(shared) === mounted) return
    if (!isRhineSkin(shared)) { unmount(); return }
    try {
      mount(dispose => { if (typeof dispose === 'function') disposers.push(dispose) })
      mounted = true
    } catch (error) { unmount(); throw error }
  }
  sync()
  const unsubscribe = shared.subscribe(sync)
  return () => {
    if (stopped) return
    stopped = true
    unsubscribe()
    unmount()
  }
}
