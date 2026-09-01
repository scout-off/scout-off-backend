// Verifies gatewayUrls() actually resolves gateways under the default
// (IPFS_GATEWAYS unset) configuration — regression coverage for #1022,
// where a truthiness bug in config.ts made config.pinata.gateways silently
// evaluate to an empty array.
import { gatewayUrls } from '../../src/services/ipfs';

describe('gatewayUrls (default config)', () => {
  it('returns one URL per default gateway when IPFS_GATEWAYS is unset', () => {
    const urls = gatewayUrls('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi');

    expect(urls.length).toBeGreaterThan(0);
    expect(urls).toEqual([
      'https://gateway.pinata.cloud/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      'https://cloudflare-ipfs.com/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      'https://ipfs.io/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    ]);
  });
});
