import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pkgJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
const pkgLock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf-8'));

const components = [];

if (pkgLock.packages) {
  for (const [path, info] of Object.entries(pkgLock.packages)) {
    if (!path || !info.version) continue;
    const name = path.replace(/^node_modules\//, '');
    components.push({
      type: 'library',
      name,
      version: info.version,
      purl: `pkg:npm/${name}@${info.version}`,
      license: info.license ?? 'UNKNOWN',
    });
  }
}

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${crypto.randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: 'application',
      name: pkgJson.name,
      version: pkgJson.version,
    },
  },
  components,
};

const evidenceDir = resolve(root, 'evidence');
mkdirSync(evidenceDir, {recursive: true});
const sbomPath = resolve(evidenceDir, 'sbom.json');
writeFileSync(sbomPath, JSON.stringify(sbom, null, 2));

console.log(`Generated CycloneDX SBOM with ${components.length} components at ${sbomPath}`);
