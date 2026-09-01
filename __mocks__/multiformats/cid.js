// Minimal CJS stand-in for the ESM-only 'multiformats/cid' package, which
// Jest (running under CommonJS ts-jest) cannot resolve directly.
class CID {
  static parse(source) {
    if (typeof source !== 'string' || source.length === 0) {
      throw new Error('invalid CID');
    }
    return new CID();
  }
}

module.exports = { CID };
