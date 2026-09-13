import {describe, expect, it} from 'vitest';
import {parseUniqueJson} from './strict-json.js';

describe('unique-key bounded-depth JSON', () => {
  it.each([
    '{"a":1,"a":2}', '{"a":1,"\\u0061":1}', '{"nested":{"x":1,"x":1}}',
    '[{"x":1,"x":2}]', '{"x":{},"x":{}}', '{"a":[0],"a":null}'
  ])('rejects duplicate keys, including escaped equivalents', (text) => {
    expect(() => parseUniqueJson(text)).toThrow('REMOTE_STATE_INVALID');
  });
  it('accepts the same key in separate objects and syntax-like string contents', () => {
    const value = {a: {x: 1}, b: [{x: 2}], text: '"key": { [ \\ " } ]'};
    expect(parseUniqueJson(JSON.stringify(value))).toEqual(value);
  });
  it('agrees with JSON.parse for varied escaped string payloads', () => {
    for (let code = 0; code < 256; code += 1) {
      const value = {[String.fromCharCode(code)]: ['"\\{}[]:', {nested: code}]};
      const text = JSON.stringify(value);
      expect(parseUniqueJson(text)).toEqual(JSON.parse(text));
    }
  });
  it('accepts depth 32 and rejects depth 33 before materialization', () => {
    expect(parseUniqueJson('['.repeat(32) + '0' + ']'.repeat(32))).toBeDefined();
    expect(() => parseUniqueJson('['.repeat(33) + '0' + ']'.repeat(33))).toThrow('REMOTE_STATE_INVALID');
  });
  it.each(['', '{', '{"x":}', '{"x":1,}', '[1,]', 'true false', '{"x":"\\uXYZW"}'])('still rejects invalid JSON syntax', (text) => {
    expect(() => parseUniqueJson(text)).toThrow('REMOTE_STATE_INVALID');
  });
});
