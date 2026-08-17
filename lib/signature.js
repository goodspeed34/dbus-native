// parse signature from string to tree

const match = {
  '{': '}',
  '(': ')'
};

const knownTypes = {};
'(){}ybnqiuxtdsogarvehm*?@&^'.split('').forEach(c => {
  knownTypes[c] = true;
});

function parseSignature(signature) {
  let index = 0;
  function next() {
    if (index < signature.length) {
      const c = signature[index];
      ++index;
      return c;
    }
    return null;
  }

  function parseOne(c) {
    function checkNotEnd(c) {
      if (!c) throw new Error('Bad signature: unexpected end');
      return c;
    }

    if (!knownTypes[c])
      throw new Error(`Unknown type: "${c}" in signature "${signature}"`);

    let ele;
    const res = { type: c, child: [] };
    switch (c) {
      case 'a': // array
        ele = next();
        checkNotEnd(ele);
        res.child.push(parseOne(ele));
        return res;
      case '{': // dict entry
      case '(': // struct
        while ((ele = next()) !== null && ele !== match[c])
          res.child.push(parseOne(ele));
        checkNotEnd(ele);
        return res;
    }
    return res;
  }

  const ret = [];
  let c;
  while ((c = next()) !== null) ret.push(parseOne(c));
  return ret;
}

// Signatures repeat constantly -- the same handful appear on every message,
// and a variant re-parses its signature for every single value -- so parsed
// trees are memoised.
//
// Two things make sharing a tree safe:
//
//  - it is deep-frozen, because DBusBuffer.readVariant hands the tree to
//    application code as `variant[0]`, where a caller could otherwise mutate
//    an entry that the rest of the process is relying on;
//  - the cache is bounded, because signatures arrive from the peer, and an
//    unbounded map keyed on remote input is a memory-growth vector.
const MAX_CACHE_ENTRIES = 1000;
const cache = new Map();

function deepFreeze(nodes) {
  for (const node of nodes) {
    deepFreeze(node.child);
    Object.freeze(node);
  }
  return Object.freeze(nodes);
}

function parseSignatureCached(signature) {
  const hit = cache.get(signature);
  if (hit !== undefined) return hit;

  // Invalid signatures throw and are deliberately not cached.
  const tree = deepFreeze(parseSignature(signature));

  if (cache.size >= MAX_CACHE_ENTRIES) {
    // Map iterates in insertion order, so this drops the oldest entry.
    cache.delete(cache.keys().next().value);
  }
  cache.set(signature, tree);
  return tree;
}

// The cached parser is the default. The uncached parser and cache size are
// also available as properties of it, mirroring the CommonJS export where the
// function carried them, and as named exports for ESM consumers.
parseSignatureCached.uncached = parseSignature;
parseSignatureCached.cacheSize = () => cache.size;

export default parseSignatureCached;
export { parseSignature as uncached };
export const cacheSize = () => cache.size;
