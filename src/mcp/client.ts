import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type OpenAI from 'openai';
import path from 'path';
import { logger } from '../utils/logger.js';
import { loadToolsConfig, registerTool, isToolEnabled, recordToolExecution } from '../utils/toolsManager.js';

type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

let mcpClient: Client | null = null;
let tools: McpTool[] = [];
let isConnecting = false;
let connected = false;
let reconnectAttempts = 0;

const DEFAULT_MCP_TOOL_TIMEOUT_MS = Number(process.env.MCP_TOOL_TIMEOUT_MS || 180000);
const RESEARCH_MCP_TOOL_TIMEOUT_MS = Number(process.env.MCP_RESEARCH_TIMEOUT_MS || 900000);
const LONG_RUNNING_TOOLS = new Set([
  'research_web',
  'verify_web_claim',
  'visual_search_image',
  'create_image',
  'edit_image',
  'get_image_result',
]);

function getServerPath() {
  return path.join(process.cwd(), 'dist', 'mcp', 'server.js');
}

function getProxyPath() {
  return path.join(process.cwd(), 'scripts', 'mcp_stdio_proxy.py');
}

function toOpenAiTool(tool: McpTool): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.inputSchema || { type: 'object', properties: {} },
    },
  };
}

function mcpResultToText(result: unknown): string {
  const maybeResult = result as { content?: Array<{ type?: string; text?: string }> };
  const textParts = maybeResult.content
    ?.filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text) || [];

  if (textParts.length > 0) {
    return textParts.join('\n');
  }

  return JSON.stringify(result);
}

async function connectMcpClient() {
  const client = new Client({
    name: 'discord-bot-host',
    version: '1.0.0',
  });

  const stdioTransport = new StdioClientTransport({
    command: process.env.MCP_STDIO_PROXY_COMMAND || 'python3',
    args: [getProxyPath(), process.execPath, getServerPath()],
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV || 'production',
    } as Record<string, string>,
  });

  await client.connect(stdioTransport);

  const response = await client.listTools();
  tools = response.tools as McpTool[];

  for (const tool of tools) {
    await registerTool(tool.name, tool.description || '');
  }

  mcpClient = client;
  connected = true;
  reconnectAttempts = 0;

  logger.debug(`MCP stdio pronto (${tools.length} tools)`);
}

export async function initializeMcpClient() {
  if (isConnecting) return;

  isConnecting = true;

  try {
    await loadToolsConfig();
    await shutdownMcpClient();
    await connectMcpClient();
  } catch (error) {
    connected = false;
    reconnectAttempts++;
    logger.error('Erro ao inicializar cliente MCP stdio:', error);
    throw error;
  } finally {
    isConnecting = false;
  }
}

async function ensureMcpClient() {
  if (mcpClient && connected) return;
  await initializeMcpClient();
}

export async function getOpenAiTools(): Promise<OpenAI.Chat.Completions.ChatCompletionTool[]> {
  await ensureMcpClient();
  await loadToolsConfig();
  return tools.filter((tool) => isToolEnabled(tool.name)).map(toOpenAiTool);
}

export async function callMcpTool(toolName: string, args: Record<string, unknown>): Promise<string> {
  await ensureMcpClient();
  await loadToolsConfig();

  if (!isToolEnabled(toolName)) {
    throw new Error(`A ferramenta ${toolName} está desabilitada`);
  }

  let success = false;
  const timeout = LONG_RUNNING_TOOLS.has(toolName)
    ? RESEARCH_MCP_TOOL_TIMEOUT_MS
    : DEFAULT_MCP_TOOL_TIMEOUT_MS;

  try {
    const result = await mcpClient!.callTool({
      name: toolName,
      arguments: args,
    }, undefined, {
      timeout,
      maxTotalTimeout: timeout,
    });

    success = true;
    return mcpResultToText(result);
  } catch (error) {
    connected = false;
    throw error;
  } finally {
    await recordToolExecution(toolName, success);
  }
}

export async function shutdownMcpClient() {
  if (mcpClient) {
    await mcpClient.close().catch(() => {});
  }

  mcpClient = null;
  connected = false;
}

export function getMcpStatus() {
  return {
    connected,
    isConnecting,
    reconnectAttempts,
    totalTools: tools.length,
    tools: tools.map((tool) => ({
      name: tool.name,
      enabled: isToolEnabled(tool.name),
    })),
  };
}
