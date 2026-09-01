let counter = 0;
module.exports = {
  createId: () => `test-id-${++counter}`,
  init: () => () => `test-id-${++counter}`,
  getConstants: () => ({ bigLength: 25, length: 24 }),
  isCuid: () => true,
};
