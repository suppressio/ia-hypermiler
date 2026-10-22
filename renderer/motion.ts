export function motionState(enabled: boolean, reduced: boolean, visible: boolean): { effects: boolean; rotateRefresh: boolean } {
  return { effects: enabled && !reduced && visible, rotateRefresh: !enabled && !reduced && visible };
}

// No interval or animation runs between pulses; stopping also cancels a pulse in progress.
export function createAlarmPulse(show: (active: boolean) => void): { setActive(active: boolean): void } {
  let active = false;
  let next: ReturnType<typeof setTimeout> | undefined;
  let end: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    next = setTimeout(() => {
      show(true);
      end = setTimeout(() => { end = undefined; show(false); }, 1500);
      schedule();
    }, 10000);
  };
  return {
    setActive(value): void {
      if (value === active) return;
      active = value;
      if (active) schedule();
      else {
        if (end !== undefined) show(false);
        clearTimeout(next);
        clearTimeout(end);
        next = undefined;
        end = undefined;
      }
    },
  };
}
