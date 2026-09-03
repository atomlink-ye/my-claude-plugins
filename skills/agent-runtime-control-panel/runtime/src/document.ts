/**
 * Local Markdown DocumentArtifacts: the durable home for coordination authority
 * that must not travel as chat text.
 *
 * A document has a stable identity; its content lives in append-only revisions;
 * and an ArtifactRef names one exact revision by id, number and content hash.
 * The ref is the unit that travels in messages, so a reader who does not trust
 * the sender can still resolve it and prove the bytes are the bytes it names.
 */
import { documentAddress } from './content.js';

export type DocumentKind = 'contract' | 'report' | 'note';

/** Stable identity for a document across every revision it will ever have. */
export interface DocumentArtifact {
  id: string;
  workspaceId: string;
  kind: DocumentKind;
  title: string;
  authorMemberId: string;
  latestRevision: number;
  createdAt: string;
  updatedAt: string;
}

/** One immutable revision. Never updated, never deleted, never renumbered. */
export interface DocumentRevision {
  id: string;
  documentId: string;
  workspaceId: string;
  revision: number;
  authorMemberId: string;
  body: string;
  bytes: number;
  contentHash: string;
  createdAt: string;
}

export const DOCUMENT_KINDS: readonly DocumentKind[] = ['contract', 'report', 'note'];
/** A document holds coordination text, not a payload. The cap is what keeps it
 * from becoming unbounded state smuggled between runtimes. */
export const DOCUMENT_BODY_LIMIT = 1024 * 1024;
/** A document-bound notification is a delta plus a pointer. The limit is the
 * mechanism: it makes carrying authority in a message structurally impossible
 * rather than merely discouraged. */
export const SUMMARY_LIMIT = 400;

const REF_PATTERN = /^arcp:\/\/doc\/([A-Za-z0-9_-]+)@(\d+)#sha256:([0-9a-f]{64})$/;

export interface ArtifactRefParts { documentId: string; revision: number; contentHash: string }

export function formatArtifactRef(parts: ArtifactRefParts): string {
  return `arcp://doc/${parts.documentId}@${parts.revision}#sha256:${parts.contentHash}`;
}

/** Parse without a store, so a reader can inspect a ref before deciding to
 * resolve it. Malformed refs are refused rather than best-effort repaired. */
export function parseArtifactRef(ref: string): ArtifactRefParts | undefined {
  const match = REF_PATTERN.exec(ref.trim());
  if (!match) return undefined;
  const revision = Number(match[2]);
  if (!Number.isSafeInteger(revision) || revision < 1) return undefined;
  return { documentId: match[1], revision, contentHash: match[3] };
}

export type ArtifactResolution =
  | { status: 'verified'; revision: DocumentRevision }
  | { status: 'malformed' | 'unknown_document' | 'unknown_revision' | 'hash_mismatch'; reason: string };

/**
 * Resolve a ref against known revisions, verifying the hash.
 *
 * A ref that cannot be verified never returns content. `hash_mismatch` is kept
 * distinct from `unknown_*` on purpose: it means someone named a specific
 * revision and the claim is false, which is worse evidence than naming nothing.
 */
export function resolveArtifactRef(ref: string, revisions: readonly DocumentRevision[]): ArtifactResolution {
  const parts = parseArtifactRef(ref);
  if (!parts) return { status: 'malformed', reason: 'artifact ref is not a well-formed arcp://doc/<id>@<revision>#sha256:<hash>' };
  const forDocument = revisions.filter((item) => item.documentId === parts.documentId);
  if (!forDocument.length) return { status: 'unknown_document', reason: `no document ${parts.documentId}` };
  const revision = forDocument.find((item) => item.revision === parts.revision);
  if (!revision) return { status: 'unknown_revision', reason: `document ${parts.documentId} has no revision ${parts.revision}` };
  // Verify against the body itself, not the stored hash alone, so a tampered
  // row cannot vouch for itself.
  if (documentAddress(revision.body) !== parts.contentHash) return { status: 'hash_mismatch', reason: `revision ${parts.revision} of ${parts.documentId} does not hash to ${parts.contentHash}` };
  return { status: 'verified', revision };
}

export const artifactRefFor = (revision: DocumentRevision): string =>
  formatArtifactRef({ documentId: revision.documentId, revision: revision.revision, contentHash: revision.contentHash });

/**
 * A plain LCS line diff, rendered as a unified-style body without hunk headers.
 * It exists so a reviser can show what a revision changed without shipping both
 * full bodies. It is for reading, not for applying.
 */
export function diffDocumentLines(from: string, to: string): string {
  const a = from.split('\n');
  const b = to.split('\n');
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push(` ${a[i]}`); i += 1; j += 1; }
    else if (lengths[i + 1][j] >= lengths[i][j + 1]) { out.push(`-${a[i]}`); i += 1; }
    else { out.push(`+${b[j]}`); j += 1; }
  }
  while (i < a.length) { out.push(`-${a[i]}`); i += 1; }
  while (j < b.length) { out.push(`+${b[j]}`); j += 1; }
  return out.join('\n');
}
