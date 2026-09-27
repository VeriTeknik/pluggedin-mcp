import { getMcpServers, onMcpServersInvalidated } from "./fetch-pluggedinmcp.js";
import { ServerParameters } from "./types.js"; // Corrected import path
import {
  ConnectedClient,
  createPluggedinMCPClient,
  connectPluggedinMCPClient,
} from "./client.js";
import { getSessionKey } from "./utils.js";

const _sessions: Record<string, ConnectedClient> = {};
// Connections being established, shared by concurrent callers for the same configuration
const _pendingSessions = new Map<string, Promise<ConnectedClient | undefined>>();
// Tail of each server UUID's queue, so configurations of one server connect one at a time
const _uuidQueues = new Map<string, Promise<unknown>>();
// Bumped by cleanupAllSessions; connections started before a bump are closed, not cached
let _generation = 0;

// Removed logger

const runExclusive = <T>(uuid: string, task: () => Promise<T>): Promise<T> => {
  const run = (_uuidQueues.get(uuid) ?? Promise.resolve()).then(task);
  const tail = run.catch(() => {});
  _uuidQueues.set(uuid, tail);
  tail.then(() => {
    if (_uuidQueues.get(uuid) === tail) {
      _uuidQueues.delete(uuid);
    }
  });
  return run;
};

const connectSession = async (
  sessionKey: string,
  uuid: string,
  params: ServerParameters,
  generation: number
): Promise<ConnectedClient | undefined> => {
  // Close existing session for this UUID if it exists with a different hash
  const old_session_keys = Object.keys(_sessions).filter(
    (k) => k !== sessionKey && k.startsWith(`${uuid}_`)
  );

  await Promise.allSettled(
    old_session_keys.map(async (old_session_key) => {
      const old_session = _sessions[old_session_key];
      delete _sessions[old_session_key];
      await old_session.cleanup();
    })
  );

  const { client, transport } = createPluggedinMCPClient(params);
  if (!client || !transport) {
    return;
  }

  // Drop the cached entry when the downstream connection closes (e.g. the server exits),
  // unless it has already been replaced by a newer client
  client.onclose = () => {
    if (_sessions[sessionKey]?.client === client) {
      delete _sessions[sessionKey];
    }
  };

  const newClient = await connectPluggedinMCPClient(client, transport);
  if (!newClient) {
    return;
  }

  if (generation !== _generation) {
    // cleanupAllSessions ran while this connection was being established
    await newClient.cleanup().catch(() => {});
    return;
  }

  _sessions[sessionKey] = newClient;
  return newClient;
};

export const getSession = async (
  sessionKey: string,
  uuid: string,
  params: ServerParameters
): Promise<ConnectedClient | undefined> => {
  const existing = _sessions[sessionKey];
  if (existing) {
    if (existing.client.transport) {
      return existing;
    }
    // The downstream connection has closed; reconnect below
    delete _sessions[sessionKey];
    existing.cleanup().catch(() => {});
  }

  const pending = _pendingSessions.get(sessionKey);
  if (pending) {
    return pending;
  }

  const generation = _generation;
  const connecting = runExclusive(uuid, () =>
    connectSession(sessionKey, uuid, params, generation)
  ).finally(() => {
    if (_pendingSessions.get(sessionKey) === connecting) {
      _pendingSessions.delete(sessionKey);
    }
  });
  _pendingSessions.set(sessionKey, connecting);
  return connecting;
};

export const initSessions = async (): Promise<void> => {
  const serverParams = await getMcpServers(true);

  await Promise.allSettled(
    Object.entries(serverParams).map(async ([uuid, params]) => {
      const sessionKey = getSessionKey(uuid, params);
      try {
        await getSession(sessionKey, uuid, params);
      } catch (error) {
        // Log errors during initial session establishment attempt
        // logger.error(`Failed to initialize session for ${params.name || uuid} during initSessions:`, error); // Removed logging
      }
    })
  );
};

export const cleanupAllSessions = async (): Promise<void> => {
  // Connections still being established close themselves when they complete
  _generation++;

  await Promise.allSettled(
    Object.entries(_sessions).map(async ([sessionKey, session]) => {
      delete _sessions[sessionKey];
      await session.cleanup();
    })
  );
};

// Downstream sessions carry credentials from the server configurations; close them
// when those configurations are discarded (e.g. the app revoked the API key)
onMcpServersInvalidated(cleanupAllSessions);
