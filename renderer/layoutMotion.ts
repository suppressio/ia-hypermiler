export const LAYOUT_MOTION_MS = 200;

export function flipDelta(first: { left: number; top: number }, last: { left: number; top: number }): { x: number; y: number } {
  return { x: first.left - last.left, y: first.top - last.top };
}

// Keep IPC requests in order, but let repeated clicks replace the desired state.
export function createCompactTransition(options: {
  isCompact(): boolean;
  effects(): boolean;
  animate(expanding: boolean): Promise<void>;
  finish(): void;
  resize(compact: boolean): Promise<unknown>;
  apply(compact: boolean): void;
}): { toggle(): Promise<void> } {
  let target: boolean | null = null;
  let pending: Promise<void> | null = null;
  const run = async (): Promise<void> => {
    try {
      while (target !== null && target !== options.isCompact()) {
        const next = target;
        if (next && options.effects()) await options.animate(false);
        if (next !== target) continue;
        await options.resize(next);
        options.apply(next);
        if (!next && next === target && options.effects()) await options.animate(true);
      }
    } finally {
      options.finish();
      target = null;
      pending = null;
    }
  };
  return {
    toggle(): Promise<void> {
      target = !(target ?? options.isCompact());
      options.finish();
      pending ??= run();
      return pending;
    },
  };
}

// Finishing a batch restores styles and resolves its waiters even when hidden.
export function createLayoutAnimation(hold = false): {
  play(animations: { finished: Promise<unknown>; cancel(): void }[], cleanup?: () => void): Promise<void>;
  finish(): void;
} {
  let finish = (): void => {};
  return {
    finish(): void { finish(); },
    play(animations, cleanup = (): void => {}): Promise<void> {
      finish();
      return new Promise((resolve) => {
        const complete = (): void => {
          if (finish !== complete) return;
          finish = (): void => {};
          for (const animation of animations) animation.cancel();
          cleanup();
          resolve();
        };
        finish = complete;
        // Handle cancellation too: Animation.finished rejects on cancel().
        void Promise.all(animations.map((animation) => animation.finished.catch(() => {}))).then(() => {
          // Compact exits stay invisible while the resize IPC is in flight.
          if (hold) resolve();
          else complete();
        });
      });
    },
  };
}

export function fadeSlide(element: HTMLElement, expanding: boolean): Animation {
  const frames = [
    { opacity: 0, transform: 'translateY(-6px)' },
    { opacity: getComputedStyle(element).opacity, transform: 'translateY(0)' },
  ];
  return element.animate(expanding ? frames : frames.reverse(), {
    duration: LAYOUT_MOTION_MS, easing: 'ease-out', fill: 'both',
  });
}

export function initDetailsMotion(effects: () => boolean): { finish(): void } {
  const transition = createLayoutAnimation();
  for (const details of Array.from(document.querySelectorAll<HTMLDetailsElement>('details.tips-section'))) {
    const summary = details.querySelector('summary');
    const content = details.querySelector<HTMLElement>(':scope > div');
    if (!summary || !content) continue;
    summary.addEventListener('click', (event) => {
      event.preventDefault();
      transition.finish();
      const opening = !details.open;
      if (!effects()) { details.open = opening; return; }
      const siblings = Array.from(details.parentElement?.children ?? [])
        .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== details);
      const first = siblings.map((element) => element.getBoundingClientRect());
      const width = content.style.width;
      if (opening) details.open = true;
      else {
        // Remove the body from flow once, keeping it visible until its exit ends.
        content.style.width = `${content.getBoundingClientRect().width}px`;
        details.classList.add('details-closing');
      }
      const last = siblings.map((element) => element.getBoundingClientRect());
      const animations = siblings.flatMap((element, i) => {
        const before = first[i];
        const after = last[i];
        if (!before || !after || !before.height || !after.height) return [];
        const { x, y } = flipDelta(before, after);
        if (x === 0 && y === 0) return [];
        return [element.animate([
          { transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' },
        ], { duration: LAYOUT_MOTION_MS, easing: 'ease-out' })];
      });
      animations.push(fadeSlide(content, opening));
      void transition.play(animations, () => {
        details.open = opening;
        details.classList.remove('details-closing');
        content.style.width = width;
      });
    });
  }
  return transition;
}
