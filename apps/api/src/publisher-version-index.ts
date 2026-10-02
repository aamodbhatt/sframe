import type {D1Database, D1PreparedStatement} from '@cloudflare/workers-types';
import canonicalize from 'canonicalize';
import {encodeBase64Url} from '../../../packages/protocol/src/index.js';
import {parseUniqueJson} from '../../../packages/protocol/src/strict-json.js';
import type {StoredPackageRecord} from './publish-api.js';
import type {PackageManifestMetadata} from './package-verifier.js';
import {fail} from './publisher-storage-errors.js';

type PackageRecord = Omit<StoredPackageRecord, 'bytes'>;
type Version = {package_digest: string; app_id: string; semver: string; manifest_json: string;
  artifact_digest: string; total_bytes: number; r2_key: string; status: string; key_id: string; app_namespace: string};
const objectKey = (digest: string): string => `packages/${digest}.zip`;

async function validateManifest(record: PackageRecord, metadata: PackageManifestMetadata): Promise<void> {
  if (typeof metadata.manifestJson !== 'string' || new TextEncoder().encode(metadata.manifestJson).byteLength > 8_192) fail(409, 'PACKAGE_VERSION_INVALID');
  const manifest = parseUniqueJson(metadata.manifestJson) as {id?: unknown; version?: unknown; publisher?: {keyId?: unknown}};
  if (canonicalize(manifest) !== metadata.manifestJson || manifest.id !== metadata.appNamespace
    || manifest.version !== metadata.semver || manifest.publisher?.keyId !== record.publisherKeyId) fail(409, 'PACKAGE_VERSION_INVALID');
  const bytes = new TextEncoder().encode(`smallframe-package-v1\0${metadata.manifestJson}`);
  const digest = encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  if (digest !== record.packageDigest) fail(409, 'PACKAGE_VERSION_INVALID');
}

export class PublisherVersionIndex {
  constructor(private readonly db: D1Database) {}
  private version(digest: string): Promise<Version | null> {
    return this.db.prepare(`SELECT v.*,p.key_id,a.app_namespace FROM app_versions v JOIN apps a ON a.id=v.app_id
      JOIN publishers p ON p.id=a.publisher_id WHERE v.package_digest=?`).bind(digest).first<Version>();
  }
  async hasVersion(digest: string): Promise<boolean> { return (await this.version(digest)) !== null; }
  async assertIndexed(record: PackageRecord): Promise<void> {
    const version = await this.version(record.packageDigest);
    if (!version) return; // Preceding local packages remain readable during migration.
    await this.assertReserved(record);
    if (version.status !== 'ACTIVE') fail(409, 'PACKAGE_VERSION_INVALID');
  }
  async assertReserved(record: PackageRecord): Promise<void> {
    const version = await this.version(record.packageDigest);
    if (!version || version.key_id !== record.publisherKeyId || version.artifact_digest !== record.artifactDigest
      || version.total_bytes !== record.byteLength || version.r2_key !== objectKey(record.packageDigest)
      || !['PENDING', 'ACTIVE'].includes(version.status)) fail(409, 'PACKAGE_VERSION_INVALID');
    await validateManifest(record, {manifestJson: version.manifest_json, appNamespace: version.app_namespace, semver: version.semver});
  }
  async reserve(record: PackageRecord, manifest: PackageManifestMetadata, following: D1PreparedStatement[], status = 'PENDING'): Promise<void> {
    await validateManifest(record, manifest);
    const publisher = await this.db.prepare('SELECT id FROM publishers WHERE key_id=?').bind(record.publisherKeyId).first<{id: string}>();
    if (!publisher) fail(409, 'PACKAGE_PUBLISHER_INVALID');
    if (await this.version(record.packageDigest)) await this.assertReserved(record);
    const appId = `${publisher.id}/${manifest.appNamespace}`;
    try {
      await this.db.batch([
        this.db.prepare('INSERT INTO apps(id,publisher_id,app_namespace,created_at) VALUES(?,?,?,?) ON CONFLICT(publisher_id,app_namespace) DO NOTHING')
          .bind(appId, publisher.id, manifest.appNamespace, record.createdAt),
        this.db.prepare(`INSERT INTO app_versions(package_digest,app_id,semver,manifest_json,artifact_digest,total_bytes,r2_key,created_at,status)
          SELECT ?,id,?,?,?,?,?,?,? FROM apps WHERE publisher_id=? AND app_namespace=? ON CONFLICT(package_digest) DO NOTHING`)
          .bind(record.packageDigest, manifest.semver, manifest.manifestJson, record.artifactDigest, record.byteLength,
            objectKey(record.packageDigest), record.createdAt, status, publisher.id, manifest.appNamespace),
        ...following,
      ]);
    } catch (error) {
      const collision = await this.db.prepare(`SELECT v.package_digest FROM app_versions v JOIN apps a ON a.id=v.app_id
        WHERE a.publisher_id=? AND a.app_namespace=? AND v.semver=?`).bind(publisher.id, manifest.appNamespace, manifest.semver).first<{package_digest: string}>();
      if (collision && collision.package_digest !== record.packageDigest) fail(409, 'PACKAGE_VERSION_CONFLICT');
      throw error;
    }
    await this.assertReserved(record);
  }
  activateStatement(record: PackageRecord): D1PreparedStatement {
    return this.db.prepare("UPDATE app_versions SET status='ACTIVE' WHERE package_digest=? AND artifact_digest=? AND total_bytes=?")
      .bind(record.packageDigest, record.artifactDigest, record.byteLength);
  }
}
