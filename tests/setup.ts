import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
if (!globalThis.CustomEvent) {
  Object.defineProperty(globalThis, 'CustomEvent', {
    value: class CustomEvent<T = unknown> extends Event {
      detail: T;
      constructor(type: string, options?: CustomEventInit<T>) {
        super(type, options);
        this.detail = options?.detail as T;
      }
    },
  });
}
