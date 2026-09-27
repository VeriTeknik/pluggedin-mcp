import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../src/fetch-pluggedinmcp.js', () => ({
  getMcpServers: vi.fn(),
}));

import {
  buildServerContextsMap,
  extractCustomInstructions,
  formatCustomInstructionsForDiscovery,
} from '../src/utils/custom-instructions.js';
import { getMcpServers } from '../src/fetch-pluggedinmcp.js';

const GOOD = { uuid: 'good-uuid', name: 'Good Server', customInstructions: 'This server is read-only.' };

const malformedValues: Array<[string, unknown]> = [
  ['a null first message', [null]],
  ['a null content in a later message', [{ role: 'user', content: 'ok' }, { role: 'user', content: null }]],
  ['an object content in a later message', [{ role: 'user', content: 'ok' }, { role: 'user', content: { text: 'x' } }]],
  ['a number inside an otherwise string array', ['fine', 42]],
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('malformed custom instructions are isolated per server', () => {
  for (const [label, value] of malformedValues) {
    it(`keeps other servers' contexts when one server has ${label}`, () => {
      const bad = { uuid: 'bad-uuid', name: 'Bad Server', customInstructions: value };
      const contexts = buildServerContextsMap([bad, GOOD]);

      expect(contexts.get('good-uuid')?.constraints.readonly).toBe(true);
    });
  }

  it('extractCustomInstructions does not throw on a null first element', () => {
    expect(() => extractCustomInstructions({ customInstructions: [null] })).not.toThrow();
  });

  it('discovery output still lists valid servers\' instructions', async () => {
    vi.mocked(getMcpServers).mockResolvedValue({
      'bad-uuid': { uuid: 'bad-uuid', name: 'Bad Server', customInstructions: [null] },
      'good-uuid': GOOD,
    } as any);

    const output = await formatCustomInstructionsForDiscovery();
    expect(output).toContain('Good Server');
    expect(output).toContain('This server is read-only.');
  });

  it('still processes well-formed message arrays', () => {
    const contexts = buildServerContextsMap([
      {
        uuid: 'msg-uuid',
        name: 'Msg Server',
        customInstructions: [
          { role: 'user', content: [{ type: 'text', text: 'Denied operations: drop_table' }] },
          { role: 'assistant', content: 'No deletes please' },
        ],
      },
    ]);
    const ctx = contexts.get('msg-uuid');
    expect(ctx?.constraints.deniedOperations).toEqual(['drop_table']);
    expect(ctx?.constraints.noDeletes).toBe(true);
  });
});
