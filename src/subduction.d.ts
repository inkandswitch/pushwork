/**
 * Type declarations for optional Subduction packages.
 * Required when use_subduction is true. Install via link or npm if available.
 */
declare module "@automerge/automerge-repo-subduction-bridge" {
  export class SubductionStorageBridge {
    constructor(adapter: unknown);
  }
}

declare module "@automerge/automerge_subduction" {
  export interface SubductionInstance {
    attach(conn: unknown): Promise<void>;
  }
  export const Subduction: {
    hydrate(
      signer: unknown,
      storage: unknown
    ): Promise<SubductionInstance>;
  };
  export const SubductionWebSocket: {
    tryDiscover(
      url: URL,
      signer: unknown,
      host: string,
      timeoutMs: number
    ): Promise<unknown>;
  };
  export const WebCryptoSigner: {
    setup(): Promise<unknown>;
  };
}
