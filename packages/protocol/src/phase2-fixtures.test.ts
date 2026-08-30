import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, test} from 'vitest';

const fixtures = ['tracker', 'calculator', 'decision-board'] as const;

describe('Phase 2 adaptation fixtures', () => {
  test.each(fixtures)('%s has byte-exact module integrity and a bounded state contract', (name) => {
    const root = join(process.cwd(), 'examples', name, 'package');
    const module = readFileSync(join(root, 'app.worker.js'));
    const manifest = JSON.parse(readFileSync(join(root, 'smallframe.json'), 'utf8')) as Record<string, any>;
    expect(manifest.files['app.worker.js']).toEqual({bytes: module.byteLength, sha256: createHash('sha256').update(module).digest('base64url')});
    expect(manifest.state.jsonSchema.type).toBe('object');
    expect(manifest.state.jsonSchema.additionalProperties).toBe(false);
    expect(manifest.state.maxPlaintextBytes).toBeLessThanOrEqual(393_216);
    expect(manifest.capabilities).toEqual([]);
  });

  test('fixtures exercise three different top-level state shapes', () => {
    const shapes = fixtures.map((name) => {
      const manifest = JSON.parse(readFileSync(join(process.cwd(), 'examples', name, 'package', 'smallframe.json'), 'utf8')) as Record<string, any>;
      return Object.keys(manifest.state.publicTemplate).sort().join(',');
    });
    expect(new Set(shapes).size).toBe(fixtures.length);
  });
});
