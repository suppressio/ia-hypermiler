type Column = string | { digits: number[] };

export function odometerColumns(previous: string | null, value: string, decimalSeparator = '.'): Column[] | null {
  if (previous === null || previous === value || !/\d/.test(previous) || !/\d/.test(value)) return null;
  const digitsOf = (text: string): string => text.replace(/\D/g, '');
  const [integer = '', fraction = ''] = previous.split(decimalSeparator);
  const fractionLength = digitsOf(value.split(decimalSeparator)[1] ?? '').length;
  const before = Array.from(digitsOf(integer) + digitsOf(fraction).padEnd(fractionLength, '0').slice(0, fractionLength), Number);
  let position = digitsOf(value).length;
  return Array.from(value, (char): Column => {
    if (!/\d/.test(char)) return char;
    const old = before[before.length - position--] ?? 0;
    const digit = Number(char);
    if (old === digit) return char;
    const steps = (digit - old + 10) % 10;
    return { digits: Array.from({ length: steps + 1 }, (_, i) => (old + i) % 10) };
  });
}

const pending = new WeakMap<HTMLElement, () => void>();

export function finishOdometer(element: HTMLElement): void {
  pending.get(element)?.();
}

export function renderOdometer(element: HTMLElement, value: string, animate: boolean, decimalSeparator = '.'): void {
  const previous = element.dataset.odometerValue ?? null;
  if (previous === value) {
    if (!animate) finishOdometer(element);
    return;
  }
  finishOdometer(element);
  element.dataset.odometerValue = value;
  const columns = animate ? odometerColumns(previous, value, decimalSeparator) : null;
  if (!columns) { element.textContent = value; return; }
  const accessible = document.createElement('span');
  accessible.className = 'odometer-label';
  accessible.textContent = value;
  const visual = document.createElement('span');
  visual.setAttribute('aria-hidden', 'true');
  const strips: { element: HTMLSpanElement; steps: number }[] = [];
  for (const column of columns) {
    if (typeof column === 'string') { visual.append(column); continue; }
    const box = document.createElement('span');
    box.className = 'odometer-digit';
    const strip = document.createElement('span');
    strip.className = 'odometer-strip';
    for (const digit of column.digits) {
      const row = document.createElement('span');
      row.textContent = String(digit);
      strip.append(row);
    }
    box.append(strip);
    visual.append(box);
    strips.push({ element: strip, steps: column.digits.length - 1 });
  }
  element.replaceChildren(accessible, visual);
  // Commit the starting position once; CSS handles every subsequent frame.
  element.getBoundingClientRect();
  for (const strip of strips) strip.element.style.transform = `translateY(-${strip.steps}em)`;
  const finish = (): void => {
    element.removeEventListener('transitionend', finish);
    element.textContent = value;
    pending.delete(element);
  };
  pending.set(element, finish);
  element.addEventListener('transitionend', finish, { once: true });
  if (strips.length === 0) finish();
}
