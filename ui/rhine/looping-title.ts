/** A continuous title loop with one accessible label and two visual copies. */
export function createLoopingTitle(element: HTMLElement, initialText: string) {
  let currentText: string | undefined;
  let currentScrolling = true;
  let track: HTMLSpanElement;
  const measure = new ResizeObserver(entries => {
    const width = entries[0]?.borderBoxSize[0]?.inlineSize;
    if (width) track.style.setProperty('--rhine-title-duration', `${Math.max(10, width / 16)}s`);
  });

  function update(text: string, scrolling = true) {
    // Status snapshots can repeat while an answer streams; keep the loop moving.
    if (text === currentText && scrolling === currentScrolling) return;
    currentText = text;
    currentScrolling = scrolling;
    measure.disconnect();
    element.classList.add('rhine-loop-title');
    element.classList.toggle('is-scrolling', scrolling);
    element.title = text;

    // This label sizes the viewport and is the only text read by assistive tech.
    const label = document.createElement('span');
    label.className = 'rhine-loop-title-label';
    label.textContent = text;
    track = document.createElement('span');
    track.className = 'rhine-loop-title-track';
    track.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < 2; index++) {
      const copy = document.createElement('span');
      copy.className = 'rhine-loop-title-copy';
      copy.textContent = text;
      track.append(copy);
    }
    element.replaceChildren(label, track);
    if (scrolling) measure.observe(track.firstElementChild!, { box: 'border-box' });
  }

  update(initialText);
  return { update, destroy: () => measure.disconnect() };
}
