export const vfsEvents = new EventTarget();

export function emitVfsChange(path: string) {
  vfsEvents.dispatchEvent(new CustomEvent('vfs:change', { detail: { path } }));
}