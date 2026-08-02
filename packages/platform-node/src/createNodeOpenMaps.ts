import { OpenMapsClient } from '@openmaps/core';
import { FsPackStorage } from './FsPackStorage.js';

export interface NodeOpenMapsOptions {
  /** Directory containing one subdirectory per installed OpenMaps pack. */
  readonly packsDirectory: string;
}

/** Create a ready-to-use OpenMaps client backed by local pack files. */
export function createNodeOpenMaps(options: NodeOpenMapsOptions): OpenMapsClient {
  return new OpenMapsClient(new FsPackStorage(options.packsDirectory));
}
