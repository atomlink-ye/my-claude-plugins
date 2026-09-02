/** Provider-neutral execution placement. Cooperation records only reference a
 * surface; Paseo Project/Workspace/Agent handles are adapter binding details. */
import path from 'node:path';

export type ExecutionSurfaceKind = 'main' | 'working' | 'lane' | 'candidate';
export type OperationalState = 'planned' | 'active' | 'integrating' | 'accepted' | 'parked' | 'abandoned';
export type VisibilityState = 'visible' | 'archived';
export interface RepositoryLocator { checkout: string; }
export interface RepositoryRef { id: string; root: string; remote?: string; }
export interface CheckoutRef { id: string; repositoryId: string; path: string; branch?: string; revision?: string; }
export interface ExecutionSurfaceRef { id: string; }
export interface RuntimeBindingRef { id: string; }
/** Provider-native handles are retained only in the adapter record selected by
 * `adapterId`; cooperation and placement callers never pass them around. */
export interface AdapterSurfaceBinding { projectId: string; workspaceId: string; }
export interface SurfaceSpec { checkout: string; kind: ExecutionSurfaceKind; slug?: string; revision?: string; }
export interface ExecutionSurface { id: string; repositoryId: string; checkout: CheckoutRef; kind: ExecutionSurfaceKind; operationalState: OperationalState; visibilityState: VisibilityState; adapterBindings: Record<string, AdapterSurfaceBinding>; createdAt: string; updatedAt: string; }
export interface ExecutionSurfaceBinding { surface: ExecutionSurface; adapterId: string; }
export interface RuntimeBinding { id: string; executionSurfaceId: string; runtimeSessionId: string; adapterId: string; nativeId?: string; generation: number; state: string; visibilityState: VisibilityState; createdAt: string; }
export interface RuntimeBindingReceipt { binding: RuntimeBinding; }
/** A runtime binding and any writer claim are always owned by one persisted
 * RuntimeSession. Labels, roles, and caller-provided aliases cannot claim a
 * mutable checkout. */
export interface RuntimeLaunchSpec { executionSurfaceId: string; runtimeSessionId: string; writer?: boolean; }
export interface RuntimeObservation { state: string; }
export interface SurfaceClaim { id: string; executionSurfaceId: string; runtimeSessionId: string; holder: string; mode: 'writer'; active: boolean; createdAt: string; releasedAt?: string; }
export interface SurfaceArchiveAuthorization { controlWorkspaceId: string; actorId: string; }
export interface ExecutionPlacementPort { resolveRepository(input: RepositoryLocator): Promise<RepositoryRef>; materializeSurface(input: SurfaceSpec): Promise<ExecutionSurfaceBinding>; launchRuntime(input: RuntimeLaunchSpec): Promise<RuntimeBindingReceipt>; observeRuntime(binding: RuntimeBindingRef): Promise<RuntimeObservation>; retireRuntime(binding: RuntimeBindingRef): Promise<void>; archiveSurface(surface: ExecutionSurfaceRef, authorization: SurfaceArchiveAuthorization): Promise<void>; }

/** No Goal, Round, role, title, or emergency label participates in identity. */
export const checkoutIdentity = (checkout: string) => path.resolve(checkout);
export function surfaceName(kind: ExecutionSurfaceKind, input: Pick<SurfaceSpec, 'slug' | 'revision'> = {}): string {
  if (kind === 'main') return 'main';
  if (kind === 'working') return 'ARCP · working';
  const compact = (value: string | undefined, fallback: string) => ((value ?? fallback).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || fallback).slice(0, 32);
  return kind === 'lane' ? `ARCP · lane · ${compact(input.slug, 'writer')}` : `ARCP · candidate · ${compact(input.revision, 'unknown').slice(0, 7)}`;
}
