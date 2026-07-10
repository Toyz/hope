// lazyHost lazily creates a singleton custom-element host, appends it to <body>
// once, and returns it (typed) on every call. The DI services that front a global
// surface — toast, prompt, confirm, proc — each had the identical
// create-on-first-use block; this is that block, once.
export function lazyHost<T>(tag: string): () => T {
  let host: T | null = null;
  return () => {
    if (!host) {
      const el = document.createElement(tag);
      document.body.appendChild(el);
      host = el as unknown as T;
    }
    return host;
  };
}
