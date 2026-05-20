import {
  addResearchMemory,
  getResearchMemoryForMessages,
  pruneResearchMemoryToMessages,
  type ResearchMemoryRecord,
} from '../utils/database.js';
import { logger } from '../utils/logger.js';

const RESEARCH_TOOL_NAMES = new Set(['research_web', 'verify_web_claim', 'search_web', 'summarize_url', 'visual_search_image']);
const MAX_ENTRIES_PER_CHANNEL = 24;
const MAX_ENTRY_CHARS = 20000;
const MAX_CONTEXT_CHARS = 50000;

type ResearchMemoryEntry = {
  channelId: string;
  sourceMessageId: string;
  toolName: string;
  createdAt: string;
  content: string;
};

const researchMemoryByChannel = new Map<string, ResearchMemoryEntry[]>();

function truncate(value: string, maxChars: number) {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3)}...`;
}

function compactToolResult(toolName: string, resultText: string) {
  try {
    const parsed = JSON.parse(resultText);

    if (toolName === 'research_web') {
      return JSON.stringify({
        query: parsed.query,
        depth: parsed.depth,
        queryPlan: parsed.queryPlan,
        sources: parsed.sources,
        failedSources: parsed.failedSources,
        synthesis: parsed.synthesis,
        citationGuidance: parsed.citationGuidance,
      });
    }

    if (toolName === 'verify_web_claim') {
      return JSON.stringify({
        claim: parsed.claim,
        question: parsed.question,
        verdict: parsed.verdict,
        sources: parsed.sources,
        citationGuidance: parsed.citationGuidance,
        research: parsed.research ? {
          query: parsed.research.query,
          depth: parsed.research.depth,
          queryPlan: parsed.research.queryPlan,
          synthesis: parsed.research.synthesis,
        } : undefined,
      });
    }

    if (toolName === 'search_web') {
      return JSON.stringify({
        query: parsed.query,
        attemptedQueries: parsed.attemptedQueries,
        results: Array.isArray(parsed.results)
          ? parsed.results.map((result: any) => ({
            title: result.title,
            url: result.url,
            snippet: result.snippet,
            source: result.source,
          }))
          : [],
        answerHints: parsed.answerHints,
      });
    }

    if (toolName === 'summarize_url') {
      return JSON.stringify({
        pages: Array.isArray(parsed.pages)
          ? parsed.pages.map((page: any) => ({
            ok: page.ok,
            url: page.url,
            title: page.title,
            description: page.description,
            text: typeof page.text === 'string' ? truncate(page.text, 7000) : undefined,
            error: page.error,
          }))
          : [],
      });
    }

    if (toolName === 'visual_search_image') {
      return JSON.stringify({
        verification: parsed.verification,
        searchAssessment: parsed.searchAssessment,
        searchGaps: parsed.searchGaps,
        results: Array.isArray(parsed.results)
          ? parsed.results.map((result: any) => ({
            title: result.title,
            url: result.url,
            snippet: result.snippet,
            relevance: result.relevance,
            supportsAnswer: result.supportsAnswer,
            evidence: result.evidence,
          }))
          : [],
      });
    }
  } catch {
    return resultText;
  }

  return resultText;
}

export function recordResearchMemory(args: {
  channelId: string;
  sourceMessageId: string;
  toolName: string;
  resultText: string;
}) {
  if (!RESEARCH_TOOL_NAMES.has(args.toolName)) return;
  const content = truncate(compactToolResult(args.toolName, args.resultText), MAX_ENTRY_CHARS);

  const entries = researchMemoryByChannel.get(args.channelId) || [];
  entries.push({
    channelId: args.channelId,
    sourceMessageId: args.sourceMessageId,
    toolName: args.toolName,
    createdAt: new Date().toISOString(),
    content,
  });

  researchMemoryByChannel.set(args.channelId, entries.slice(-MAX_ENTRIES_PER_CHANNEL));
  void addResearchMemory({
    channelId: args.channelId,
    sourceMessageId: args.sourceMessageId,
    toolName: args.toolName,
    content,
  }).catch((error) => {
    logger.warn(`Não foi possível persistir memória de pesquisa: ${String(error)}`);
  });
}

function renderResearchEntries(entries: Array<ResearchMemoryEntry | ResearchMemoryRecord>) {
  return entries
    .map((entry, index) => [
      `Pesquisa ${index + 1}`,
      `tool: ${entry.toolName}`,
      `createdAt: ${entry.createdAt}`,
      `sourceMessageId: ${entry.sourceMessageId}`,
      `result: ${entry.content}`,
    ].join('\n'))
    .join('\n\n');
}

export async function getRecentResearchMemory(channelId: string, recentMessageIds: Set<string>) {
  const entries = researchMemoryByChannel.get(channelId) || [];
  const retained = entries.filter(entry => recentMessageIds.has(entry.sourceMessageId));

  if (retained.length !== entries.length) {
    researchMemoryByChannel.set(channelId, retained);
  }

  const messageIds = [...recentMessageIds];
  let persistedEntries: ResearchMemoryRecord[] = [];
  try {
    await pruneResearchMemoryToMessages(channelId, messageIds);
    persistedEntries = await getResearchMemoryForMessages(channelId, messageIds);
  } catch (error) {
    logger.warn(`Não foi possível recuperar memória de pesquisa persistida: ${String(error)}`);
  }

  const merged = [
    ...persistedEntries,
    ...retained.filter(entry => !persistedEntries.some(persisted => (
      persisted.sourceMessageId === entry.sourceMessageId
      && persisted.toolName === entry.toolName
      && persisted.content === entry.content
    ))),
  ].slice(-MAX_ENTRIES_PER_CHANNEL);

  if (merged.length === 0) return undefined;

  return truncate([
    'Memoria interna de pesquisas recentes neste canal.',
    'Use estes resultados apenas para responder follow-ups sobre o mesmo assunto ou para fornecer fontes ja consultadas se o usuario pedir.',
    'Se precisar atualizar fatos atuais, pesquise de novo.',
    '',
    renderResearchEntries(merged),
  ].join('\n'), MAX_CONTEXT_CHARS);
}
