import dns from 'dns/promises';
import net from 'net';

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  source?: string;
};

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
  const description = stripHtml(
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i)?.[1]
      || html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["'][^>]*>/i)?.[1]
      || '',
  );

  const text = stripHtml(html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<(p|br|h[1-6]|li|article|section|div)\b/gi, '\n<$1'));

  return {
    title,
    description,
    text: text.slice(0, 12000),
  };
}

async function summarizeOneUrl(rawUrl: string) {
  const safeUrl = await assertSafeUrl(rawUrl);
  const html = await fetchText(safeUrl.toString());
  const content = extractReadableContent(html);

  return {
    ok: true as const,
    url: safeUrl.toString(),
    title: content.title,
    description: content.description,
    text: content.text,
  };
}

export async function searchWeb({ query, limit = 5 }: { query: string; limit?: number }) {
  const safeLimit = Math.max(1, Math.min(5, Math.floor(limit || 5)));
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

  return jsonText({
    query,
    attemptedQueries,
    importantTerms,
    attemptedSources,
    results,
    answerHints: extractAnswerHints(results),
    markdown: results.map((result, index) => `${index + 1}. [${result.title}](${result.url}) — ${result.snippet}`).join('\n'),
    searchErrors,
    instruction: 'Use estes resultados para responder em português com links Markdown descritivos. Se answerHints contiverem o dado pedido, responda o dado diretamente e cite a fonte. Se não contiverem, use summarize_url em até 5 resultados para extrair o valor/conteúdo. Não responda apenas com links. Se results estiver vazio, diga que a busca não encontrou fontes suficientes e peça mais contexto, mencionando apenas de forma breve as consultas tentadas.',
  });
}

export async function summarizeUrl({ url, urls }: { url?: string; urls?: string[] }) {
  const targets = (urls?.length ? urls : url ? [url] : []).slice(0, 5);

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
    instruction: 'Use as páginas bem-sucedidas para responder em português. Se o usuário pediu um dado específico, extraia e informe o dado diretamente, citando a fonte com Markdown. Se algumas URLs falharam, só mencione isso se afetar a resposta.',
  });
}
