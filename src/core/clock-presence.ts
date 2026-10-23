let since: number | undefined =
  typeof document !== 'undefined' && !document.hidden && navigator.onLine ? Date.now() : undefined;
export const foregroundStart = () => since;
export function changeForeground(value: number | undefined) {
  since = value;
}
