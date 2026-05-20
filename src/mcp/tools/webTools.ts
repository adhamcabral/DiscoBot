import dns from 'dns/promises';
import net from 'net';
import OpenAI from 'openai';

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  source?: string;
};

type ReadablePage = {
  ok: true;
  url: string;
  title: string;
  description: string;
  siteName?: string;
  author?: string;
  publishedAt?: string;
  modifiedAt?: string;
  canonicalUrl?: string;
  text: string;
};

type FailedPage = {
  ok: false;
  url: string;
  error: string;
};

type PageResult = ReadablePage | FailedPage;

type ResearchDepth = 'quick' | 'standard' | 'deep';

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

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripHtml(value: string) {
  return decodeHtml(value.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(value: string, maxChars: number) {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3)}...`;
}

function getMetaContent(html: string, names: string[]) {
  for (const name of names) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`<meta[^>]+(?:name|property)=["']${escapedName}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escapedName}["'][^>]*>`, 'i'),
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return stripHtml(match[1]);
    }
  }

  return '';
}

function getLinkHref(html: string, rel: string) {
  const escapedRel = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<link[^>]+rel=["'][^"']*${escapedRel}[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>`, 'i'),
    new RegExp(`<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*${escapedRel}[^"']*["'][^>]*>`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtml(match[1]);
  }

  return '';
}

function normalizeWhitespace(value: string) {
  return value
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function normalizeDuckDuckGoUrl(rawUrl: string) {
  const decoded = decodeHtml(rawUrl);
  try {
    const url = new URL(decoded, 'https://duckduckgo.com');
    const uddg = url.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : url.toString();
  } catch {
    return decoded;
  }
}

function decodePossiblyBase64Url(value: string) {
  const normalized = value.startsWith('a1') ? value.slice(2) : value;
  try {
    return Buffer.from(normalized.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return value;
  }
}

function normalizeBingUrl(rawUrl: string) {
  const decoded = decodeHtml(rawUrl);
  try {
    const url = new URL(decoded, 'https://www.bing.com');
    const target = url.searchParams.get('u');
    if (target) {
      const targetUrl = decodePossiblyBase64Url(target);
      if (/^https?:\/\//i.test(targetUrl)) return targetUrl;
    }

    return url.toString();
  } catch {
    return decoded;
  }
}

function parseDuckDuckGoResults(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const linkPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match: RegExpExecArray | null;

  while ((match = linkPattern.exec(html)) && results.length < limit) {
    const blockStart = match.index;
    const nextStart = html.indexOf('class="result__a"', linkPattern.lastIndex);
    const block = html.slice(blockStart, nextStart === -1 ? undefined : nextStart);

    const snippetMatch = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)
      || block.match(/<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/);

    const result = {
      title: stripHtml(match[2]),
      url: normalizeDuckDuckGoUrl(match[1]),
      snippet: snippetMatch ? stripHtml(snippetMatch[1]) : '',
      source: 'DuckDuckGo',
    };

    const lowerUrl = result.url.toLowerCase();
    if (
      lowerUrl.includes('duckduckgo.com/y.js')
      || lowerUrl.includes('bing.com/aclick')
      || lowerUrl.includes('/aclick?')
    ) {
      continue;
    }

    if (result.title && result.url && !results.some(existing => existing.url === result.url)) {
      results.push(result);
    }
  }

  return results;
}

function parseBingResults(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const itemPattern = /<li[^>]+class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  let match: RegExpExecArray | null;

  while ((match = itemPattern.exec(html)) && results.length < limit) {
    const block = match[1];
    const linkMatch = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i)
      || block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const result = {
      title: stripHtml(linkMatch[2]),
      url: normalizeBingUrl(linkMatch[1]),
      snippet: snippetMatch ? stripHtml(snippetMatch[1]) : '',
      source: 'Bing',
    };

    const lowerUrl = result.url.toLowerCase();
    if (
      lowerUrl.includes('bing.com/aclick')
      || lowerUrl.includes('/aclick?')
      || lowerUrl.includes('microsofttranslator.com')
    ) {
      continue;
    }

    if (result.title && result.url && !results.some(existing => existing.url === result.url)) {
      results.push(result);
    }
  }

  return results;
}

function extractAnswerHints(results: SearchResult[]) {
  return results
    .flatMap((result) => {
      const candidates = [result.snippet, result.title]
        .filter(Boolean)
        .flatMap(text => text.split(/(?<=[.!?])\s+/g));

      return candidates
        .filter(text => /\d/.test(text))
        .map(text => ({
          text,
          sourceTitle: result.title,
          sourceUrl: result.url,
        }));
    })
    .slice(0, 8);
}

function addSearchQuery(queries: string[], query: string) {
  const normalized = query.replace(/\s+/g, ' ').trim();
  if (!normalized) return;

  const key = normalized.toLocaleLowerCase('pt-BR');
  if (!queries.some(existing => existing.toLocaleLowerCase('pt-BR') === key)) {
    queries.push(normalized);
  }
}

function normalizeForSearch(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR');
}

function withCommonBrazilianAccents(query: string) {
  return query.replace(/\bype\b/gi, 'Ypê');
}

function buildSearchQueries(query: string) {
  const queries: string[] = [];
  const normalized = query.replace(/\s+/g, ' ').trim();
  addSearchQuery(queries, normalized);

  const accented = withCommonBrazilianAccents(normalized);
  addSearchQuery(queries, accented);

  const compact = accented
    .replace(/\b(novas?|not[ií]cias?|sobre|me|fale|diga|procure|pesquise|buscar|busque|hoje|agora|o|a|os|as|de|do|da|dos|das)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  addSearchQuery(queries, compact);

  const caseMatch = compact.match(/\bcaso\s+(.+)/i);
  const entity = caseMatch?.[1]?.trim();
  if (entity) {
    addSearchQuery(queries, `caso ${entity}`);
    addSearchQuery(queries, `${entity} caso`);
    addSearchQuery(queries, `${entity} investigação notícia`);
    addSearchQuery(queries, `${entity} notícias recentes`);
  } else if (compact) {
    addSearchQuery(queries, `${compact} notícias recentes`);
  }

  return queries.slice(0, 6);
}

function getImportantTerms(query: string) {
  const accented = withCommonBrazilianAccents(query);
  return normalizeForSearch(accented)
    .split(/[^a-z0-9]+/i)
    .filter(term => term.length >= 3)
    .filter(term => ![
      'nova',
      'novas',
      'novo',
      'novos',
      'noticia',
      'noticias',
      'sobre',
      'fale',
      'diga',
      'procure',
      'pesquise',
      'buscar',
      'busque',
      'hoje',
      'agora',
      'valor',
      'preco',
      'qual',
      'quanto',
      'caso',
    ].includes(term))
    .slice(0, 5);
}

function isRelevantResult(result: SearchResult, importantTerms: string[]) {
  if (importantTerms.length === 0) return true;

  const haystack = normalizeForSearch(`${result.title} ${result.snippet} ${result.url}`);
  return importantTerms.some(term => haystack.includes(term));
}

function addResults(target: SearchResult[], incoming: SearchResult[], limit: number, importantTerms: string[]) {
  for (const result of incoming) {
    if (target.length >= limit) break;
    if (!isRelevantResult(result, importantTerms)) continue;

    const duplicate = target.some(existing => existing.url === result.url || existing.title === result.title);
    if (!duplicate) target.push(result);
  }
}

function isPrivateIp(ip: string) {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    return parts[0] === 10
      || parts[0] === 127
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 169 && parts[1] === 254)
      || parts[0] === 0;
  }

  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    return normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe80:');
  }

  return true;
}

async function assertSafeUrl(rawUrl: string) {
  const url = new URL(rawUrl);

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('A URL precisa usar http ou https.');
  }

  const hostname = url.hostname.toLowerCase();
  if (['localhost', '0.0.0.0'].includes(hostname) || hostname.endsWith('.local')) {
    throw new Error('URL local não é permitida.');
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('IP privado/local não é permitido.');
    return url;
  }

  const addresses = await dns.lookup(hostname, { all: true });
  if (addresses.some(address => isPrivateIp(address.address))) {
    throw new Error('A URL resolve para endereço privado/local e foi bloqueada.');
  }

  return url;
}

async function fetchText(url: string, maxBytes = 1_500_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/') && !contentType.includes('html') && !contentType.includes('xml')) {
      throw new Error(`Tipo de conteúdo não suportado: ${contentType || 'desconhecido'}`);
    }

    if (!response.body) {
      return response.text();
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error('Página grande demais para resumir com segurança.');
      }

      chunks.push(value);
    }

    return new TextDecoder().decode(Buffer.concat(chunks));
  } finally {
    clearTimeout(timeout);
  }
}

function extractReadableContent(html: string) {
  const title = stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const description = getMetaContent(html, ['description', 'og:description', 'twitter:description']);
  const siteName = getMetaContent(html, ['og:site_name', 'application-name']);
  const author = getMetaContent(html, ['author', 'article:author', 'parsely-author']);
  const publishedAt = getMetaContent(html, [
    'article:published_time',
    'datePublished',
    'pubdate',
    'publishdate',
    'DC.date.issued',
  ]);
  const modifiedAt = getMetaContent(html, [
    'article:modified_time',
    'dateModified',
    'lastmod',
    'og:updated_time',
  ]);
  const canonicalUrl = getLinkHref(html, 'canonical');

  const articleMatch = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  const sourceHtml = articleMatch?.[1] || mainMatch?.[1] || html;

  const text = normalizeWhitespace(stripHtml(sourceHtml
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<(p|br|h[1-6]|li|article|section|div|blockquote)\b/gi, '\n<$1')));

  return {
    title,
    description,
    siteName,
    author,
    publishedAt,
    modifiedAt,
    canonicalUrl,
    text: text.slice(0, 22000),
  };
}

async function summarizeOneUrl(rawUrl: string): Promise<ReadablePage> {
  const safeUrl = await assertSafeUrl(rawUrl);
  const html = await fetchText(safeUrl.toString());
  const content = extractReadableContent(html);

  return {
    ok: true as const,
    url: safeUrl.toString(),
    title: content.title,
    description: content.description,
    siteName: content.siteName,
    author: content.author,
    publishedAt: content.publishedAt,
    modifiedAt: content.modifiedAt,
    canonicalUrl: content.canonicalUrl,
    text: content.text,
  };
}

async function collectSearchResults(query: string, limit = 8) {
  const safeLimit = Math.max(1, Math.min(15, Math.floor(limit || 8)));
  const attemptedQueries = buildSearchQueries(query);
  const importantTerms = getImportantTerms(query);
  const attemptedSources: string[] = [];
  const searchErrors: Array<{ source: string; query: string; error: string }> = [];
  const results: SearchResult[] = [];

  for (const searchQuery of attemptedQueries) {
    if (results.length >= safeLimit) break;

    try {
      attemptedSources.push(`DuckDuckGo: ${searchQuery}`);
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
      const html = await fetchText(url, 900_000);
      addResults(results, parseDuckDuckGoResults(html, safeLimit), safeLimit, importantTerms);
    } catch (error) {
      searchErrors.push({
        source: 'DuckDuckGo',
        query: searchQuery,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (results.length >= safeLimit) break;

    try {
      attemptedSources.push(`Bing: ${searchQuery}`);
      const url = `https://www.bing.com/search?q=${encodeURIComponent(searchQuery)}`;
      const html = await fetchText(url, 1_500_000);
      addResults(results, parseBingResults(html, safeLimit), safeLimit, importantTerms);
    } catch (error) {
      searchErrors.push({
        source: 'Bing',
        query: searchQuery,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    query,
    attemptedQueries,
    importantTerms,
    attemptedSources,
    results,
    answerHints: extractAnswerHints(results),
    searchErrors,
  };
}

export async function searchWeb({ query, limit = 8 }: { query: string; limit?: number }) {
  const search = await collectSearchResults(query, Math.max(1, Math.min(10, Math.floor(limit || 8))));

  return jsonText({
    ...search,
    markdown: search.results.map((result, index) => `${index + 1}. [${result.title}](${result.url}) — ${result.snippet}`).join('\n'),
    instruction: 'Use estes resultados como descoberta de fontes. Para notícia/caso em andamento ou quando o usuário pedir contexto, abra 4 a 8 resultados relevantes com summarize_url ou prefira research_web antes de responder, salvo se os snippets já bastarem para um dado simples. Responda em português como redator: texto corrido em parágrafos conectados, proporcional à complexidade, sem tópicos por fonte e sem mini-resumos do tipo "Suspensão:", "Histórico:" salvo pedido explícito. Links Markdown são opcionais se o usuário disser que não precisa, mas se usar links, ancore em 1 ou 2 palavras no máximo e nunca em frases inteiras. Se answerHints contiverem um dado pontual pedido, responda o dado diretamente e cite a fonte quando fizer sentido. Se results estiver vazio, diga que a busca não encontrou fontes suficientes e peça mais contexto, mencionando apenas de forma breve as consultas tentadas. Não use encerramento genérico, piadas, emojis ou metáforas em assunto factual.',
  });
}

export async function summarizeUrl({ url, urls }: { url?: string; urls?: string[] }) {
  const targets = (urls?.length ? urls : url ? [url] : []).slice(0, 10);

  if (targets.length === 0) {
    return jsonText({ error: 'Informe url ou urls.' });
  }

  const pages = [];

  for (const target of targets) {
    try {
      pages.push(await summarizeOneUrl(target));
    } catch (error) {
      pages.push({
        ok: false as const,
        url: target,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return jsonText({
    pages,
    successful: pages.filter(page => page.ok).length,
    failed: pages.filter(page => !page.ok).length,
    instruction: 'Use as páginas bem-sucedidas para responder em português com uma síntese redigida e bem embasada. Para notícias/casos, conecte os fatos entre as fontes: o que aconteceu, quando, causa provável/confirmada, consequências, desdobramentos, divergências e incertezas. Escreva como redator em texto corrido; pode usar mais parágrafos quando o assunto pedir profundidade. Não faça resumo tópico de cada fonte salvo se o usuário pedir. Se usar links Markdown, ancore em 1 ou 2 palavras no máximo no ponto exato que a fonte sustenta; não use URL crua nem frases inteiras como link. Não use encerramento genérico, piadas, emojis ou metáforas em assunto factual. Se algumas URLs falharam, só mencione isso se afetar a resposta.',
  });
}

function sourceNameFromUrl(rawUrl: string) {
  try {
    const hostname = new URL(rawUrl).hostname.replace(/^www\./, '');
    return hostname.split('.').slice(0, -1).join('.') || hostname;
  } catch {
    return 'fonte';
  }
}

function tryParseJsonObject<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    const match = value.match(/\{[\s\S]*\}/);
    if (!match) return fallback;

    try {
      return JSON.parse(match[0]) as T;
    } catch {
      return fallback;
    }
  }
}

async function askJson<T>(args: {
  system?: string;
  prompt: string;
  fallback: T;
  temperature?: number;
}) {
  try {
    const response = await getOpenAI().chat.completions.create({
      model: process.env.RESEARCH_MODEL || process.env.WEB_RESEARCH_MODEL || 'gpt-4o-mini',
      messages: [
        ...(args.system ? [{ role: 'system' as const, content: args.system }] : []),
        { role: 'user' as const, content: args.prompt },
      ],
      temperature: args.temperature ?? 0,
      response_format: { type: 'json_object' },
    });

    return tryParseJsonObject(response.choices[0]?.message?.content || '{}', args.fallback);
  } catch {
    return args.fallback;
  }
}

async function generateResearchQueries(args: {
  query: string;
  context?: string;
  depth: ResearchDepth;
}) {
  const maxQueries = args.depth === 'deep' ? 6 : args.depth === 'standard' ? 4 : 2;
  const fallbackQueries = buildSearchQueries(args.query).slice(0, maxQueries);
  const planned = await askJson<{
    queries?: string[];
    intent?: string;
    freshnessNeeded?: boolean;
  }>({
    system: 'You create web search query plans. Return strict JSON only.',
    prompt: [
      'Crie consultas de busca web para pesquisar a pergunta do usuario.',
      'Use portugues quando fizer sentido, mas inclua nomes proprios/termos exatos.',
      'Evite consultas redundantes. Inclua datas/local se ajudarem.',
      `Profundidade: ${args.depth}. Maximo de consultas: ${maxQueries}.`,
      `Pergunta: ${args.query}`,
      args.context ? `Contexto da conversa: ${truncate(args.context, 1500)}` : '',
      'JSON esperado: {"intent":"...","freshnessNeeded":true,"queries":["..."]}',
    ].filter(Boolean).join('\n'),
    fallback: {
      queries: fallbackQueries,
      intent: args.query,
      freshnessNeeded: true,
    },
  });

  const queries: string[] = [];
  for (const query of [...(planned.queries || []), ...fallbackQueries]) {
    addSearchQuery(queries, query);
  }

  return {
    intent: planned.intent || args.query,
    freshnessNeeded: planned.freshnessNeeded !== false,
    queries: queries.slice(0, maxQueries),
  };
}

function addUniqueSearchResult(target: Array<SearchResult & { query: string }>, incoming: SearchResult[], query: string, limit: number) {
  for (const result of incoming) {
    if (target.length >= limit) break;
    if (target.some(existing => existing.url === result.url)) continue;
    target.push({ ...result, query });
  }
}

async function rankResearchResults(args: {
  query: string;
  results: Array<SearchResult & { query: string }>;
  depth: ResearchDepth;
}) {
  const fallback = args.results.map((result, index) => ({
    id: index + 1,
    score: Math.max(20, 90 - index * 8),
    reason: 'Resultado relevante pelos termos encontrados na busca.',
    shouldRead: index < (args.depth === 'deep' ? 5 : args.depth === 'standard' ? 4 : 2),
  }));

  if (args.results.length === 0) return [];

  const ranked = await askJson<{
    ranked?: Array<{ id?: number; score?: number; reason?: string; shouldRead?: boolean }>;
  }>({
    system: 'You rank search results for web research. Return strict JSON only.',
    prompt: [
      'Rankeie estes resultados para responder a pergunta do usuario.',
      'Priorize fontes que respondem diretamente, tem especificidade, data/atualidade e parecem ser materia/fonte primaria ou jornalistica confiavel.',
      'Penalize resultados superficiais, duplicados, agregadores ou que apenas mencionam o tema.',
      'score vai de 0 a 100. shouldRead=true para paginas que devem ser abertas.',
      `Pergunta: ${args.query}`,
      `Resultados: ${JSON.stringify(args.results.map((result, index) => ({
        id: index + 1,
        query: result.query,
        title: result.title,
        url: result.url,
        snippet: result.snippet,
        source: result.source,
      })))}`,
      'JSON esperado: {"ranked":[{"id":1,"score":90,"reason":"...","shouldRead":true}]}',
    ].join('\n'),
    fallback: { ranked: fallback },
  });

  return (ranked.ranked?.length ? ranked.ranked : fallback)
    .map((item) => {
      const source = typeof item.id === 'number' ? args.results[item.id - 1] : undefined;
      if (!source) return null;
      return {
        ...source,
        rank: item.id!,
        score: Math.max(0, Math.min(100, Math.round(item.score || 0))),
        reason: item.reason || '',
        shouldRead: Boolean(item.shouldRead),
      };
    })
    .filter((item): item is SearchResult & { query: string; rank: number; score: number; reason: string; shouldRead: boolean } => Boolean(item))
    .sort((a, b) => b.score - a.score);
}

function extractFallbackClaims(page: ReadablePage, sourceId: number) {
  const sentences = [page.description, page.text]
    .filter(Boolean)
    .join(' ')
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 40)
    .slice(0, 4);

  return sentences.map(sentence => ({
    claim: sentence,
    sourceIds: [sourceId],
    confidence: 'medium',
  }));
}

async function synthesizeResearch(args: {
  query: string;
  depth: ResearchDepth;
  pages: ReadablePage[];
  rankedResults: Awaited<ReturnType<typeof rankResearchResults>>;
}) {
  const sources = args.pages.map((page, index) => ({
    id: index + 1,
    title: page.title || sourceNameFromUrl(page.url),
    url: page.url,
    siteName: page.siteName || sourceNameFromUrl(page.url),
    author: page.author,
    publishedAt: page.publishedAt,
    modifiedAt: page.modifiedAt,
    description: page.description,
    text: truncate(page.text, args.depth === 'deep' ? 11000 : args.depth === 'standard' ? 8000 : 5000),
  }));

  const fallbackClaims = args.pages.flatMap((page, index) => extractFallbackClaims(page, index + 1)).slice(0, 12);
  const fallback = {
    answerDraft: '',
    keyFindings: fallbackClaims.map(claim => claim.claim).slice(0, 6),
    claims: fallbackClaims,
    timeline: [],
    conflicts: [],
    gaps: args.pages.length === 0 ? ['Nenhuma pagina foi lida com sucesso.'] : [],
    sourceNotes: sources.map(source => ({
      sourceId: source.id,
      title: source.title,
      url: source.url,
      whyUseful: source.description || 'Fonte aberta durante a pesquisa.',
    })),
  };

  if (sources.length === 0) return fallback;

  return askJson<{
    answerDraft?: string;
    keyFindings?: string[];
    claims?: Array<{ claim?: string; sourceIds?: number[]; confidence?: string }>;
    timeline?: Array<{ date?: string; event?: string; sourceIds?: number[] }>;
    conflicts?: string[];
    gaps?: string[];
    sourceNotes?: Array<{ sourceId?: number; title?: string; url?: string; whyUseful?: string }>;
  }>({
    system: 'You synthesize web research into structured evidence. Return strict JSON only.',
    prompt: [
      'Sintetize a pesquisa abaixo em portugues, usando somente as fontes fornecidas.',
      'Extraia fatos verificaveis, datas, numeros, causas, consequencias, desdobramentos, conflitos e lacunas.',
      'Nao invente. Se algo nao estiver claro, coloque em gaps ou conflicts.',
      'answerDraft deve ser um rascunho natural para Discord, em estilo de redator: texto corrido, paragrafos conectados, sem bullets/topicos por fonte e proporcional a complexidade da pesquisa. Pode ter varios paragrafos quando o tema precisar de contexto; seja curto apenas para perguntas simples.',
      'Nao termine com frase generica de oferta de ajuda. Nao use piadas, emojis ou metaforas em assunto factual.',
      'Cada claim importante deve apontar sourceIds.',
      `Pergunta: ${args.query}`,
      `Fontes abertas: ${JSON.stringify(sources)}`,
      'JSON esperado: {"answerDraft":"...","keyFindings":["..."],"claims":[{"claim":"...","sourceIds":[1],"confidence":"high|medium|low"}],"timeline":[{"date":"...","event":"...","sourceIds":[1]}],"conflicts":["..."],"gaps":["..."],"sourceNotes":[{"sourceId":1,"title":"...","url":"...","whyUseful":"..."}]}',
    ].join('\n'),
    fallback,
  });
}

export async function researchWeb({
  query,
  context,
  depth = 'standard',
  limit,
}: {
  query: string;
  context?: string;
  depth?: ResearchDepth;
  limit?: number;
}) {
  const safeDepth: ResearchDepth = ['quick', 'standard', 'deep'].includes(depth) ? depth : 'standard';
  const resultLimit = Math.max(5, Math.min(18, Math.floor(limit || (safeDepth === 'deep' ? 15 : safeDepth === 'standard' ? 12 : 8))));
  const readLimit = safeDepth === 'deep' ? 8 : safeDepth === 'standard' ? 6 : 4;
  const queryPlan = await generateResearchQueries({ query, context, depth: safeDepth });
  const aggregateResults: Array<SearchResult & { query: string }> = [];
  const searchDiagnostics = [];

  for (const searchQuery of queryPlan.queries) {
    const search = await collectSearchResults(searchQuery, resultLimit);
    searchDiagnostics.push({
      query: searchQuery,
      attemptedQueries: search.attemptedQueries,
      results: search.results.length,
      errors: search.searchErrors,
    });
    addUniqueSearchResult(aggregateResults, search.results, searchQuery, resultLimit * 2);
  }

  const rankedResults = await rankResearchResults({ query, results: aggregateResults, depth: safeDepth });
  const urlsToRead = rankedResults
    .filter(result => result.shouldRead)
    .slice(0, readLimit);
  const fallbackUrls = rankedResults
    .filter(result => !urlsToRead.some(selected => selected.url === result.url))
    .slice(0, Math.max(0, readLimit - urlsToRead.length));
  const selectedResults = [...urlsToRead, ...fallbackUrls].slice(0, readLimit);
  const pages: PageResult[] = [];

  for (const result of selectedResults) {
    try {
      pages.push(await summarizeOneUrl(result.url));
    } catch (error) {
      pages.push({
        ok: false,
        url: result.url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const successfulPages = pages.filter((page): page is ReadablePage => page.ok);
  const synthesis = await synthesizeResearch({ query, depth: safeDepth, pages: successfulPages, rankedResults });
  const sources = successfulPages.map((page, index) => ({
    id: index + 1,
    title: page.title || sourceNameFromUrl(page.url),
    url: page.url,
    siteName: page.siteName || sourceNameFromUrl(page.url),
    author: page.author,
    publishedAt: page.publishedAt,
    modifiedAt: page.modifiedAt,
    description: page.description,
    excerpt: truncate(page.text, 1800),
  }));

  return jsonText({
    success: successfulPages.length > 0 || rankedResults.length > 0,
    query,
    depth: safeDepth,
    queryPlan,
    searchedResults: rankedResults.slice(0, resultLimit).map(result => ({
      title: result.title,
      url: result.url,
      snippet: result.snippet,
      query: result.query,
      score: result.score,
      reason: result.reason,
      selectedForReading: selectedResults.some(selected => selected.url === result.url),
    })),
    searchDiagnostics,
    sources,
    failedSources: pages.filter((page): page is FailedPage => !page.ok),
    synthesis,
    citationGuidance: sources.map(source => ({
      sourceId: source.id,
      label: source.siteName,
      markdown: `[${source.siteName}](${source.url})`,
    })),
    instruction: 'Use synthesis.answerDraft, claims e sources para responder em portugues. Para perguntas de noticia/caso/pesquisa, responda como redator: texto corrido em paragrafos conectados, aprofundado conforme o assunto pedir, com contexto, cronologia e nuances. Seja breve apenas se o usuario pedir algo simples ou se a pergunta for pontual. Nao responda como lista por fonte, nem com topicos tipo "Suspensao:", "Historico:" salvo pedido explicito. Se o usuario pediu sem links, nao inclua links; se nao pediu sem links, links Markdown sao opcionais e devem ficar em 1 ou 2 palavras no maximo no ponto sustentado pela fonte. Use claims com sourceIds para decidir onde citar dinamicamente. Se gaps/conflicts existirem e forem relevantes, mencione a incerteza de forma natural. Nao use encerramento generico, piadas, emojis ou metaforas em assunto factual. Esta pesquisa fica disponivel na memoria recente do canal para follow-ups e pedidos posteriores de fontes.',
  });
}

export async function verifyWebClaim({
  claim,
  question,
  context,
  depth = 'standard',
  limit,
}: {
  claim: string;
  question?: string;
  context?: string;
  depth?: ResearchDepth;
  limit?: number;
}) {
  const safeDepth: ResearchDepth = ['quick', 'standard', 'deep'].includes(depth) ? depth : 'standard';
  const maxChecks = safeDepth === 'deep' ? 6 : safeDepth === 'standard' ? 4 : 2;
  const verificationPlan = await askJson<{
    coreQuestion?: string;
    requiredChecks?: Array<{ question?: string; purpose?: string; priority?: number }>;
    answerNeeds?: string[];
  }>({
    system: 'You plan factual verification research. Return strict JSON only.',
    prompt: [
      'Crie um plano de verificacao factual para responder perfeitamente a pergunta do usuario.',
      'Nao faca plano especifico para um dominio; decomponha genericamente a afirmacao em fatos necessarios.',
      'Inclua subperguntas para identificar entidades/cargos, periodo relevante, pessoas envolvidas, origem da nomeacao/decisao, composicao do orgao/equipe e fontes oficiais quando isso for relevante.',
      'Cada subpergunta deve ser pesquisavel na web e ajudar a confirmar/refutar a afirmacao.',
      `Maximo de subpesquisas: ${maxChecks}.`,
      `Claim: ${claim}`,
      question ? `Pergunta original: ${question}` : '',
      context ? `Contexto: ${truncate(context, 2000)}` : '',
      'JSON esperado: {"coreQuestion":"...","requiredChecks":[{"question":"...","purpose":"...","priority":1}],"answerNeeds":["..."]}',
    ].filter(Boolean).join('\n'),
    fallback: {
      coreQuestion: question || claim,
      requiredChecks: [
        { question: question || claim, purpose: 'Verificar diretamente a afirmação principal.', priority: 1 },
      ],
      answerNeeds: ['Confirmar ou refutar a afirmação com fonte explícita.'],
    },
  });

  const plannedQueries: string[] = [];
  const addPlannedQuery = (value?: string) => {
    const normalized = value?.replace(/\s+/g, ' ').trim();
    if (!normalized) return;
    if (!plannedQueries.some(existing => existing.toLocaleLowerCase('pt-BR') === normalized.toLocaleLowerCase('pt-BR'))) {
      plannedQueries.push(normalized);
    }
  };

  addPlannedQuery(verificationPlan.coreQuestion || question || claim);
  for (const check of (verificationPlan.requiredChecks || [])
    .sort((a, b) => (a.priority || 99) - (b.priority || 99))) {
    addPlannedQuery(check.question);
  }
  addPlannedQuery(claim);

  const researchRuns = [];
  for (const plannedQuery of plannedQueries.slice(0, maxChecks)) {
    const result = await researchWeb({
      query: plannedQuery,
      context,
      depth: plannedQuery === plannedQueries[0] ? safeDepth : 'quick',
      limit: limit || (safeDepth === 'deep' ? 12 : 8),
    });
    const text = result.content[0]?.text || '{}';
    try {
      researchRuns.push(JSON.parse(text));
    } catch {
      researchRuns.push({ query: plannedQuery, success: false, error: 'Resultado de pesquisa não veio em JSON válido.' });
    }
  }

  const combinedSources = researchRuns.flatMap((run: any, runIndex: number) => (
    Array.isArray(run.sources) ? run.sources.map((source: any) => ({
      globalId: `${runIndex + 1}.${source.id}`,
      runIndex: runIndex + 1,
      sourceId: source.id,
      query: run.query,
      title: source.title,
      siteName: source.siteName,
      url: source.url,
      publishedAt: source.publishedAt,
      modifiedAt: source.modifiedAt,
      description: source.description,
      excerpt: typeof source.excerpt === 'string' ? truncate(source.excerpt, 1200) : undefined,
    })) : []
  ));

  const compactResearch = researchRuns.map((run: any, index: number) => ({
    runIndex: index + 1,
    query: run.query,
    depth: run.depth,
    queryPlan: run.queryPlan,
    sources: Array.isArray(run.sources)
      ? run.sources.map((source: any) => ({
        sourceRef: `${index + 1}.${source.id}`,
        title: source.title,
        siteName: source.siteName,
        url: source.url,
        publishedAt: source.publishedAt,
        modifiedAt: source.modifiedAt,
        description: source.description,
        excerpt: typeof source.excerpt === 'string' ? truncate(source.excerpt, 1200) : undefined,
      }))
      : [],
    synthesis: run.synthesis,
    failedSources: run.failedSources,
  }));


  const verdict = await askJson<{
    verdict?: 'supported' | 'contradicted' | 'unclear';
    confidence?: 'high' | 'medium' | 'low';
    answer?: string;
    supportedClaims?: Array<{ claim?: string; sourceRefs?: string[]; evidence?: string }>;
    contradictedClaims?: Array<{ claim?: string; sourceRefs?: string[]; evidence?: string }>;
    missingEvidence?: string[];
    followUpSearches?: string[];
  }>({
    system: 'You verify factual claims using only provided research sources. Return strict JSON only.',
    prompt: [
      'Verifique a afirmacao/pergunta usando somente as pesquisas fornecidas.',
      'Nao use conhecimento interno. Se a pesquisa nao prova nem refuta, verdict deve ser "unclear".',
      'Para cargos atuais, nomeacoes, datas, autoria, diretorias, governos e relacoes politicas, exija fonte explicita.',
      'Se a pergunta tiver varias partes, responda cada parte relevante: quem era, quem nomeou/indicou, periodo, composicao, e se isso confirma ou nao a afirmacao original.',
      'Nao pare no primeiro "sim" ou "nao"; use as subpesquisas para explicar o quadro factual completo.',
      'Se houver conflito entre fontes, explique em contradictedClaims ou missingEvidence.',
      `Claim: ${claim}`,
      question ? `Pergunta do usuario: ${question}` : '',
      `Plano de verificacao: ${JSON.stringify(verificationPlan)}`,
      `Pesquisas JSON: ${JSON.stringify(compactResearch)}`,
      'JSON esperado: {"verdict":"supported|contradicted|unclear","confidence":"high|medium|low","answer":"...","supportedClaims":[{"claim":"...","sourceRefs":["1.1"],"evidence":"..."}],"contradictedClaims":[{"claim":"...","sourceRefs":["2.1"],"evidence":"..."}],"missingEvidence":["..."],"followUpSearches":["..."]}',
    ].filter(Boolean).join('\n'),
    fallback: {
      verdict: 'unclear',
      confidence: 'low',
      answer: 'Não encontrei evidência suficiente nas fontes abertas para confirmar isso com segurança.',
      supportedClaims: [],
      contradictedClaims: [],
      missingEvidence: ['A verificação automática não conseguiu estruturar evidências suficientes.'],
      followUpSearches: [],
    },
  });

  return jsonText({
    success: researchRuns.some((run: any) => run.success),
    claim,
    question: question || null,
    verificationPlan,
    researchRuns: compactResearch,
    verdict,
    sources: combinedSources,
    citationGuidance: combinedSources.map(source => ({
      sourceRef: source.globalId,
      label: source.siteName || source.title || 'fonte',
      markdown: `[${source.siteName || source.title || 'fonte'}](${source.url})`,
    })),
    instruction: 'Responda em portugues usando verdict.answer, researchRuns e sources. Seja investigativo e redacional: explique o quadro factual necessario para responder em paragrafos conectados, nao apenas "sim" ou "nao", salvo se o usuario pediu uma resposta curta. Se verdict for unclear ou confidence low, nao confirme a afirmacao; diga exatamente o que foi e nao foi confirmado. Para cargos, nomeacoes, datas e pessoas, so afirme nomes quando houver fonte explicita. Se usar links Markdown, ancore em 1 ou 2 palavras no maximo no ponto sustentado pela fonte. Nao use bullets por fonte, encerramento generico, piadas, metaforas ou emojis em verificacoes factuais.',
  });
}
