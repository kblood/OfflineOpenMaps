// Public API of the region-builder package. The CLI in `cli.ts` is the
// primary consumer; this index lets other packages (notably the Electron
// main process for the in-app pack builder) import the pipeline pieces
// directly without going through a subprocess.

export { readOsmXml } from './osmXmlReader.js';
export { readOsmPbf } from './osmPbfReader.js';
export { osmToPack } from './osmToPack.js';
export type { OsmToPackOpts } from './osmToPack.js';
export { writeMbtiles } from './writeMbtiles.js';
export { writeGeocodeDb } from './writeGeocode.js';
export { writeManifest } from './writeManifest.js';
export { chooseAnchors } from './chooseAnchors.js';
export { buildFakelandData } from './synthetic.js';
export type {
  RoadEdge,
  PlaceFeature,
  WaterPolygon,
  BuildingPolygon,
  SyntheticData,
} from './synthetic.js';
export type { RawOsm, RawOsmNode, RawOsmWay } from './osmTypes.js';
export { fetchDawa, applyDawa } from './dawaFetcher.js';
export { snapAddressesToBuildings } from './snapAddresses.js';
export type { SnapResult } from './snapAddresses.js';
export type { DawaAddress, DawaFetchResult, DawaFetchOpts, ParcelPolygon } from './dawaFetcher.js';
export type { ParcelGeometry } from './synthetic.js';
