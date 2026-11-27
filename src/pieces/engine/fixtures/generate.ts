// Generated inputs for the engine's tests: a large script for the timing, and seeded mutations of
// the fixtures for the never-throws check. Deterministic: the same seed gives the same text.

/** A random number generator from a seed (mulberry32): the same seed, the same sequence. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** One block of an invented helper module, about 40 lines, its names numbered by `n`. */
function block(n: number): string {
  return `
/**
 * Computes an invented total number ${n}.
 * @param {dw.order.LineItemCtnr} basket - the basket
 * @param {Object} [options] - what to include
 * @returns {number} the total
 */
function total${n}(basket, options) {
    var ProductMgr = require('dw/catalog/ProductMgr');
    var settings = options || { tax: true, shipping: ${n % 2 === 0 ? 'true' : 'false'} };
    var sum = 0;
    for (var i = 0; i < basket.productLineItems.length; i++) {
        var item = basket.productLineItems[i];
        var product = ProductMgr.getProduct(item.productID);
        if (!product || product.custom.excluded) {
            continue;
        } else if (settings.tax && item.tax) {
            sum += item.price.value / 100 * (100 + item.taxRate * 100) / 2;
        } else {
            sum += item.price.value;
        }
    }
    const label = \`total \${sum.toFixed(2)} for \${basket.UUID}\`;
    const parts = label.split(/\\s+/g).map((part, index) => ({ part, index }));
    let { tax = 0, shipping } = settings;
    switch (parts.length) {
        case 0:
            return 0;
        default:
            try {
                return sum + (shipping ? ${n} : 0) + tax;
            } catch (e) {
                return -1;
            }
    }
}
module.exports.total${n} = total${n};
`
}

/** An invented script of at least `lines` lines. */
export function largeScript(lines: number): string {
  let text = "'use strict';\nvar collections = require('*/cartridge/scripts/util/collections');\n"
  let n = 0
  while (text.split('\n').length < lines) text += block(n++)
  return text
}

/** `text` with one to four random edits: a cut, a deletion, a duplication, a swap or a stray character. */
export function mutate(text: string, random: () => number): string {
  const STRAYS = ['{', '}', '(', ')', '[', ']', '"', "'", '`', '/', '*', '<', '>', '$', '${', '\\', '\n', ';', ',', '=>', '<is', '</', '-->', '<!--', '/*', '//']
  let out = text
  const edits = 1 + Math.floor(random() * 4)
  for (let i = 0; i < edits; i++) {
    const at = Math.floor(random() * (out.length + 1))
    const size = Math.floor(random() * 40)
    switch (Math.floor(random() * 5)) {
      case 0: // truncate
        out = out.slice(0, at)
        break
      case 1: // delete a span
        out = out.slice(0, at) + out.slice(at + size)
        break
      case 2: // duplicate a span somewhere else
        {
          const to = Math.floor(random() * (out.length + 1))
          out = out.slice(0, to) + out.slice(at, at + size) + out.slice(to)
        }
        break
      case 3: // swap two spans
        {
          const other = Math.floor(random() * (out.length + 1))
          const [a, b] = at < other ? [at, other] : [other, at]
          out = out.slice(0, a) + out.slice(b, b + size) + out.slice(a + size, b) + out.slice(a, a + size) + out.slice(b + size)
        }
        break
      default: // insert a stray token
        out = out.slice(0, at) + STRAYS[Math.floor(random() * STRAYS.length)] + out.slice(at)
    }
  }
  return out
}
