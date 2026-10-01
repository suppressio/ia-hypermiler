// renderer/dom.ts — typed access to page elements.
// `byId` checks that the element exists and has the expected type: an id renamed in
// HTML fails at once with a clear message, instead of a `null` used further on
// (formerly `document.getElementById('x')!` or `as HTMLInputElement`).

export function byId(id: string): HTMLElement;
export function byId<T extends HTMLElement>(id: string, type: new () => T): T;
export function byId(id: string, type?: new () => HTMLElement): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Element #${id} not found in the page`);
  if (type && !(element instanceof type)) throw new Error(`Element #${id} is not a ${type.name}`);
  return element;
}
