// Common adapter result. Every site adapter returns a shape compatible with
// this — Dicey adds isActive/isGeoRestricted, the competitor adapters add rtp,
// etc. See per-adapter modules for the specialized variants.
export interface SiteResult {
  found: boolean;
  name?: string;
  slug?: string;
  rtp?: number | null;
  provider?: string | null;
  error?: string;
  matchScore?: number;
  _debug?: Record<string, unknown>;
}

export interface DiceyResult extends SiteResult {
  isActive?: boolean;
  isGeoRestricted?: boolean;
}
