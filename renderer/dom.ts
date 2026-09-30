// renderer/dom.ts — accesso tipizzato agli elementi della pagina.
// `byId` verifica che l'elemento esista e sia del tipo atteso: un id rinominato
// in HTML fallisce subito con un messaggio chiaro, invece di un `null` usato più
// avanti (prima: `document.getElementById('x')!` o `as HTMLInputElement`).

export function byId(id: string): HTMLElement;
export function byId<T extends HTMLElement>(id: string, type: new () => T): T;
export function byId(id: string, type?: new () => HTMLElement): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Elemento #${id} non trovato nella pagina`);
  if (type && !(element instanceof type)) throw new Error(`Elemento #${id} non è un ${type.name}`);
  return element;
}
