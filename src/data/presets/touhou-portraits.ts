import catalog from './touhou-portraits.json';
export interface PortraitCandidate {
  id: string;
  kind: 'twilight' | 'zun';
  work: string;
  artist: string;
  fileTitle: string;
  sourcePage: string;
  url: string;
  bytes: number;
}
export interface PortraitEntry {
  characterId: string;
  name: string;
  continuity: 'windows' | 'pc98';
  candidates: PortraitCandidate[];
  missingReason?: string;
}
/** Metadata only. Importing this catalog never fetches images. */
export const touhouPortraits = catalog as PortraitEntry[];
export const PORTRAIT_PACK = 'touhou-official-portraits-v1';
