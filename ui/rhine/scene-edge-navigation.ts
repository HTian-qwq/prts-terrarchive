import type { RhineLocation } from './types';

const STOPS: { id: RhineLocation; label: string }[] = [
  { id: 'archive', label: '检索阵列' }, { id: 'board', label: '证据板' }, { id: 'desk', label: '档案收录架' },
];
type Options = {
  location: () => RhineLocation;
  available: () => boolean;
  navigate: (location: RhineLocation) => void;
  returnFocus: () => void;
};

/** Screen-edge buttons share the scene's existing navigation and never consume canvas drags. */
export function mountSceneEdgeNavigation(host: HTMLElement, options: Options) {
  const events = new AbortController(), signal = events.signal;
  const nav = document.createElement('nav');
  nav.className = 'rhine-scene-edges'; nav.setAttribute('aria-label', '相邻场景'); nav.hidden = true;
  let disposed = false;
  let press: { button: HTMLButtonElement; pointer: number; origin: RhineLocation; target: RhineLocation;
    x: number; y: number; moved: boolean; released: boolean } | null = null;
  const reset = () => { press = null; };
  const controls = ([-1, 1] as const).map(direction => {
    const button = document.createElement('button'); button.type = 'button';
    button.className = `rhine-scene-edge is-${direction < 0 ? 'left' : 'right'}`;
    button.dataset.direction = direction < 0 ? 'left' : 'right';
    button.innerHTML = `<span class="rhine-scene-edge-marker" aria-hidden="true"></span>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${direction < 0 ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'}"/></svg>
      <span class="rhine-scene-edge-label" aria-hidden="true"></span>`;
    button.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0 || !options.available()) return;
      const target = destination(direction); if (!target) return;
      press = { button, pointer: event.pointerId, origin: options.location(), target: target.id,
        x: event.clientX, y: event.clientY, moved: false, released: false };
    }, { signal });
    button.addEventListener('click', event => {
      const gesture = press; reset();
      if (disposed || !options.available() || event.detail > 1) return;
      const target = destination(direction); if (!target) return;
      // Keyboard and assistive activation have detail 0. Pointer clicks must
      // begin here and stay a click, even if dragged out and back into the strip.
      if (event.detail !== 0 && (!gesture || gesture.button !== button || !gesture.released || gesture.moved
        || gesture.origin !== options.location() || gesture.target !== target.id)) return;
      const focused = document.activeElement === button;
      options.navigate(target.id); sync();
      if (focused && button.hidden) options.returnFocus();
    }, { signal });
    button.addEventListener('keydown', event => {
      if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
    }, { signal });
    nav.append(button);
    return { button, direction };
  });
  host.append(nav);
  function destination(direction: number) { return STOPS[STOPS.findIndex(stop => stop.id === options.location()) + direction]; }
  function sync() {
    if (disposed) return;
    nav.hidden = !options.available();
    if (nav.hidden) reset();
    for (const { button, direction } of controls) {
      const target = destination(direction); button.hidden = !target;
      if (!target) { delete button.dataset.target; continue; }
      button.dataset.target = target.id;
      button.setAttribute('aria-label', `前往${target.label}`);
      button.querySelector('.rhine-scene-edge-label')!.textContent = target.label;
      button.querySelector('.rhine-scene-edge-marker')!.textContent = String(STOPS.indexOf(target) + 1).padStart(2, '0');
    }
  }
  // Observe the full gesture without capturing it away from native buttons or
  // the canvas. A canceled pointer can never arm a later synthetic mouse click.
  window.addEventListener('pointerdown', reset, { capture: true, signal });
  window.addEventListener('pointermove', event => {
    if (press?.pointer === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) >= 6) press.moved = true;
  }, { capture: true, signal });
  window.addEventListener('pointerup', event => {
    if (press?.pointer !== event.pointerId) return;
    press.released = true;
    const bounds = press.button.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) press.moved = true;
  }, { capture: true, signal });
  window.addEventListener('pointercancel', reset, { signal });
  window.addEventListener('blur', reset, { signal });
  sync();
  return { sync, dispose() { disposed = true; reset(); events.abort(); nav.remove(); } };
}
