import { describe, expect, it } from 'vitest';
import {
  MrtrCoordinator,
  isInputRequired,
  normalizeResultType,
  toInputRequest,
} from '../../src/protocol/mrtr.js';

describe('resultType normalisation', () => {
  it('treats a result from an earlier-protocol server as complete', () => {
    expect(normalizeResultType({ tools: [] }).resultType).toBe('complete');
  });

  it('leaves an explicit complete result alone', () => {
    const result = { resultType: 'complete' as const, tools: [{ name: 'a' }] };
    expect(normalizeResultType(result)).toEqual(result);
  });

  it('identifies an input_required result', () => {
    expect(
      isInputRequired({ resultType: 'input_required', inputRequests: [], requestState: 'x' }),
    ).toBe(true);
    expect(isInputRequired({ resultType: 'complete' })).toBe(false);
    expect(isInputRequired(null)).toBe(false);
  });
});

describe('legacy server-initiated request mapping', () => {
  it('maps the three deprecated methods onto MRTR input kinds', () => {
    expect(toInputRequest('sampling/createMessage', 'r1', { messages: [] }).kind).toBe('sampling');
    expect(toInputRequest('elicitation/create', 'r2', { message: 'hi' }).kind).toBe('elicitation');
    expect(toInputRequest('roots/list', 'r3', {}).kind).toBe('roots');
  });

  it('preserves the original params verbatim', () => {
    const params = { messages: [{ role: 'user', content: 'hi' }], maxTokens: 10 };
    expect(toInputRequest('sampling/createMessage', 'r1', params).params).toEqual(params);
  });

  it('rejects a method that is not a server-initiated request', () => {
    expect(() => toInputRequest('tools/call', 'r1', {})).toThrow(/not a server-initiated/i);
  });
});

describe('MRTR coordinator', () => {
  it('parks an in-flight call and returns an input_required result', () => {
    const coordinator = new MrtrCoordinator<{ method: string }>();
    const result = coordinator.park({ method: 'tools/call' }, [
      toInputRequest('elicitation/create', 'q1', { message: 'Which repo?' }),
    ]);

    expect(result.resultType).toBe('input_required');
    expect(result.inputRequests).toHaveLength(1);
    expect(result.inputRequests[0].kind).toBe('elicitation');
    expect(typeof result.requestState).toBe('string');
    expect(result.requestState.length).toBeGreaterThan(0);
  });

  it('resumes the parked call keyed by requestState', () => {
    const coordinator = new MrtrCoordinator<{ method: string }>();
    const parked = coordinator.park({ method: 'tools/call' }, [
      toInputRequest('elicitation/create', 'q1', {}),
    ]);

    const resumed = coordinator.resume(parked.requestState, [
      { id: 'q1', result: { action: 'accept', content: { repo: 'pluggedin-mcp' } } },
    ]);

    expect(resumed?.parked).toEqual({ method: 'tools/call' });
    expect(resumed?.responses.get('q1')?.result).toEqual({
      action: 'accept',
      content: { repo: 'pluggedin-mcp' },
    });
  });

  it('returns undefined for an unknown or already-consumed requestState', () => {
    const coordinator = new MrtrCoordinator<{ method: string }>();
    const parked = coordinator.park({ method: 'tools/call' }, [
      toInputRequest('roots/list', 'q1', {}),
    ]);

    expect(coordinator.resume('bogus', [])).toBeUndefined();
    expect(coordinator.resume(parked.requestState, [{ id: 'q1', result: {} }])).toBeDefined();
    // Single-use: a replayed retry must not re-execute the parked call.
    expect(coordinator.resume(parked.requestState, [{ id: 'q1', result: {} }])).toBeUndefined();
  });

  it('carries an input error back to the parked call', () => {
    const coordinator = new MrtrCoordinator<{ method: string }>();
    const parked = coordinator.park({ method: 'tools/call' }, [
      toInputRequest('sampling/createMessage', 'q1', {}),
    ]);

    const resumed = coordinator.resume(parked.requestState, [
      { id: 'q1', error: { code: -32001, message: 'User declined' } },
    ]);

    expect(resumed?.responses.get('q1')?.error?.message).toBe('User declined');
  });
});
