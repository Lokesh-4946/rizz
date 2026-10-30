// D-050. Host token counts win. When a ledger row has none, count the event text with
// js-tiktoken o200k_base. The package is installed by bench, eval, and simulation only, so this
// import stays dynamic and the core cold-start path never loads it. A missing or throwing
// encoder falls back to the same 4-char approximation the providers use.

export type EstimatedTokenSource = 'tiktoken-o200k' | 'approx';

export interface TextTokenCount {
  readonly count: number;
  readonly source: EstimatedTokenSource;
}

export type TokenEncoder = (text: string) => number;

// A widened string keeps this import dynamic. A literal specifier would make the typechecker
// resolve js-tiktoken as a dependency of the brain package.
const TIKTOKEN_SPECIFIER: string = 'js-tiktoken';

let encoderAttempt: Promise<TokenEncoder | undefined> | undefined;

export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function encoderFromModule(loaded: unknown): TokenEncoder | undefined {
  if (!isRecord(loaded)) return undefined;
  const getEncoding = loaded.getEncoding;
  if (typeof getEncoding !== 'function') return undefined;
  const encoding: unknown = getEncoding('o200k_base');
  if (!isRecord(encoding)) return undefined;
  const encode = encoding.encode;
  if (typeof encode !== 'function') return undefined;
  return (text: string) => {
    const tokens: unknown = encode.call(encoding, text);
    if (!Array.isArray(tokens)) {
      throw new Error('o200k encoder returned a non-array');
    }
    return tokens.length;
  };
}

async function importO200kEncoder(): Promise<TokenEncoder | undefined> {
  try {
    const loaded: unknown = await import(TIKTOKEN_SPECIFIER);
    return encoderFromModule(loaded);
  } catch {
    return undefined;
  }
}

function loadCachedEncoder(): Promise<TokenEncoder | undefined> {
  encoderAttempt ??= importO200kEncoder();
  return encoderAttempt;
}

export async function countTextTokens(
  text: string,
  load: () => Promise<TokenEncoder | undefined> = loadCachedEncoder,
): Promise<TextTokenCount> {
  let encoder: TokenEncoder | undefined;
  try {
    encoder = await load();
  } catch {
    encoder = undefined;
  }
  if (encoder === undefined) {
    return { count: approximateTokens(text), source: 'approx' };
  }
  try {
    return { count: encoder(text), source: 'tiktoken-o200k' };
  } catch {
    return { count: approximateTokens(text), source: 'approx' };
  }
}
