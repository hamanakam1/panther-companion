import type { WriterClaim } from "../state/writer.js";

type OwnerResources = {
  claim: WriterClaim;
  store?: { close(): void };
  controller?: { stop(): void };
  server?: { listening: boolean; close(callback: () => void): unknown };
};

/** Also covers startup that fails after opening only some resources. */
export function ownerCleanup(resources: () => OwnerResources): () => void {
  let closing = false;
  return () => {
    if (closing) return;
    closing = true;
    const { claim, store, controller, server } = resources();
    const closeStore = () => { if (store) store.close(); else claim.release(); };
    try { controller?.stop(); }
    finally {
      // The writable Store owns the claim. Close it only after HTTP requests
      // finish, so no accepted request can outlive its writer authority.
      if (server?.listening) server.close(closeStore);
      else closeStore();
    }
  };
}
