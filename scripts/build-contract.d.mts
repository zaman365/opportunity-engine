/**
 * Types for the contract generator, which is plain `.mjs` so it can run with bare `node` in
 * CI without a TypeScript loader.
 */
export declare function buildContract(): Record<string, unknown>;
export declare function serialise(document: unknown): string;
export declare const OUTPUT_PATH: string;
