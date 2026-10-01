/** Presentation context never grants authority. Hosts validate their own routes and identities. */
export type SurfaceSnapshot<Route, Selection extends object> = Readonly<
  Partial<Selection> & { version: 1; route: Route; contextRevision: string }
>;

export class SurfaceContextError extends Error {
  constructor(readonly code: "scope_required" | "context_changed" | "invalid_target") {
    super(code);
  }
}

export function createSurfaceContext<Route, Selection extends object>(options: {
  route: Route;
  /** Throws when the host-specific admitted selection is invalid. */
  validate: (selection: Selection) => void;
  /** Tests can supply a deterministic identity; live mounts must use a fresh identity. */
  lifetimeId?: string;
}) {
  const lifetime = options.lifetimeId ?? crypto.randomUUID();
  let generation = 0;
  let stopped = false;
  let controller = new AbortController();
  let snapshot = Object.freeze({ version: 1 as const, route: options.route, contextRevision: lifetime + ":0" }) as SurfaceSnapshot<Route, Selection>;
  function clear(next: Route = snapshot.route) {
    controller.abort();
    controller = new AbortController();
    snapshot = Object.freeze({ version: 1 as const, route: next, contextRevision: lifetime + ":" + ++generation }) as SurfaceSnapshot<Route, Selection>;
    if (stopped) controller.abort();
  }
  return {
    snapshot: () => snapshot,
    get signal() { return controller.signal; },
    /** Only the first successful admission for the current generation can publish. */
    begin(next: Route) {
      clear(next);
      const ticket = generation;
      let admitted = false;
      return (selection: Selection) => {
        if (stopped || admitted || ticket !== generation) return false;
        options.validate(selection);
        admitted = true;
        clear(next);
        // Reserved context fields cannot be replaced by a host's selection object.
        snapshot = Object.freeze({ ...selection, ...snapshot });
        return true;
      };
    },
    clear,
    async revalidate(check: (selection: SurfaceSnapshot<Route, Selection>, signal: AbortSignal) => Promise<void>) {
      const captured = snapshot;
      const signal = controller.signal;
      if (stopped) throw new SurfaceContextError("context_changed");
      await check(captured, signal);
      if (stopped || signal.aborted || captured !== snapshot) throw new SurfaceContextError("context_changed");
      return captured;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clear();
    },
  };
}
