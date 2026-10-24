export interface CanonPerson {
  key: string;
  name: string;
  source: string;
  species: string;
  ability: string;
  site: string;
  fact: string;
  sources?: string[];
  background?: boolean;
  traits?: string;
  notes?: string;
  usual?: string[];
}
export const person = (
  key: string,
  name: string,
  source: string,
  species: string,
  ability: string,
  site: string,
  fact: string,
  extra: Partial<CanonPerson> = {},
): CanonPerson => ({ key, name, source, species, ability, site, fact, ...extra });
export interface CanonPlace {
  name: string;
  region: string;
  description: string;
  sourceIds: string[];
  access: 'local' | 'restricted' | 'external' | 'legacy';
}
export interface CanonGroup {
  key: string;
  name: string;
  source: string;
  kind: '组织' | '从属关系' | '观察分组';
  description: string;
  members: [string, string][];
  background?: boolean;
}
export interface CanonEdge {
  tuning?: { values: [number, number, number]; attitude: string };
  from: string;
  to: string;
  label: string;
  source: string;
  fact: string;
}
