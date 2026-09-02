import { ArcpService } from '../../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';
import { FakePaseoCli } from './fake-paseo-cli.js';

type CreateControlOptions = {
  cli?: FakePaseoCli;
  store?: unknown;
  modeClientFactory?: unknown;
};

/** Create an initialized in-process ARCP service without crossing a real provider boundary. */
export async function createControl(root: string, options: CreateControlOptions = {}) {
  const cli = options.cli ?? new FakePaseoCli();
  const service = new ArcpService(root, cli as any, options.store as any, options.modeClientFactory as any);
  await service.init();
  return { service, cli, root };
}
