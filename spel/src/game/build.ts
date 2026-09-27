// Build identity and comfort options. No Babylon import here: the start screen loads without the engine (REVIEW-01
// G-17); the engine and the chalet are fetched when a round starts.
declare const __MJ_BUILD__: string | undefined;

/** Code package + short hash of the shipped chalet assets (vite.config.ts), so a report names exactly what was tested
 * (G-18: a fixed text said nothing about the assets). */
export const BUILD: string = typeof __MJ_BUILD__ === 'string' ? __MJ_BUILD__ : 'G1-kandidaat-02';

export const COMFORT = { headBob: true };
