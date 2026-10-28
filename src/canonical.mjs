// Shared serialization and body digest; exact existing Core semantics.
import {createHash} from 'node:crypto';
const fail=category=>{throw new TypeError(category);};
const object=(v,category)=>{if(!v||Object.getPrototypeOf(v)!==Object.prototype)fail(category);};
// Sorted object keys, ordered arrays; JSON-only, no coercion or ignored values.
export function canonicalJSON(value) {
  const seen = new Set();
  function encode(v) {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number' && Number.isFinite(v) && !Object.is(v, -0)) return JSON.stringify(v);
    if (typeof v !== 'object' || v === null || seen.has(v)) fail('serialization');
    seen.add(v);
    let result;
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype) fail('serialization');
      if (Reflect.ownKeys(v).length !== v.length + 1) fail('serialization');
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d || !d.enumerable || !('value' in d)) fail('serialization');
      }
      result = '[' + Array.from(v, encode).join(',') + ']';
    } else {
      object(v, 'serialization');
      if (Reflect.ownKeys(v).some(k => typeof k !== 'string'
          || !Object.getOwnPropertyDescriptor(v, k).enumerable)) fail('serialization');
      result = '{' + Object.keys(v).sort().map(k => {
        const d = Object.getOwnPropertyDescriptor(v, k);
        if (!d.enumerable || !('value' in d)) fail('serialization');
        return JSON.stringify(k) + ':' + encode(d.value);
      }).join(',') + '}';
    }
    seen.delete(v);
    return result;
  }
  return encode(value);
}
export function bodyDigest(body) {
  if (typeof body !== 'string') fail('body');
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}
