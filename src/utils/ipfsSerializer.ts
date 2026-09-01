import { gatewayUrl, gatewayUrls } from '../services/ipfs';

export interface IpfsSerializedResult {
  /** IPFS content identifier */
  cid: string;
  /** Full primary gateway URI for the content */
  uri: string;
  /** Full list of gateway URIs for the content (fallbacks included) */
  uris: string[];
  /** Optional metadata associated with the pinned object */
  metadata: Record<string, unknown>;
  /** Storage backend identifier */
  storageProvider: string;
}

/**
 * Normalize raw IPFS pin results into a stable response shape.
 *
 * @param cid - The IPFS content identifier returned by the pin operation.
 * @param metadata - Optional key/value metadata to attach to the response.
 * @param storageProvider - Name of the underlying storage provider (default: "pinata").
 */
export function serializeIpfsResult(
  cid: string,
  metadata: Record<string, unknown> = {},
  storageProvider = 'pinata',
): IpfsSerializedResult {
  return {
    cid,
    uri: gatewayUrl(cid),
    uris: gatewayUrls(cid),
    metadata,
    storageProvider,
  };
}
