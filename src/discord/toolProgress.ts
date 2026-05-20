import type { Message } from 'discord.js';
import type { WritableTextChannel } from './types.js';

const PROGRESS_TOOL_NAMES = new Set([
  'research_web',
  'verify_web_claim',
  'search_web',
  'summarize_url',
  'visual_search_image',
]);

type ProgressHandle = {
  complete: (ok: boolean, resultText?: string) => Promise<void>;
  dismiss: () => Promise<void>;
};

function truncate(value: string, maxChars: number) {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3)}...`;
}

function getTopic(toolName: string, args: Record<string, unknown>) {
  const value = toolName === 'verify_web_claim'
    ? args.question || args.claim
    : args.query || args.url || (Array.isArray(args.urls) ? args.urls[0] : undefined);

  return typeof value === 'string' && value.trim()
    ? truncate(value.replace(/\s+/g, ' ').trim(), 120)
    : undefined;
}

function estimateSources(toolName: string, args: Record<string, unknown>) {
  if (toolName === 'summarize_url') {
    if (Array.isArray(args.urls)) return Math.min(args.urls.length, 10);
    return 1;
  }

  if (toolName === 'search_web') {
    return Math.max(1, Math.min(10, typeof args.limit === 'number' ? Math.floor(args.limit) : 8));
  }

  if (toolName === 'research_web' || toolName === 'verify_web_claim') {
    const depth = args.depth === 'deep' ? 'deep' : args.depth === 'quick' ? 'quick' : 'standard';
    if (depth === 'deep') return 8;
    if (depth === 'quick') return 4;
    return 6;
  }

  return undefined;
}

function getProgressSteps(toolName: string, args: Record<string, unknown>) {
  const sources = estimateSources(toolName, args);
  const sourceText = sources ? `${sources} fonte${sources === 1 ? '' : 's'}` : 'fontes';

  if (toolName === 'verify_web_claim') {
    return [
      'Verificando a afirmação...',
      'Quebrando a pergunta em partes pesquisáveis...',
      'Buscando fontes independentes...',
      `Lendo até ${sourceText} relevantes...`,
      'Cruzando evidências e contradições...',
      'Separando o que dá para afirmar do que ficou incerto...',
    ];
  }

  if (toolName === 'research_web') {
    return [
      'Pesquisando...',
      'Planejando consultas melhores...',
      'Buscando fontes relevantes...',
      `Abrindo até ${sourceText}...`,
      'Extraindo os pontos principais...',
      'Cruzando dados entre as fontes...',
    ];
  }

  if (toolName === 'summarize_url') {
    return [
      'Abrindo fonte...',
      `Extraindo conteúdo de até ${sourceText}...`,
      'Limpando o texto da página...',
      'Separando informações úteis...',
    ];
  }

  if (toolName === 'visual_search_image') {
    return [
      'Analisando a imagem...',
      'Levantando hipóteses visuais...',
      'Buscando fontes para confirmar...',
      'Verificando se os resultados batem com a imagem...',
    ];
  }

  return [
    'Pesquisando...',
    'Buscando resultados...',
    'Lendo os trechos encontrados...',
  ];
}

function renderProgress(step: string, topic?: string) {
  return topic ? `${step}\n> ${topic}` : step;
}

function sourceLabel(source: any) {
  const value = source?.siteName || source?.title || source?.label || source?.url;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return truncate(value.replace(/^https?:\/\//, '').replace(/^www\./, '').trim(), 80);
}

function extractSources(toolName: string, resultText?: string) {
  if (!resultText) return [];

  try {
    const parsed = JSON.parse(resultText);
    const candidates: any[] = [];

    if (Array.isArray(parsed.sources)) candidates.push(...parsed.sources);
    if (Array.isArray(parsed.research?.sources)) candidates.push(...parsed.research.sources);
    if (Array.isArray(parsed.results)) candidates.push(...parsed.results);
    if (Array.isArray(parsed.pages)) candidates.push(...parsed.pages);
    if (Array.isArray(parsed.researchRuns)) {
      for (const run of parsed.researchRuns) {
        if (Array.isArray(run.sources)) candidates.push(...run.sources);
      }
    }

    return candidates
      .map(sourceLabel)
      .filter((value): value is string => Boolean(value))
      .filter((value, index, all) => all.findIndex(item => item.toLocaleLowerCase('pt-BR') === value.toLocaleLowerCase('pt-BR')) === index)
      .slice(0, toolName === 'search_web' ? 6 : 10);
  } catch {
    return [];
  }
}

function renderSources(toolName: string, resultText?: string) {
  const sources = extractSources(toolName, resultText);
  if (sources.length === 0) return 'Fontes consultadas. Redigindo a resposta...';

  return [
    'Fontes consultadas. Redigindo a resposta...',
    sources.join(' | '),
  ].join('\n');
}

export function shouldShowToolProgress(toolName: string) {
  return PROGRESS_TOOL_NAMES.has(toolName);
}

export async function startToolProgress(
  channel: WritableTextChannel,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ProgressHandle | null> {
  if (!shouldShowToolProgress(toolName)) return null;

  const topic = getTopic(toolName, args);
  const steps = getProgressSteps(toolName, args);
  let stepIndex = 0;
  let message: Message | null = null;
  let timer: NodeJS.Timeout | null = null;

  try {
    message = await channel.send(renderProgress(steps[stepIndex], topic));
    timer = setInterval(() => {
      stepIndex = Math.min(stepIndex + 1, steps.length - 1);
      void message?.edit(renderProgress(steps[stepIndex], topic)).catch(() => {});
    }, 7000);
  } catch {
    return null;
  }

  return {
    complete: async (ok: boolean, resultText?: string) => {
      if (timer) clearInterval(timer);
      const finalText = ok
        ? renderSources(toolName, resultText)
        : 'Não consegui concluir essa pesquisa do jeito esperado.';
      await message?.edit(finalText).catch(() => {});
    },
    dismiss: async () => {
      if (timer) clearInterval(timer);
      await message?.delete().catch(() => {});
    },
  };
}
