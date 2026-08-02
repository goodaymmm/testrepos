import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { writeJsonFileAtomic } from "../core/fs/json-file.js";
import type { LocalBetaPackageManifest } from "./local-beta.js";
import {
  calculateReleaseInventorySha256,
  normalizeReleaseInventory
} from "./release-manifest.js";
import {
  parseReleaseVerificationContext,
  type ReleaseVerificationContext
} from "./verification-context.js";

export type CycloneDxHash = {
  alg: "SHA-512";
  content: string;
};

export type CycloneDxComponent = {
  type: "library";
  "bom-ref": string;
  group?: string;
  name: string;
  version: string;
  scope: "required" | "optional";
  hashes?: CycloneDxHash[];
  licenses?: Array<{ license: { id: string } }>;
  purl: string;
  properties: Array<{ name: string; value: string }>;
};

export type ReleaseSbom = {
  bomFormat: "CycloneDX";
  specVersion: "1.6";
  version: 1;
  metadata: {
    component: {
      type: "application";
      "bom-ref": string;
      name: "kairon";
      version: string;
      purl: string;
    };
    properties: Array<{ name: string; value: string }>;
  };
  components: CycloneDxComponent[];
};

export type ReleaseSbomResult = {
  schema_version: "0.1";
  status: "created";
  sbom_path: string;
  package_version: string;
  package_lock_sha256: string;
  package_inventory_sha256: string;
  components: number;
  sha256: string;
  size_bytes: number;
  verification: ReleaseSbomVerificationResult;
};

export type ReleaseSbomCheck = {
  id:
    | "sbom_schema"
    | "component_order"
    | "component_identity"
    | "package_lock_binding"
    | "package_inventory_binding"
    | "host_data_absent";
  status: "pass" | "fail";
  details: string;
};

export type ReleaseSbomVerificationResult = {
  schema_version: "0.1";
  ok: boolean;
  verification_context: ReleaseVerificationContext;
  sbom_path: string;
  package_version: string | null;
  package_lock_sha256: string | null;
  package_inventory_sha256: string | null;
  components: number;
  sha256: string;
  size_bytes: number;
  checks: ReleaseSbomCheck[];
};

export type CreateReleaseSbomOptions = {
  output?: string;
};

export type VerifyReleaseSbomOptions = {
  projectRoot?: string;
  checksumManifest?: string;
  verificationContext?: ReleaseVerificationContext;
};

type PackageLock = {
  name?: unknown;
  version?: unknown;
  lockfileVersion?: unknown;
  packages?: Record<string, PackageLockEntry>;
};

type PackageLockEntry = {
  name?: unknown;
  version?: unknown;
  integrity?: unknown;
  license?: unknown;
  dev?: unknown;
  optional?: unknown;
  link?: unknown;
};

const sensitiveSbomFieldSuffixes = [
  "authorization",
  "hostname",
  "password",
  "secret",
  "token",
  "username"
] as const;

export async function createReleaseSbom(
  projectRoot: string,
  checksumManifestFile: string,
  options: CreateReleaseSbomOptions = {}
): Promise<ReleaseSbomResult> {
  const root = path.resolve(projectRoot);
  const lockPath = path.join(root, "package-lock.json");
  const checksumPath = resolveFromRoot(root, checksumManifestFile);
  const [lockBytes, checksumManifest] = await Promise.all([
    readFile(lockPath),
    readChecksumManifest(checksumPath)
  ]);
  const lock = parsePackageLock(lockBytes);
  const packageVersion = requireString(lock.version, "package-lock.json version");
  if (packageVersion !== checksumManifest.package_version) {
    throw new Error(
      `SBOM version mismatch: package-lock.json=${packageVersion}, package=${checksumManifest.package_version}.`
    );
  }

  const inventorySha256 = calculateReleaseInventorySha256(
    normalizeReleaseInventory(checksumManifest.files)
  );
  const lockSha256 = sha256(lockBytes);
  const sbom: ReleaseSbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": packageUrl("kairon", packageVersion),
        name: "kairon",
        version: packageVersion,
        purl: packageUrl("kairon", packageVersion)
      },
      properties: [
        property("kairon:artifact-kind", "release-sbom"),
        property("kairon:package-lock-sha256", lockSha256),
        property("kairon:package-inventory-sha256", inventorySha256)
      ]
    },
    components: normalizeLockComponents(lock)
  };
  const outputPath = options.output === undefined
    ? path.join(path.dirname(checksumPath), "sbom.cdx.json")
    : resolveFromRoot(root, options.output);
  await writeJsonFileAtomic(outputPath, sbom);
  const verification = await verifyReleaseSbom(outputPath, {
    projectRoot: root,
    checksumManifest: checksumPath,
    verificationContext: "source"
  });
  if (!verification.ok) {
    throw new Error(
      `SBOM verification failed: ${verification.checks
        .filter((entry) => entry.status === "fail")
        .map((entry) => entry.id)
        .join(", ")}`
    );
  }
  return {
    schema_version: "0.1",
    status: "created",
    sbom_path: outputPath,
    package_version: packageVersion,
    package_lock_sha256: lockSha256,
    package_inventory_sha256: inventorySha256,
    components: sbom.components.length,
    sha256: verification.sha256,
    size_bytes: verification.size_bytes,
    verification
  };
}

export async function verifyReleaseSbom(
  sbomFile: string,
  options: VerifyReleaseSbomOptions = {}
): Promise<ReleaseSbomVerificationResult> {
  const verificationContext = parseReleaseVerificationContext(
    options.verificationContext
  );
  const sbomPath = path.resolve(sbomFile);
  const bytes = await readFile(sbomPath);
  const info = await stat(sbomPath);
  const raw = parseUnknownJson(bytes, "SBOM");
  const schemaValid = isReleaseSbom(raw);
  const sbom = schemaValid ? raw : null;
  const components = sbom?.components ?? [];
  const refs = components.map((entry) => entry["bom-ref"]);
  const ordered = refs.every((entry, index) => index === 0 || refs[index - 1]! < entry);
  const unique = new Set(refs).size === refs.length;
  const identitiesValid = components.every((component) =>
    component["bom-ref"] === component.purl &&
    component.purl === packageUrl(componentName(component), component.version)
  );
  const lockHash = sbom === null
    ? null
    : readMetadataProperty(sbom, "kairon:package-lock-sha256");
  const inventoryHash = sbom === null
    ? null
    : readMetadataProperty(sbom, "kairon:package-inventory-sha256");
  let lockBound = lockHash !== null;
  if (verificationContext === "source" && lockHash !== null && sbom !== null) {
    try {
      const sourceRoot = path.resolve(options.projectRoot ?? process.cwd());
      const lockBytes = await readFile(path.join(sourceRoot, "package-lock.json"));
      const lock = parsePackageLock(lockBytes);
      lockBound =
        sha256(lockBytes) === lockHash &&
        JSON.stringify(normalizeLockComponents(lock)) === JSON.stringify(sbom.components);
    } catch {
      lockBound = false;
    }
  }
  let inventoryBound = inventoryHash !== null;
  if (options.checksumManifest !== undefined && inventoryHash !== null) {
    try {
      const checksum = await readChecksumManifest(path.resolve(options.checksumManifest));
      inventoryBound = calculateReleaseInventorySha256(
        normalizeReleaseInventory(checksum.files)
      ) === inventoryHash;
    } catch {
      inventoryBound = false;
    }
  }
  const hostDataAbsent = !containsHostSpecificData(raw);
  const checks: ReleaseSbomCheck[] = [
    check("sbom_schema", schemaValid, schemaValid
      ? "CycloneDX 1.6 SBOM schema is valid."
      : "CycloneDX 1.6 SBOM schema is invalid."),
    check("component_order", ordered && unique, ordered && unique
      ? "Components are unique and sorted by bom-ref."
      : "Components must be unique and sorted by bom-ref."),
    check("component_identity", identitiesValid, identitiesValid
      ? "Component package URLs match normalized names and versions."
      : "One or more component package URLs do not match their identity."),
    check("package_lock_binding", lockBound, lockBound
      ? "SBOM components and package-lock SHA-256 match."
      : "SBOM does not match the selected package-lock.json."),
    check("package_inventory_binding", inventoryBound, inventoryBound
      ? "SBOM is bound to the selected package inventory."
      : "SBOM package inventory binding does not match."),
    check("host_data_absent", hostDataAbsent, hostDataAbsent
      ? "SBOM contains no absolute path, account, host, or credential field."
      : "SBOM contains host-specific or credential-like data.")
  ];
  return {
    schema_version: "0.1",
    ok: checks.every((entry) => entry.status === "pass"),
    verification_context: verificationContext,
    sbom_path: sbomPath,
    package_version: sbom?.metadata.component.version ?? null,
    package_lock_sha256: lockHash,
    package_inventory_sha256: inventoryHash,
    components: components.length,
    sha256: sha256(bytes),
    size_bytes: info.size,
    checks
  };
}

export function formatReleaseSbom(result: ReleaseSbomResult): string {
  return [
    "Kairon release SBOM created.",
    `status=${result.status}`,
    `sbom=${result.sbom_path}`,
    `version=${result.package_version}`,
    `components=${result.components}`,
    `package_lock_sha256=${result.package_lock_sha256}`,
    `package_inventory_sha256=${result.package_inventory_sha256}`,
    `sha256=${result.sha256}`,
    `size_bytes=${result.size_bytes}`,
    `verification.ok=${result.verification.ok}`
  ].join("\n");
}

export function normalizeLockComponents(lock: PackageLock): CycloneDxComponent[] {
  const entries = lock.packages ?? {};
  const grouped = new Map<string, {
    name: string;
    version: string;
    direct: boolean;
    runtime: boolean;
    required: boolean;
    integrities: Set<string>;
    licenses: Set<string>;
  }>();
  for (const [key, entry] of Object.entries(entries)
    .filter(([key, entry]) =>
      key.length > 0 &&
      key.includes("node_modules/") &&
      entry.link !== true &&
      typeof entry.version === "string" &&
      entry.version.length > 0
    )) {
    const name = lockEntryName(key, entry);
    const version = entry.version as string;
    const purl = packageUrl(name, version);
    const current = grouped.get(purl) ?? {
      name,
      version,
      direct: false,
      runtime: false,
      required: false,
      integrities: new Set<string>(),
      licenses: new Set<string>()
    };
    current.direct ||= key === `node_modules/${name}`;
    current.runtime ||= entry.dev !== true;
    current.required ||= entry.optional !== true;
    if (typeof entry.integrity === "string" && entry.integrity.length > 0) {
      current.integrities.add(entry.integrity);
    }
    if (typeof entry.license === "string" && entry.license.length > 0) {
      current.licenses.add(entry.license);
    }
    grouped.set(purl, current);
  }

  return [...grouped.entries()]
    .map(([purl, entry]) => {
      const integrity = [...entry.integrities].sort()[0] ?? null;
      const licenses = [...entry.licenses].sort();
      return {
        type: "library",
        "bom-ref": purl,
        ...(entry.name.startsWith("@") && entry.name.includes("/")
          ? { group: entry.name.slice(0, entry.name.indexOf("/")) }
          : {}),
        name: entry.name.startsWith("@") && entry.name.includes("/")
          ? entry.name.slice(entry.name.indexOf("/") + 1)
          : entry.name,
        version: entry.version,
        scope: entry.required ? "required" : "optional",
        ...(integrity?.startsWith("sha512-") === true
          ? { hashes: [{ alg: "SHA-512" as const, content: integrity.slice("sha512-".length) }] }
          : {}),
        ...(licenses.length === 0
          ? {}
          : { licenses: licenses.map((license) => ({ license: { id: license } })) }),
        purl,
        properties: [
          property("kairon:dependency-depth", entry.direct ? "direct" : "transitive"),
          property("kairon:dependency-environment", entry.runtime ? "runtime" : "development"),
          property(
            "kairon:integrity",
            entry.integrities.size === 0 ? "unavailable" : [...entry.integrities].sort().join(",")
          ),
          property(
            "kairon:license",
            licenses.length === 0 ? "unavailable" : licenses.join(",")
          )
        ]
      } satisfies CycloneDxComponent;
    })
    .sort((left, right) =>
      left["bom-ref"] < right["bom-ref"] ? -1 : left["bom-ref"] > right["bom-ref"] ? 1 : 0
    );
}

export function isReleaseSbom(value: unknown): value is ReleaseSbom {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<ReleaseSbom>;
  return candidate.bomFormat === "CycloneDX" &&
    candidate.specVersion === "1.6" &&
    candidate.version === 1 &&
    typeof candidate.metadata === "object" &&
    candidate.metadata !== null &&
    candidate.metadata.component?.type === "application" &&
    candidate.metadata.component.name === "kairon" &&
    typeof candidate.metadata.component.version === "string" &&
    Array.isArray(candidate.metadata.properties) &&
    Array.isArray(candidate.components) &&
    candidate.components.every(isCycloneDxComponent);
}

function isCycloneDxComponent(value: unknown): value is CycloneDxComponent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const component = value as Partial<CycloneDxComponent>;
  return component.type === "library" &&
    typeof component["bom-ref"] === "string" &&
    typeof component.name === "string" &&
    typeof component.version === "string" &&
    (component.scope === "required" || component.scope === "optional") &&
    typeof component.purl === "string" &&
    Array.isArray(component.properties);
}

function parsePackageLock(content: Uint8Array): PackageLock {
  const value = parseUnknownJson(content, "package-lock.json");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("package-lock.json must contain an object.");
  }
  const lock = value as PackageLock;
  if (
    lock.lockfileVersion !== 3 ||
    typeof lock.packages !== "object" ||
    lock.packages === null ||
    Array.isArray(lock.packages)
  ) {
    throw new Error("package-lock.json must use lockfileVersion 3 with packages.");
  }
  return lock;
}

async function readChecksumManifest(file: string): Promise<LocalBetaPackageManifest> {
  const value = parseUnknownJson(await readFile(file), "checksum manifest");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Checksum manifest schema is invalid.");
  }
  const candidate = value as Partial<LocalBetaPackageManifest>;
  if (
    candidate.schema_version !== "0.1" ||
    candidate.artifact_kind !== "local_beta_package" ||
    candidate.package_name !== "kairon" ||
    typeof candidate.package_version !== "string" ||
    !Array.isArray(candidate.files)
  ) {
    throw new Error("Checksum manifest schema is invalid.");
  }
  return candidate as LocalBetaPackageManifest;
}

function lockEntryName(key: string, entry: PackageLockEntry): string {
  if (typeof entry.name === "string" && entry.name.length > 0) {
    return entry.name;
  }
  const marker = "node_modules/";
  const index = key.lastIndexOf(marker);
  const suffix = key.slice(index + marker.length);
  if (suffix.length === 0) {
    throw new Error(`Unable to determine package name for lock entry ${key}.`);
  }
  return suffix;
}

function packageUrl(name: string, version: string): string {
  const encodedName = name.startsWith("@") && name.includes("/")
    ? `${encodeURIComponent(name.slice(0, name.indexOf("/")))}/${encodeURIComponent(
      name.slice(name.indexOf("/") + 1)
    )}`
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function componentName(component: CycloneDxComponent): string {
  return component.group === undefined
    ? component.name
    : `${component.group}/${component.name}`;
}

function property(name: string, value: string): { name: string; value: string } {
  return { name, value };
}

function readMetadataProperty(sbom: ReleaseSbom, name: string): string | null {
  const value = sbom.metadata.properties.find((entry) => entry.name === name)?.value;
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : null;
}

function containsHostSpecificData(value: unknown): boolean {
  if (typeof value === "string") {
    return containsAbsoluteHostPath(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsHostSpecificData);
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.name === "string" &&
    isSensitiveFieldName(record.name) &&
    hasMeaningfulValue(record.value)
  ) {
    return true;
  }

  return Object.entries(record).some(([key, entry]) =>
    (isSensitiveFieldName(key) && hasMeaningfulValue(entry)) ||
    containsHostSpecificData(entry)
  );
}

function containsAbsoluteHostPath(value: string): boolean {
  return /(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/)/u.test(value);
}

function isSensitiveFieldName(value: string): boolean {
  const segments = value
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((entry) => entry.length > 0);
  const finalSegment = segments.at(-1);
  return finalSegment !== undefined &&
    sensitiveSbomFieldSuffixes.some((suffix) => finalSegment.endsWith(suffix));
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return true;
}

function parseUnknownJson(content: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(Buffer.from(content).toString("utf8")) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function check(
  id: ReleaseSbomCheck["id"],
  passed: boolean,
  details: string
): ReleaseSbomCheck {
  return { id, status: passed ? "pass" : "fail", details };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing ${field}.`);
  }
  return value;
}

function resolveFromRoot(root: string, value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
