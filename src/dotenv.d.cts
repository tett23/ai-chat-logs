export type Pair = [name: string, value: string];
export type Env = Record<string, string | undefined>;

export declare const parseDotenv: (text: string) => Pair[];
export declare const pickUnset: (env: Env, pairs: readonly Pair[]) => Pair[];
export declare const loadDotenv: (path: string, env: Env) => void;
