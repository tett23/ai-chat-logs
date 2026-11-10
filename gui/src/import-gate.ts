// docs/adr/0032: one import operation across the browse and admin screens.
export const createImportGate = () => {
  let active = false;
  const listeners = new Set<(running: boolean) => void>();
  const notify = () => listeners.forEach((listener) => listener(active));
  return {
    running: () => active,
    subscribe: (listener: (running: boolean) => void) => {
      listeners.add(listener);
      listener(active);
      return () => listeners.delete(listener);
    },
    run: async <T>(task: () => Promise<T>): Promise<{ started: false } | { started: true; value: T }> => {
      if (active) return { started: false };
      active = true;
      notify();
      try {
        return { started: true, value: await task() };
      } finally {
        active = false;
        notify();
      }
    },
  };
};

export const importGate = createImportGate();
