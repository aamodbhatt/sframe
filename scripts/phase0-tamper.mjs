import {createHash} from 'node:crypto';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const root = process.cwd();
const candidate = process.env.SMALLFRAME_CANDIDATE ?? 'T';
if (candidate !== 'T' && candidate !== 'U') throw new Error(`TAMPER_CANDIDATE_UNSUPPORTED:${candidate}`);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const rendererDir = join(root, 'dist', 'controller', 'runtime', 'renderer');
const rendererName = readdirSync(rendererDir).find((name) => /^[0-9a-f]{64}\.html$/u.test(name));
if (!rendererName) throw new Error('TAMPER_RENDERER_MISSING');
const rendererBytes = readFileSync(join(rendererDir, rendererName));
const rendererDigest = rendererName.slice(0, -5);
if (digest(rendererBytes) !== rendererDigest) throw new Error('TAMPER_RENDERER_IDENTITY_BASELINE_FAILED');
const mutatedRenderer = Buffer.from(rendererBytes);
mutatedRenderer[0] ^= 1;
if (digest(mutatedRenderer) === rendererDigest) throw new Error('TAMPER_RENDERER_MUTATION_UNDETECTED');

const builtRendererSource = readFileSync(join(root, 'dist', 'renderer', 'renderer.js'), 'utf8');
const embeddedFactoryMatch = builtRendererSource.match(/const CANDIDATE_FACTORY_SOURCE = ("(?:\\.|[^"])*");/u);
if (!embeddedFactoryMatch) throw new Error('TAMPER_FACTORY_SOURCE_MISSING');
const factoryBytes = Buffer.from(JSON.parse(embeddedFactoryMatch[1]));
const factoryDigest = digest(factoryBytes);
const mutatedFactory = Buffer.from(factoryBytes);
mutatedFactory[0] ^= 1;
if (digest(mutatedFactory) === factoryDigest) throw new Error('TAMPER_FACTORY_MUTATION_UNDETECTED');

const rendererSource = readFileSync(join(root, 'apps', 'renderer', 'src', 'renderer.ts'), 'utf8');
const compositePattern = candidate === 'U'
  ? /const candidateUBlobWorkerSource = \(\): string => `([\s\S]*?)`;\n\nconst revokeClassicWorkerUrl/u
  : /const classicBlobWorkerSource = \(\): string => `([\s\S]*?)`;\n\nconst revokeClassicWorkerUrl/u;
const compositeMatch = rendererSource.match(compositePattern);
if (!compositeMatch) throw new Error('TAMPER_COMPOSITE_SOURCE_MISSING');
const compositeBytes = Buffer.from(compositeMatch[1].replace('${CANDIDATE_FACTORY_SOURCE}', factoryBytes.toString('utf8')));
const compositeDigest = digest(compositeBytes);
const mutatedComposite = Buffer.from(compositeBytes);
mutatedComposite[0] ^= 1;
if (digest(mutatedComposite) === compositeDigest) throw new Error('TAMPER_COMPOSITE_MUTATION_UNDETECTED');

console.log(JSON.stringify({
  candidate,
  rendererDigest,
  rendererBytes: rendererBytes.byteLength,
  mutatedRendererDigest: digest(mutatedRenderer),
  factoryDigest,
  factoryBytes: factoryBytes.byteLength,
  mutatedFactoryDigest: digest(mutatedFactory),
  compositeDigest,
  compositeBytes: compositeBytes.byteLength,
  mutatedCompositeDigest: digest(mutatedComposite)
}, null, 2));
