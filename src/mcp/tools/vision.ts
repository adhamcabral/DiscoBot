/**
 * Separates visual description from evidence-backed identification so image
 * guesses are not presented as confirmed facts.
 */
import OpenAI from 'openai';
import { searchWeb } from './web.js';

type AnalyzeMode = 'describe' | 'ocr' | 'meme' | 'screenshot' | 'general';

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  source?: string;
};

type SearchCandidate = SearchResult & {
  query: string;
};

type RankedSearchResult = SearchCandidate & {
  relevance: number;
  supportsAnswer: boolean;
  evidence: string;
  limitations: string[];
};

type VisualEntity = {
  name: string;
  category?: string;
  confidence?: 'high' | 'medium' | 'low';
  evidence?: string;
};

type SearchQueryPlan = {
  query: string;
  purpose?: string;
};

type VisualIdentification = {
  visualSummary: string;
  observedText: string[];
  notableElements: string[];
  likelyEntities: VisualEntity[];
  searchQueries: SearchQueryPlan[];
  searchStrategy: string;
  uncertainties: string[];
};

let openai: OpenAI | null = null;

function getOpenAI() {
  openai ??= new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  return openai;
}

function jsonText(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  };
}

async function fetchImageAsDataUrl(imageUrl: string) {
  const url = new URL(imageUrl);

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('A imagem precisa estar em uma URL http ou https.');
  }

  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) DiscordBot/1.0',
      accept: 'image/png,image/jpeg,image/webp,image/gif,image/*;q=0.8,*/*;q=0.3',
    },
  });

  if (!response.ok) {
    throw new Error(`Falha ao baixar imagem: HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || 'image/png';
  if (!contentType.startsWith('image/')) {
    throw new Error(`URL não retornou uma imagem: ${contentType}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const maxBytes = 15 * 1024 * 1024;
  if (arrayBuffer.byteLength > maxBytes) {
    throw new Error('Imagem grande demais. Envie uma imagem de até 15 MB.');
  }

  return `data:${contentType};base64,${Buffer.from(arrayBuffer).toString('base64')}`;
}

function buildAnalyzePrompt(mode: AnalyzeMode, question?: string) {
  return [
    'Analyze the image carefully and answer in Portuguese.',
    'Be concrete and useful. If something is uncertain, say it is uncertain.',
    'Do not identify private people by name. You may identify public fictional characters, logos, landmarks, visible text, objects, UI, and scene context when there is enough evidence.',
    'For OCR, transcribe visible text and preserve line breaks when useful.',
    'For memes, explain the joke, format, references, and why it may be funny.',
    'For screenshots, explain the interface, visible messages, errors, and likely next steps.',
    `Requested mode: ${mode}.`,
    question ? `User question: ${question}` : '',
  ].filter(Boolean).join('\n');
}

async function analyzeImageText(args: {
  imageUrl: string;
  question?: string;
  mode?: AnalyzeMode;
  model?: string;
}) {
  const {
    imageUrl,
    question,
    mode = 'general',
    model = process.env.VISION_MODEL || 'gpt-4o-mini',
  } = args;

  const dataUrl = await fetchImageAsDataUrl(imageUrl);
  const response = await getOpenAI().chat.completions.create({
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: buildAnalyzePrompt(mode, question) },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0.2,
  });

  return response.choices[0]?.message?.content?.trim() || 'Não consegui analisar a imagem.';
}

async function identifyImageForSearch(args: {
  imageUrl: string;
  question?: string;
  model?: string;
}) {
  const {
    imageUrl,
    question,
    model = process.env.VISION_SEARCH_MODEL || process.env.VISION_MODEL || 'gpt-4o',
  } = args;

  const dataUrl = await fetchImageAsDataUrl(imageUrl);
  const response = await getOpenAI().chat.completions.create({
    model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              'Look at this image and prepare a flexible web-search plan to answer the user question.',
              'The plan must adapt to the image and question. Do not rely on fixed websites or fixed categories unless the user question or visible evidence clearly calls for them.',
              'Return only strict JSON with this shape:',
              '{"visualSummary":"...","observedText":["..."],"notableElements":["..."],"likelyEntities":[{"name":"...","category":"...","confidence":"high|medium|low","evidence":"..."}],"searchQueries":[{"query":"...","purpose":"..."}],"searchStrategy":"...","uncertainties":["..."]}',
              'Create several independent queries when useful: exact visible text, likely entity names, broad visual descriptors, logos, landmarks, art style, UI text, or contextual clues.',
              'Prefer exact candidate names, visible text, source clues, logo text, filenames, signage, UI labels, or distinctive phrases. Broad visual-descriptor queries are fallback only.',
              'Do not generate queries for image-recognition tools, reverse-search apps, app stores, or generic "find by image" services. The user wants the answer, not another tool recommendation.',
              'Use Portuguese, English, Japanese, or other languages only when appropriate to the visible evidence or user question.',
              'If a likely entity is uncertain, include broader fallback queries instead of overcommitting.',
              'Do not identify private people by name. If the image is generic and not searchable, keep searchQueries broad but honest.',
              question ? `User question: ${question}` : '',
            ].filter(Boolean).join('\n'),
          },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0.1,
    response_format: { type: 'json_object' },
  });

  const text = response.choices[0]?.message?.content || '{}';
  try {
    const parsed = JSON.parse(text) as {
      visualSummary?: string;
      observedText?: string[];
      notableElements?: string[];
      likelyEntities?: Array<string | VisualEntity>;
      searchQueries?: Array<string | SearchQueryPlan>;
      searchStrategy?: string;
      uncertainties?: string[];
    };

    return {
      visualSummary: parsed.visualSummary || '',
      observedText: Array.isArray(parsed.observedText) ? parsed.observedText.filter(Boolean) : [],
      notableElements: Array.isArray(parsed.notableElements) ? parsed.notableElements.filter(Boolean) : [],
      likelyEntities: Array.isArray(parsed.likelyEntities)
        ? parsed.likelyEntities
          .map(entity => (typeof entity === 'string' ? { name: entity, confidence: 'low' as const } : entity))
          .filter(entity => entity?.name)
        : [],
      searchQueries: Array.isArray(parsed.searchQueries)
        ? parsed.searchQueries
          .map(query => (typeof query === 'string' ? { query } : query))
          .filter(query => query?.query)
        : [],
      searchStrategy: parsed.searchStrategy || '',
      uncertainties: Array.isArray(parsed.uncertainties) ? parsed.uncertainties.filter(Boolean) : [],
    };
  } catch {
    return {
      visualSummary: text,
      observedText: [],
      notableElements: [],
      likelyEntities: [],
      searchQueries: question ? [{ query: question, purpose: 'Pergunta original do usuário' }] : [],
      searchStrategy: 'Fallback para a pergunta original porque a resposta de identificação não veio em JSON válido.',
      uncertainties: ['A resposta de identificação não veio em JSON válido.'],
    };
  }
}

function addQuery(queries: string[], query?: string) {
  const normalized = query?.replace(/\s+/g, ' ').trim();
  if (!normalized) return;

  const key = normalized.toLocaleLowerCase('pt-BR');
  if (!queries.some(existing => existing.toLocaleLowerCase('pt-BR') === key)) {
    queries.push(normalized);
  }
}

function normalizeForMatch(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR');
}

function isMetaImageRecognitionResult(result: SearchResult) {
  const text = normalizeForMatch(`${result.title} ${result.snippet} ${result.url}`);
  return isMetaImageRecognitionText(text);
}

function isMetaImageRecognitionText(value: string) {
  const text = normalizeForMatch(value);
  return [
    'reverse image search',
    'image recognition',
    'find anime by image',
    'anime image recognition',
    'recognize anime',
    'identificar anime por imagem',
    'reconhecimento de imagem',
    'upload image',
    'search by image',
    'google play',
    'app store',
  ].some(term => text.includes(term));
}

// Prefer exact visible clues; broad visual descriptions often find generic pages.
function buildVisualSearchQueries(identification: VisualIdentification, question?: string, maxQueries = 8) {
  const queries: string[] = [];

  for (const plannedQuery of identification.searchQueries) {
    addQuery(queries, plannedQuery.query);
  }

  for (const entity of identification.likelyEntities) {
    addQuery(queries, question && entity.confidence !== 'low' ? `${entity.name} ${question}` : entity.name);
  }

  for (const text of identification.observedText) {
    addQuery(queries, `"${text}"`);
  }

  const hasSpecificSignals = identification.likelyEntities.some(entity => entity.confidence !== 'low')
    || identification.observedText.length > 0
    || identification.notableElements.length >= 3;

  if (question && identification.visualSummary && hasSpecificSignals) {
    addQuery(queries, `${question} ${identification.visualSummary}`);
  }

  addQuery(queries, question);

  return queries.filter(query => !isMetaImageRecognitionText(query)).slice(0, maxQueries);
}

function parseSearchResponse(value: unknown) {
  const maybeResult = value as { content?: Array<{ type?: string; text?: string }> };
  const text = maybeResult.content?.find(part => part.type === 'text')?.text || '{}';
  try {
    const parsed = JSON.parse(text) as { results?: SearchResult[]; answerHints?: unknown[]; attemptedQueries?: string[] };
    return {
      results: Array.isArray(parsed.results) ? parsed.results : [],
      answerHints: Array.isArray(parsed.answerHints) ? parsed.answerHints : [],
      attemptedQueries: Array.isArray(parsed.attemptedQueries) ? parsed.attemptedQueries : [],
    };
  } catch {
    return { results: [], answerHints: [], attemptedQueries: [] };
  }
}

async function rankVisualSearchResults(args: {
  question?: string;
  identification: VisualIdentification;
  results: SearchCandidate[];
  model?: string;
}) {
  const {
    question,
    identification,
    results,
    model = process.env.VISION_SEARCH_MODEL || process.env.VISION_MODEL || 'gpt-4o',
  } = args;

  if (results.length === 0) {
    return {
      rankedResults: [] as RankedSearchResult[],
      searchAssessment: 'Nenhum resultado foi encontrado para ranquear.',
      gaps: ['Sem resultados web.'],
      suggestedFollowUpQueries: [] as string[],
    };
  }

  const sourceList = results.map((result, index) => ({
    id: index + 1,
    query: result.query,
    title: result.title,
    url: result.url,
    snippet: result.snippet,
  }));

  const response = await getOpenAI().chat.completions.create({
    model,
    messages: [
      {
        role: 'user',
        content: [
          'Rank these web search results for answering an image-identification question.',
          'Use the image-derived clues and user question, but do not treat visual guesses as facts.',
          'Return strict JSON only with this shape:',
          '{"ranked":[{"id":1,"relevance":0,"supportsAnswer":false,"evidence":"...","limitations":["..."]}],"searchAssessment":"...","gaps":["..."],"suggestedFollowUpQueries":["..."]}',
          'relevance is 0-100. Prefer results that connect the exact entity/source/place/product relationship the user asked about.',
          'supportsAnswer must be true only when the result directly helps answer the specific user question. A broad list, generic article, or related category can be relevant but should usually have supportsAnswer=false.',
          'A result can mention a likely entity but still not support the requested relationship.',
          'Do not prefer a source just because it is famous; prefer specific evidence in title/snippet/URL.',
          'Results that are image-recognition tools, app store pages, reverse image search services, generic quizzes, or pages telling the user how to search by image do not answer the image question. Rank them near 0 and supportsAnswer=false.',
          'Keep the assessment natural and useful in Portuguese.',
          question ? `User question: ${question}` : '',
          `Visual summary: ${identification.visualSummary}`,
          `Observed text: ${identification.observedText.join(' | ') || 'none'}`,
          `Notable elements: ${identification.notableElements.join(' | ') || 'none'}`,
          `Likely entities, unverified: ${JSON.stringify(identification.likelyEntities)}`,
          `Search results JSON: ${JSON.stringify(sourceList)}`,
        ].join('\n'),
      },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
  });

  try {
    const parsed = JSON.parse(response.choices[0]?.message?.content || '{}') as {
      ranked?: Array<{
        id?: number;
        relevance?: number;
        supportsAnswer?: boolean;
        evidence?: string;
        limitations?: string[];
      }>;
      searchAssessment?: string;
      gaps?: string[];
      suggestedFollowUpQueries?: string[];
    };

    const rankedResults = (parsed.ranked || [])
      .map((item): RankedSearchResult | null => {
        const source = typeof item.id === 'number' ? results[item.id - 1] : undefined;
        if (!source) return null;

        return {
          ...source,
          relevance: Math.max(0, Math.min(100, Math.round(item.relevance || 0))),
          supportsAnswer: Boolean(item.supportsAnswer),
          evidence: item.evidence || '',
          limitations: Array.isArray(item.limitations) ? item.limitations.filter(Boolean) : [],
        };
      })
      .filter((item): item is RankedSearchResult => Boolean(item))
      .map(item => (isMetaImageRecognitionResult(item)
        ? {
          ...item,
          relevance: Math.min(item.relevance, 5),
          supportsAnswer: false,
          limitations: [...item.limitations, 'Resultado é uma ferramenta/página genérica de reconhecimento de imagem, não uma identificação da imagem.'],
        }
        : item))
      .sort((a, b) => b.relevance - a.relevance);

    return {
      rankedResults,
      searchAssessment: parsed.searchAssessment || '',
      gaps: Array.isArray(parsed.gaps) ? parsed.gaps.filter(Boolean) : [],
      suggestedFollowUpQueries: Array.isArray(parsed.suggestedFollowUpQueries)
        ? parsed.suggestedFollowUpQueries.filter(Boolean)
        : [],
    };
  } catch {
    return {
      rankedResults: results.map(result => ({
        ...result,
        relevance: 0,
        supportsAnswer: false,
        evidence: '',
        limitations: ['Não foi possível ranquear este resultado automaticamente.'],
      })),
      searchAssessment: 'Não consegui ranquear os resultados automaticamente.',
      gaps: ['O ranqueamento retornou JSON inválido.'],
      suggestedFollowUpQueries: [],
    };
  }
}

// Ranking selects candidates; verification decides what is safe to claim.
async function verifyVisualSearchAnswer(args: {
  question?: string;
  identification: VisualIdentification;
  results: RankedSearchResult[];
  searchAssessment?: string;
  gaps?: string[];
  model?: string;
}) {
  const {
    question,
    identification,
    results,
    searchAssessment,
    gaps,
    model = process.env.VISION_SEARCH_MODEL || process.env.VISION_MODEL || 'gpt-4o',
  } = args;

  if (results.length === 0) {
    return {
      answer: 'Não encontrei fontes suficientes para confirmar a identificação da imagem.',
      confidence: 'low',
      verifiedClaims: [],
      warnings: ['Sem resultados de busca suficientes para confirmar a hipótese visual.'],
    };
  }

  const sourceList = results.map((result, index) => ({
    id: index + 1,
    query: result.query,
    title: result.title,
    url: result.url,
    snippet: result.snippet,
    relevance: result.relevance,
    supportsAnswer: result.supportsAnswer,
    evidence: result.evidence,
    limitations: result.limitations,
  }));

  const response = await getOpenAI().chat.completions.create({
    model,
    messages: [
      {
        role: 'user',
        content: [
          'You are verifying an image-identification answer using only search result titles/snippets/URLs.',
          'Return strict JSON only with this shape:',
          '{"answer":"...","confidence":"high|medium|low","verifiedClaims":[{"claim":"...","sourceIds":[1],"evidence":"..."}],"unconfirmedHypotheses":["..."],"conflicts":["..."],"warnings":["..."]}',
          'Do not treat visual guesses as facts. Only state a character, anime, place, product, origin, or source when the provided search results support it.',
          'Never recommend external image-recognition tools, app stores, or reverse-image-search websites as the answer. If the available evidence is insufficient, explain what was checked and what would help.',
          'A broad list of possible matches is not enough to confirm an identity or origin.',
          'Verify the relationship the user asked about. For example, if the user asks what work/source something is from, a source must support the entity and source together.',
          'If sources conflict, mention the uncertainty.',
          'If the sources are too generic or only partially related, say what is confirmed and what is not.',
          'Answer in Portuguese with a natural, direct tone. Avoid robotic phrases like "Não confirmado" by itself; briefly explain what was checked and what is still uncertain.',
          question ? `User question: ${question}` : '',
          `Visual summary: ${identification.visualSummary}`,
          `Observed text: ${identification.observedText.join(' | ') || 'none'}`,
          `Notable visual elements: ${identification.notableElements.join(' | ') || 'none'}`,
          `Search strategy: ${identification.searchStrategy || 'none'}`,
          `Search assessment: ${searchAssessment || 'none'}`,
          `Search gaps: ${(gaps || []).join(' | ') || 'none'}`,
          `Likely visual entities, unverified: ${JSON.stringify(identification.likelyEntities)}`,
          `Visual uncertainties: ${identification.uncertainties.join('; ') || 'none'}`,
          `Search results JSON: ${JSON.stringify(sourceList)}`,
        ].join('\n'),
      },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
  });

  const text = response.choices[0]?.message?.content || '{}';

  try {
    const parsed = JSON.parse(text) as {
      answer?: string;
      confidence?: string;
      verifiedClaims?: Array<{ claim?: string; sourceIds?: number[] }>;
      warnings?: string[];
    };

    return {
      answer: parsed.answer || 'Não consegui confirmar a identificação com as fontes encontradas.',
      confidence: ['high', 'medium', 'low'].includes(parsed.confidence || '') ? parsed.confidence : 'low',
      verifiedClaims: Array.isArray(parsed.verifiedClaims) ? parsed.verifiedClaims : [],
      unconfirmedHypotheses: Array.isArray((parsed as { unconfirmedHypotheses?: string[] }).unconfirmedHypotheses)
        ? (parsed as { unconfirmedHypotheses: string[] }).unconfirmedHypotheses
        : [],
      conflicts: Array.isArray((parsed as { conflicts?: string[] }).conflicts)
        ? (parsed as { conflicts: string[] }).conflicts
        : [],
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    };
  } catch {
    return {
      answer: 'Não consegui confirmar a identificação com segurança.',
      confidence: 'low',
      verifiedClaims: [],
      unconfirmedHypotheses: [],
      conflicts: [],
      warnings: ['A verificação das fontes não retornou JSON válido.'],
    };
  }
}

function addUniqueResults(target: SearchCandidate[], incoming: SearchResult[], query: string, limit: number) {
  for (const result of incoming) {
    if (target.length >= limit) break;
    if (isMetaImageRecognitionResult(result)) continue;

    if (!target.some(existing => existing.url === result.url)) {
      target.push({ ...result, query });
    }
  }
}

function hasEnoughSupportedResults(results: RankedSearchResult[]) {
  return results.some(result => result.supportsAnswer && result.relevance >= 65);
}

export async function analyzeImage(args: {
  imageUrl: string;
  question?: string;
  mode?: AnalyzeMode;
  model?: string;
}) {
  if (!args.imageUrl) {
    return jsonText({ success: false, error: 'imageUrl é obrigatório.' });
  }

  try {
    const analysis = await analyzeImageText(args);
    return jsonText({
      success: true,
      mode: args.mode || 'general',
      analysis,
      instruction: 'Use esta análise para responder em português. Se a imagem tiver texto, cite o texto visível. Se houver incerteza, deixe claro.',
    });
  } catch (error) {
    return jsonText({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// Treat image-derived entities as hypotheses until sources support the exact relation asked.
export async function visualSearchImage(args: {
  imageUrl: string;
  question?: string;
  model?: string;
  limit?: number;
  maxSearchQueries?: number;
}) {
  if (!args.imageUrl) {
    return jsonText({ success: false, error: 'imageUrl é obrigatório.' });
  }

  try {
    const safeLimit = Math.max(1, Math.min(10, Math.floor(args.limit || 6)));
    const identification = await identifyImageForSearch(args);
    const maxSearchQueries = Math.max(1, Math.min(10, Math.floor(args.maxSearchQueries || 8)));
    const queries = buildVisualSearchQueries(identification, args.question, maxSearchQueries);
    const rawResults: SearchCandidate[] = [];
    const attemptedQueries: string[] = [];
    const aggregateLimit = Math.max(safeLimit, maxSearchQueries * 5);

    for (const query of queries) {
      const searchResponse = await searchWeb({ query, limit: 5 });
      const parsed = parseSearchResponse(searchResponse);
      attemptedQueries.push(...parsed.attemptedQueries);
      addUniqueResults(rawResults, parsed.results, query, aggregateLimit);
    }

    let ranking = await rankVisualSearchResults({
      question: args.question,
      identification,
      results: rawResults,
      model: args.model,
    });

    const followUpQueries = ranking.suggestedFollowUpQueries
      .filter(query => !isMetaImageRecognitionText(query))
      .filter(query => !queries.some(existing => normalizeForMatch(existing) === normalizeForMatch(query)))
      .slice(0, Math.max(0, maxSearchQueries - queries.length));

    if (!hasEnoughSupportedResults(ranking.rankedResults) && followUpQueries.length > 0) {
      for (const query of followUpQueries) {
        queries.push(query);
        const searchResponse = await searchWeb({ query, limit: 5 });
        const parsed = parseSearchResponse(searchResponse);
        attemptedQueries.push(...parsed.attemptedQueries);
        addUniqueResults(rawResults, parsed.results, query, aggregateLimit);
      }

      ranking = await rankVisualSearchResults({
        question: args.question,
        identification,
        results: rawResults,
        model: args.model,
      });
    }

    const rankedResults = ranking.rankedResults.length > 0
      ? ranking.rankedResults
      : rawResults.map(result => ({
        ...result,
        relevance: 0,
        supportsAnswer: false,
        evidence: '',
        limitations: ['Resultado não ranqueado.'],
      }));

    const results = rankedResults.slice(0, safeLimit);

    const verification = await verifyVisualSearchAnswer({
      question: args.question,
      identification,
      results,
      searchAssessment: ranking.searchAssessment,
      gaps: ranking.gaps,
      model: args.model,
    });

    return jsonText({
      success: true,
      identification,
      verification,
      searchQueries: queries,
      searchAssessment: ranking.searchAssessment,
      searchGaps: ranking.gaps,
      suggestedFollowUpQueries: ranking.suggestedFollowUpQueries,
      attemptedQueries: [...new Set(attemptedQueries)],
      rawResultCount: rawResults.length,
      rankedResults,
      results,
      markdown: results.map((result, index) => `${index + 1}. [${result.title}](${result.url}) - ${result.snippet}`).join('\n'),
      instruction: 'Responda em português de forma natural e direta usando verification.answer como base. Não apresente likelyEntities como fato se verification.confidence for low ou se as fontes não confirmarem a relação pedida. Use verifiedClaims para afirmar, unconfirmedHypotheses/conflicts/warnings para nuance, e cite links Markdown dos results relevantes. Evite soar robótico: explique rapidamente o que parece ser, o que foi confirmado e o que ficou incerto.',
    });
  } catch (error) {
    return jsonText({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
