import { callMcpTool } from '../mcp/client.js';
import { logger } from '../utils/logger.js';
import type { ImageCandidate } from './types.js';

type ErrorTracker = {
  errorCount: number;
  lastErrors: string[];
  timestamp: number;
};

const errorTracking = new Map<string, ErrorTracker>();
const IMAGE_URL_TOOL_NAMES = new Set(['sticker_emoji_creator', 'analyze_image', 'visual_search_image']);

export function isDirectMediaTool(toolName: string) {
  return ['create_image', 'edit_image', 'sticker_emoji_creator', 'create_sticker_emoji'].includes(toolName);
}

function getImageCandidateUrls(candidates: ImageCandidate[], requestedUrl?: unknown) {
  const urls: string[] = [];

  const addUrl = (url?: unknown) => {
    if (typeof url !== 'string' || !url.startsWith('http')) return;
    if (!urls.includes(url)) urls.push(url);
  };

  addUrl(requestedUrl);

  for (const candidate of [...candidates].reverse()) {
    addUrl(candidate.url);
    addUrl(candidate.proxyUrl);
  }

  return urls;
}

function summarizeToolResult(toolName: string, resultText: string) {
  try {
    const parsed = JSON.parse(resultText);

    if (toolName === 'visual_search_image') {
      const queries = Array.isArray(parsed.searchQueries) ? parsed.searchQueries.slice(0, 4).join(' | ') : '';
      const topResults = Array.isArray(parsed.results)
        ? parsed.results.slice(0, 3).map((result: any) => `${result.title}${typeof result.relevance === 'number' ? ` (${result.relevance})` : ''}`).join(' | ')
        : '';
      const verification = parsed.verification?.answer ? `${parsed.verification.answer} [${parsed.verification.confidence || 'sem confiança'}]` : '';
      return `visual_search_image: queries=${queries || 'n/a'}; top=${topResults || 'n/a'}; verification=${verification || 'n/a'}`;
    }

    if (toolName === 'analyze_image') {
      return `analyze_image: ${(parsed.analysis || parsed.error || '').slice(0, 500)}`;
    }

    if (toolName === 'search_web') {
      const query = parsed.query || 'n/a';
      const topResults = Array.isArray(parsed.results)
        ? parsed.results.slice(0, 3).map((result: any) => result.title).join(' | ')
        : '';
      return `search_web: query=${query}; top=${topResults || 'n/a'}`;
    }

    return `${toolName}: ${resultText.slice(0, 500)}`;
  } catch {
    return `${toolName}: ${resultText.slice(0, 500)}`;
  }
}

async function callImageUrlToolWithFallback(toolName: string, functionArgs: Record<string, unknown>, imageCandidates: ImageCandidate[]) {
  const urlsToTry = getImageCandidateUrls(imageCandidates, functionArgs.imageUrl);

  if (urlsToTry.length === 0) {
    return JSON.stringify({
      success: false,
      error: 'Nenhuma imagem anexada ou URL de imagem foi encontrada para esta ferramenta.',
    });
  }

  let lastResult = '';

  for (const imageUrl of urlsToTry) {
    const result = await callMcpTool(toolName, { ...functionArgs, imageUrl });
    lastResult = result;

    try {
      const parsed = JSON.parse(result);
      if (parsed.success) return result;
    } catch {
      return result;
    }
  }

  return lastResult;
}

function detectErrorLoop(toolName: string, errorMessage: string): boolean {
  const key = `${toolName}:${errorMessage}`;
  const now = Date.now();
  const tracker = errorTracking.get(key);

  if (!tracker || now - tracker.timestamp > 300000) {
    errorTracking.set(key, { errorCount: 1, lastErrors: [errorMessage], timestamp: now });
    return false;
  }

  tracker.errorCount++;
  tracker.lastErrors.push(errorMessage);
  tracker.timestamp = now;

  return tracker.errorCount >= 3;
}

function formatToolError(toolName: string, error: unknown) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  logger.error(`Erro ao executar ferramenta MCP ${toolName}:`, error);

  if (detectErrorLoop(toolName, errorMessage)) {
    logger.warn(`Loop de erro detectado em ${toolName}: ${errorMessage}`);
    return `[ERRO RECORRENTE DETECTADO] A ferramenta ${toolName} falhou múltiplas vezes com o mesmo erro: "${errorMessage}". Este erro parece estar em loop. Você deve informar o usuário sobre a falha e considerar uma abordagem alternativa ou desistir desta ação específica.`;
  }

  return `[ERRO NA FERRAMENTA] A ferramenta ${toolName} falhou com o erro: "${errorMessage}". Você pode tentar novamente com parâmetros diferentes, usar outra abordagem, ou informar o usuário sobre a falha. Analise o erro e decida a melhor ação.`;
}

export async function executeToolCall(toolName: string, functionArgs: Record<string, unknown>, imageCandidates: ImageCandidate[]) {
  try {
    const result = IMAGE_URL_TOOL_NAMES.has(toolName)
      ? await callImageUrlToolWithFallback(toolName, functionArgs, imageCandidates)
      : await callMcpTool(toolName, functionArgs);

    return {
      ok: true as const,
      result,
      summary: summarizeToolResult(toolName, result),
    };
  } catch (error) {
    return {
      ok: false as const,
      result: formatToolError(toolName, error),
    };
  }
}
