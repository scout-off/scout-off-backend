import {
  isValidMetadataUri,
  isValidCidUri,
  isValidHttpsUrl,
  isValidEvidenceUri,
  URI_VALIDATION_ERROR,
} from '../../src/utils/uriValidator';

// ---------------------------------------------------------------------------
// Real-world CID fixtures
// ---------------------------------------------------------------------------
const VALID_CID_V0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'; // 46 chars
const VALID_CID_V1_BAFY = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const VALID_CID_V1_BAFK = 'bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4';

// ---------------------------------------------------------------------------
// URI_VALIDATION_ERROR constant
// ---------------------------------------------------------------------------
describe('URI_VALIDATION_ERROR', () => {
  it('contains the required error message text', () => {
    expect(URI_VALIDATION_ERROR).toBe(
      "metadata_uri must be a valid IPFS CID (v0 or v1) or an HTTPS URL"
    );
  });
});

// ---------------------------------------------------------------------------
// isValidCidUri
// ---------------------------------------------------------------------------
describe('isValidCidUri', () => {
  describe('CIDv0 (Qm…, 46 chars)', () => {
    it('accepts a valid CIDv0', () => {
      expect(isValidCidUri(VALID_CID_V0)).toBe(true);
    });

    it('rejects CIDv0 that is too short', () => {
      expect(isValidCidUri('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbd')).toBe(false); // 45 chars
    });

    it('rejects CIDv0 that is too long', () => {
      expect(isValidCidUri(VALID_CID_V0 + 'A')).toBe(false);
    });

    it('rejects CIDv0 with invalid base58 character (0, O, I, l)', () => {
      expect(isValidCidUri('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPb0G')).toBe(false);
    });

    it('rejects a string that starts with Qm but is otherwise wrong', () => {
      expect(isValidCidUri('Qm_invalid!')).toBe(false);
    });
  });

  describe('CIDv1 (bafy… or bafk…)', () => {
    it('accepts a valid CIDv1 bafy CID', () => {
      expect(isValidCidUri(VALID_CID_V1_BAFY)).toBe(true);
    });

    it('accepts a valid CIDv1 bafk CID', () => {
      expect(isValidCidUri(VALID_CID_V1_BAFK)).toBe(true);
    });

    it('rejects a CIDv1 that is too short (< 50 chars total)', () => {
      expect(isValidCidUri('bafyshort')).toBe(false);
    });

    it('rejects a CIDv1 with uppercase letters (base32 is lower-case)', () => {
      expect(isValidCidUri(VALID_CID_V1_BAFY.toUpperCase())).toBe(false);
    });

    it('rejects an ipfs:// prefixed CIDv1 (scheme form)', () => {
      expect(isValidCidUri(`ipfs://${VALID_CID_V1_BAFY}`)).toBe(false);
    });
  });

  describe('non-CID inputs', () => {
    it('rejects empty string', () => expect(isValidCidUri('')).toBe(false));
    it('rejects plain text', () => expect(isValidCidUri('not-a-cid')).toBe(false));
    it('rejects an HTTPS URL', () => expect(isValidCidUri('https://example.com/foo')).toBe(false));
  });
});

// ---------------------------------------------------------------------------
// isValidHttpsUrl
// ---------------------------------------------------------------------------
describe('isValidHttpsUrl', () => {
  it('accepts a simple HTTPS URL', () => {
    expect(isValidHttpsUrl('https://example.com')).toBe(true);
  });

  it('accepts an HTTPS URL with a path', () => {
    expect(isValidHttpsUrl('https://example.com/metadata/player1.json')).toBe(true);
  });

  it('accepts an HTTPS URL with a subdomain', () => {
    expect(isValidHttpsUrl('https://gateway.pinata.cloud/ipfs/Qmabc123')).toBe(true);
  });

  it('accepts an HTTPS URL with query string', () => {
    expect(isValidHttpsUrl('https://api.example.com/v1/data?format=json')).toBe(true);
  });

  it('rejects an HTTP URL', () => {
    expect(isValidHttpsUrl('http://example.com/evidence')).toBe(false);
  });

  it('rejects ipfs:// scheme', () => {
    expect(isValidHttpsUrl(`ipfs://${VALID_CID_V0}`)).toBe(false);
  });

  it('rejects a URL with path traversal (..)', () => {
    expect(isValidHttpsUrl('https://example.com/../etc/passwd')).toBe(false);
  });

  it('rejects a bare https:// with no hostname', () => {
    expect(isValidHttpsUrl('https://')).toBe(false);
  });

  it('rejects a single-label hostname (no TLD)', () => {
    expect(isValidHttpsUrl('https://localhost/foo')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidHttpsUrl('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isValidMetadataUri — primary validator used in Zod schemas
// ---------------------------------------------------------------------------
describe('isValidMetadataUri', () => {
  describe('valid inputs', () => {
    it('accepts a CIDv0', () => {
      expect(isValidMetadataUri(VALID_CID_V0)).toBe(true);
    });

    it('accepts a CIDv1 bafy', () => {
      expect(isValidMetadataUri(VALID_CID_V1_BAFY)).toBe(true);
    });

    it('accepts a CIDv1 bafk', () => {
      expect(isValidMetadataUri(VALID_CID_V1_BAFK)).toBe(true);
    });

    it('accepts an HTTPS URL', () => {
      expect(isValidMetadataUri('https://example.com/metadata.json')).toBe(true);
    });

    it('accepts an HTTPS URL with subdomain and path', () => {
      expect(isValidMetadataUri('https://gateway.pinata.cloud/ipfs/Qmabc')).toBe(true);
    });
  });

  describe('invalid inputs — must return false', () => {
    it('rejects empty string', () => {
      expect(isValidMetadataUri('')).toBe(false);
    });

    it('rejects null', () => {
      expect(isValidMetadataUri(null as unknown as string)).toBe(false);
    });

    it('rejects undefined', () => {
      expect(isValidMetadataUri(undefined as unknown as string)).toBe(false);
    });

    it('rejects ipfs:// CIDv0 (scheme form)', () => {
      expect(isValidMetadataUri(`ipfs://${VALID_CID_V0}`)).toBe(false);
    });

    it('rejects ipfs:// CIDv1 (scheme form)', () => {
      expect(isValidMetadataUri(`ipfs://${VALID_CID_V1_BAFY}`)).toBe(false);
    });

    it('rejects http:// URL', () => {
      expect(isValidMetadataUri('http://example.com/metadata.json')).toBe(false);
    });

    it('rejects a plain string', () => {
      expect(isValidMetadataUri('not-a-uri')).toBe(false);
    });

    it('rejects a malformed CID (wrong prefix)', () => {
      expect(isValidMetadataUri('Xm' + 'A'.repeat(44))).toBe(false);
    });

    it('rejects an HTTPS URL with path traversal', () => {
      expect(isValidMetadataUri('https://example.com/../secret')).toBe(false);
    });

    it('rejects bare https:// with no hostname', () => {
      expect(isValidMetadataUri('https://')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// isValidEvidenceUri — backwards-compat alias
// ---------------------------------------------------------------------------
describe('isValidEvidenceUri (backwards-compat alias)', () => {
  it('delegates to isValidMetadataUri — accepts CIDv0', () => {
    expect(isValidEvidenceUri(VALID_CID_V0)).toBe(true);
  });

  it('delegates to isValidMetadataUri — rejects ipfs:// scheme', () => {
    expect(isValidEvidenceUri(`ipfs://${VALID_CID_V0}`)).toBe(false);
  });

  it('delegates to isValidMetadataUri — accepts HTTPS URL', () => {
    expect(isValidEvidenceUri('https://evidence.example.com/doc.json')).toBe(true);
  });
});
