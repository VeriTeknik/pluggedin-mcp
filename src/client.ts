import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ServerParameters } from "./fetch-pluggedin.js";

const sleep = (time: number) =>
  new Promise<void>((resolve) => setTimeout(() => resolve(), time));
export interface ConnectedClient {
  client: Client;
  cleanup: () => Promise<void>;
}

export const createPluggedinClient = (
  serverParams: ServerParameters
): { client: Client | undefined; transport: Transport | undefined } => {
  let transport: Transport | undefined;

  // Create the appropriate transport based on server type
  // Default to "STDIO" if type is undefined
  if (!serverParams.type || serverParams.type === "STDIO") {
    const stdioParams: StdioServerParameters = {
      command: serverParams.command || "",
      args: serverParams.args || undefined,
      env: serverParams.env || undefined,
      // Use default values for other optional properties
      // stderr and cwd will use their default values
    };
    transport = new StdioClientTransport(stdioParams);
  } else if (serverParams.type === "SSE" && serverParams.url) {
    transport = new SSEClientTransport(new URL(serverParams.url));
  } else {
    console.error(`Unsupported server type: ${serverParams.type}`);
    return { client: undefined, transport: undefined };
  }

  const client = new Client(
    {
      name: "Pluggedin",
      version: "0.3.0",
    },
    {
      capabilities: {
        prompts: {},
        resources: { subscribe: true },
        tools: {},
      },
    }
  );
  return { client, transport };
};

export const connectPluggedinClient = async (
  client: Client,
  transport: Transport
): Promise<ConnectedClient | undefined> => {
  const waitFor = 2500;
  const retries = 3;
  let count = 0;
  let retry = true;

  while (retry) {
    try {
      await client.connect(transport);

      return {
        client,
        cleanup: async () => {
          await transport.close();
          await client.close();
        },
      };
    } catch (error) {
      count++;
      retry = count < retries;
      if (retry) {
        try {
          await client.close();
        } catch {}
        await sleep(waitFor);
      }
    }
  }
};
