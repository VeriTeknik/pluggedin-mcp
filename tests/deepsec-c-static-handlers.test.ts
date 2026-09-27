import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';

// Never fall back to real credential files on the developer's machine
vi.mock('../src/config-loader.js', () => ({
  getSettingsEnvVar: () => undefined,
}));

vi.mock('../src/notification-logger.js', () => ({
  logMcpActivity: vi.fn().mockResolvedValue(undefined),
  createExecutionTimer: () => ({ stop: () => 0 }),
}));

import { StaticToolHandlers } from '../src/handlers/static-handlers.js';
import {
  MarkNotificationDoneInputSchema,
  DeleteNotificationInputSchema,
} from '../src/schemas/index.js';

const TEST_API_KEY = 'pg_in_' + 'b'.repeat(40);
const BASE_URL = 'http://localhost:3000';
const NOTIFICATION_ID = '550e8400-e29b-41d4-a716-446655440000';

const traversalIds = [
  `../documents/${NOTIFICATION_ID}`,
  `${NOTIFICATION_ID}#`,
  `${NOTIFICATION_ID}/../../documents/x`,
  `${NOTIFICATION_ID}?x=1`,
  'not-a-uuid',
];

let handlers: StaticToolHandlers;

beforeEach(() => {
  process.env.PLUGGEDIN_API_KEY = TEST_API_KEY;
  process.env.PLUGGEDIN_API_BASE_URL = BASE_URL;
  handlers = new StaticToolHandlers({}, {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('notification ID schemas', () => {
  for (const schema of [MarkNotificationDoneInputSchema, DeleteNotificationInputSchema]) {
    it('accept a UUID', () => {
      expect(schema.parse({ notificationId: NOTIFICATION_ID }).notificationId).toBe(NOTIFICATION_ID);
    });

    for (const badId of traversalIds) {
      it(`reject ${JSON.stringify(badId)}`, () => {
        expect(() => schema.parse({ notificationId: badId })).toThrow();
      });
    }
  }
});

describe('StaticToolHandlers notification tools (path traversal)', () => {
  for (const badId of traversalIds) {
    it(`delete rejects ${JSON.stringify(badId)} without calling the API`, async () => {
      const del = vi.spyOn(axios, 'delete').mockResolvedValue({ data: {} } as any);
      await expect(
        handlers.handleStaticTool('pluggedin_delete_notification', { notificationId: badId })
      ).rejects.toThrow();
      expect(del).not.toHaveBeenCalled();
    });

    it(`mark done rejects ${JSON.stringify(badId)} without calling the API`, async () => {
      const patch = vi.spyOn(axios, 'patch').mockResolvedValue({ data: {} } as any);
      await expect(
        handlers.handleStaticTool('pluggedin_mark_notification_done', { notificationId: badId })
      ).rejects.toThrow();
      expect(patch).not.toHaveBeenCalled();
    });
  }

  it('delete targets the notification path for a UUID', async () => {
    const del = vi.spyOn(axios, 'delete').mockResolvedValue({ data: {} } as any);
    await handlers.handleStaticTool('pluggedin_delete_notification', { notificationId: NOTIFICATION_ID });
    expect(del.mock.calls[0][0]).toBe(`${BASE_URL}/api/notifications/${NOTIFICATION_ID}`);
  });

  it('mark done targets the completed path for a UUID', async () => {
    const patch = vi.spyOn(axios, 'patch').mockResolvedValue({ data: {} } as any);
    await handlers.handleStaticTool('pluggedin_mark_notification_done', { notificationId: NOTIFICATION_ID });
    expect(patch.mock.calls[0][0]).toBe(`${BASE_URL}/api/notifications/${NOTIFICATION_ID}/completed`);
  });
});

describe('every static tool API call has a bounded timeout', () => {
  const UUID = '550e8400-e29b-41d4-a716-446655440000';
  const toolCalls: Array<[string, Record<string, unknown>]> = [
    ['pluggedin_ask_knowledge_base', { query: 'q' }],
    ['pluggedin_send_notification', { message: 'm' }],
    ['pluggedin_list_notifications', {}],
    ['pluggedin_mark_notification_done', { notificationId: UUID }],
    ['pluggedin_delete_notification', { notificationId: UUID }],
    ['pluggedin_create_document', { title: 't', content: 'c', metadata: { model: { name: 'm', provider: 'p' } } }],
    ['pluggedin_list_documents', {}],
    ['pluggedin_search_documents', { query: 'q' }],
    ['pluggedin_get_document', { documentId: UUID }],
    ['pluggedin_update_document', { documentId: UUID, operation: 'append', content: 'c' }],
    ['pluggedin_clipboard_set', { name: 'n', value: 'v' }],
    ['pluggedin_clipboard_get', {}],
    ['pluggedin_clipboard_delete', { clearAll: true }],
    ['pluggedin_clipboard_list', {}],
    ['pluggedin_clipboard_push', { value: 'v' }],
    ['pluggedin_clipboard_pop', {}],
    ['pluggedin_memory_session_start', { content_session_id: 's' }],
    ['pluggedin_memory_session_end', { memory_session_id: 'abc' }],
    ['pluggedin_memory_observe', { session_uuid: UUID, type: 'insight', content: 'c' }],
    ['pluggedin_memory_search', { query: 'q' }],
    ['pluggedin_memory_details', { memory_uuids: [UUID] }],
    ['pluggedin_cbp_query', { query: 'q' }],
    ['pluggedin_cbp_feedback', { pattern_uuid: UUID, rating: 5, feedback_type: 'helpful' }],
    ['pluggedin_memory_search_with_context', { query: 'q' }],
    ['pluggedin_memory_individuation', {}],
  ];

  for (const [toolName, args] of toolCalls) {
    it(`${toolName}`, async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = { data: {} } as any;
      const get = vi.spyOn(axios, 'get').mockResolvedValue(response);
      const post = vi.spyOn(axios, 'post').mockResolvedValue(response);
      const patch = vi.spyOn(axios, 'patch').mockResolvedValue(response);
      const del = vi.spyOn(axios, 'delete').mockResolvedValue(response);

      // Response formatting may fail on the empty stub response; only the request matters here
      await handlers.handleStaticTool(toolName, args).catch(() => {});

      const configs = [
        ...get.mock.calls.map(c => c[1]),
        ...del.mock.calls.map(c => c[1]),
        ...post.mock.calls.map(c => c[2]),
        ...patch.mock.calls.map(c => c[2]),
      ];
      expect(configs.length).toBeGreaterThan(0);
      for (const config of configs) {
        expect(config?.timeout).toBeGreaterThan(0);
        expect(Number.isFinite(config?.timeout)).toBe(true);
      }
    });
  }
});
