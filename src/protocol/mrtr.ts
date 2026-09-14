/**
 * Multi Round-Trip Requests (SEP-2322).
 *
 * 2026-07-28 removed server-initiated requests. Where a pre-2026 server would
 * push sampling/createMessage, elicitation/create or roots/list at the client
 * mid-call, a 2026 server instead returns resultType "input_required" carrying
 * inputRequests; the client answers by RETRYING the original request with
 * inputResponses attached.
 *
 * The proxy sits in the middle and translates both directions, so a 2026 client
 * can drive a legacy downstream server and vice versa. Correlation across the
 * retry lives entirely in requestState — the spec deleted
 * notifications/elicitation/complete and the elicitationId field for exactly
 * this reason — so requestState must round-trip untouched.
 */

import { HandleStore } from './handles.js';

export type InputRequestKind = 'sampling' | 'elicitation' | 'roots';

export interface InputRequest {
  kind: InputRequestKind;
  id: string;
  params: Record<string, unknown>;
}

export interface InputResponse {
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface InputRequiredResult {
  resultType: 'input_required';
  inputRequests: InputRequest[];
  requestState: string;
}

export interface CompleteResult {
  resultType: 'complete';
  [key: string]: unknown;
}

const METHOD_TO_KIND: Readonly<Record<string, InputRequestKind>> = Object.freeze({
  'sampling/createMessage': 'sampling',
  'elicitation/create': 'elicitation',
  'roots/list': 'roots',
});

export function isInputRequired(result: unknown): result is InputRequiredResult {
  return (
    !!result &&
    typeof result === 'object' &&
    (result as Record<string, unknown>).resultType === 'input_required'
  );
}

/**
 * Spec: clients MUST treat results from earlier-protocol servers that omit
 * resultType as "complete".
 */
export function normalizeResultType<T extends object>(result: T): T & { resultType: 'complete' } {
  const typed = result as T & { resultType?: string };
  if (typed.resultType === 'complete') return typed as T & { resultType: 'complete' };
  return { ...result, resultType: 'complete' as const };
}

export function toInputRequest(
  method: string,
  id: string,
  params: Record<string, unknown>,
): InputRequest {
  const kind = METHOD_TO_KIND[method];
  if (!kind) {
    throw new Error(
      `${method} is not a server-initiated request; expected one of ${Object.keys(METHOD_TO_KIND).join(', ')}`,
    );
  }
  return { kind, id, params };
}

/**
 * Parks an in-flight call while its input requests are answered out of band.
 *
 * Entries are single-use: a replayed retry must not re-execute the parked call.
 */
export class MrtrCoordinator<TParked> {
  private readonly store: HandleStore<TParked>;

  constructor(store?: HandleStore<TParked>) {
    this.store = store ?? new HandleStore<TParked>();
  }

  park(parked: TParked, requests: InputRequest[]): InputRequiredResult {
    return {
      resultType: 'input_required',
      inputRequests: requests,
      requestState: this.store.mint(parked),
    };
  }

  resume(
    requestState: string,
    responses: InputResponse[],
  ): { parked: TParked; responses: Map<string, InputResponse> } | undefined {
    const parked = this.store.get(requestState);
    if (parked === undefined) return undefined;
    this.store.delete(requestState);
    return {
      parked,
      responses: new Map(responses.map((response) => [response.id, response])),
    };
  }
}
