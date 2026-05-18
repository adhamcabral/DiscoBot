import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { File } from 'node:buffer';
import { createImage, editImage, getImageResult } from './tools/imageTools.js';
import { searchWeb, summarizeUrl } from './tools/webTools.js';
import { createStickerEmoji, stickerEmojiCreator } from './tools/stickerEmojiTools.js';
import { analyzeImage, visualSearchImage } from './tools/visionTools.js';
import { readDiscordContext, scheduleReminder } from './tools/discordTools.js';

if (!globalThis.File) {
  globalThis.File = File as never;
}

const server = new McpServer({
  name: 'discord-image-tools',
  version: '1.0.0',
});

server.tool(
  'read_discord_context',
  'Busca mensagens anteriores no canal atual do Discord para recuperar contexto além das últimas mensagens já enviadas ao modelo. Use quando o usuário pedir resumo do histórico, procurar algo dito antes, lembrar conversa anterior no canal, ou quando as últimas 20 mensagens não forem contexto suficiente. Não use para buscar na web.',
  {
    limit: z.number().min(1).max(200).default(80).describe('Quantidade máxima de mensagens anteriores a escanear no canal atual. Máximo operacional: 200.'),
    beforeMessageId: z.string().optional().describe('ID de mensagem antes da qual buscar. Se omitido, busca antes da mensagem atual do usuário.'),
    query: z.string().optional().describe('Filtro opcional por texto, nome de anexo, tipo de anexo ou URL de anexo. Use para procurar uma palavra/frase específica no histórico.'),
    authorId: z.string().optional().describe('Filtro opcional por ID do autor da mensagem.'),
    includeBotMessages: z.boolean().default(true).describe('Se false, ignora mensagens de bots.'),
  },
  readDiscordContext,
);

server.tool(
  'schedule_reminder',
  'Agenda, lista ou cancela lembretes persistentes do usuário no Discord. Os lembretes ficam salvos em SQLite e continuam pendentes se o bot desligar antes da data. Use quando o usuário pedir para lembrar/avisar/notificar em uma data ou tempo futuro, ou para ver/cancelar lembretes.',
  {
    action: z.enum(['create', 'list', 'cancel']).default('create').describe('create agenda um lembrete; list lista lembretes pendentes do usuário; cancel cancela um lembrete pelo ID.'),
    text: z.string().optional().describe('Texto do lembrete. Obrigatório para action=create.'),
    dueAt: z.string().optional().describe('Data/hora absoluta do lembrete em ISO 8601 com timezone, por exemplo 2026-05-17T18:30:00-03:00. Use para horários absolutos.'),
    delaySeconds: z.number().min(1).max(31622400).optional().describe('Atraso relativo em segundos. Prefira isto para pedidos como "em 5 minutos", "daqui 2 horas" ou "em 3 dias".'),
    timezone: z.string().optional().describe('Timezone IANA usado para explicar/listar o horário, por exemplo America/Sao_Paulo. Opcional; padrão do bot é usado se omitido.'),
    reminderId: z.string().optional().describe('ID do lembrete. Use para action=cancel quando informado. Se omitido e houver exatamente um lembrete pendente do usuário, a ferramenta cancela esse único lembrete; se houver vários, ela pedirá o ID.'),
    limit: z.number().min(1).max(50).default(20).describe('Quantidade máxima de lembretes a listar para action=list.'),
  },
  scheduleReminder,
);

server.tool(
  'search_web',
  'Pesquisa a web. Use esta ferramenta para notícias, últimas notícias, fatos atuais/recentes, preços, cotações, versões, agendas, placares ou quando o usuário pedir para pesquisar/procurar na internet. Não use ferramentas de imagem para pedidos de notícias, mesmo que exista imagem antiga no histórico, a menos que o usuário peça explicitamente para analisar uma imagem.',
  {
    query: z.string().min(2).describe('Consulta de busca objetiva. Inclua termos principais, entidade, data/local se relevante.'),
    limit: z.number().min(1).max(5).default(5).describe('Quantidade máxima de resultados. Limite operacional: 5.'),
  },
  searchWeb,
);

server.tool(
  'summarize_url',
  'Baixa e extrai o conteúdo legível de até 5 URLs públicas. Se uma fonte falhar, continua tentando as outras.',
  {
    url: z.string().url().optional().describe('URL pública http/https para resumir. URLs locais e redes privadas são bloqueadas.'),
    urls: z.array(z.string().url()).max(5).optional().describe('Até 5 URLs públicas para tentar extrair. Use quando uma busca retornar várias fontes ou quando uma fonte pode falhar.'),
  },
  summarizeUrl,
);

server.tool(
  'analyze_image',
  'Analisa uma imagem anexada ou uma URL de imagem explicitamente relevante ao pedido atual: descreve elementos, lê texto/OCR, explica meme, screenshot, interface, erro visual ou contexto da cena. Não pesquisa na web. Não use para notícias, fatos recentes, pesquisa geral ou perguntas sem referência clara a imagem/foto/print/anexo.',
  {
    imageUrl: z.string().url().describe('URL pública da imagem de origem. Use apenas uma imagem anexada ou uma URL de imagem que o pedido atual esteja claramente pedindo para analisar.'),
    question: z.string().optional().describe('Pergunta específica do usuário sobre a imagem. Não coloque aqui pedidos de notícias ou pesquisa geral.'),
    mode: z.enum(['describe', 'ocr', 'meme', 'screenshot', 'general']).default('general').describe('Tipo de análise visual desejada.'),
    model: z.string().optional().describe('Modelo de visão opcional. Padrão: VISION_MODEL ou gpt-4o-mini.'),
  },
  analyzeImage,
);

server.tool(
  'visual_search_image',
  'Analisa uma imagem anexada/URL e pesquisa na web para identificar lugar, personagem, produto, origem, meme, logo, obra ou contexto visual. Use somente quando o pedido atual depender de identificar algo que aparece numa imagem. Não use para "últimas notícias", pesquisa geral ou fatos recentes sem referência visual clara; nesses casos use search_web.',
  {
    imageUrl: z.string().url().describe('URL pública da imagem de origem. Use apenas uma imagem anexada ou uma URL de imagem que o pedido atual esteja claramente pedindo para identificar.'),
    question: z.string().optional().describe('Pergunta específica sobre a imagem, por exemplo onde é o lugar, quem é o personagem ou de onde veio a imagem. Não use para notícias/pesquisa geral.'),
    model: z.string().optional().describe('Modelo de visão opcional. Padrão: VISION_MODEL ou gpt-4o-mini.'),
    limit: z.number().min(1).max(10).default(6).describe('Quantidade máxima de fontes web ranqueadas retornadas.'),
    maxSearchQueries: z.number().min(1).max(10).default(8).describe('Quantidade máxima de consultas diferentes que a ferramenta pode tentar para confirmar a imagem.'),
  },
  visualSearchImage,
);

server.tool(
  'create_image',
  'Cria uma nova imagem a partir de uma descrição de texto. Use quando o usuário pedir para criar, gerar ou desenhar uma imagem.',
  {
    prompt: z.string().describe('Descrição detalhada da imagem desejada, preferencialmente em inglês.'),
    caption: z.string().optional().describe('Texto opcional em português para acompanhar a imagem no Discord.'),
    model: z.enum(['gpt-image-1', 'dall-e-3', 'dall-e-2']).default('gpt-image-1'),
    quality: z.enum(['high', 'medium', 'low', 'hd', 'standard', 'auto']).default('auto'),
    size: z.enum(['1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792', '256x256', '512x512', 'auto']).default('auto'),
    background: z.enum(['transparent', 'opaque', 'auto']).default('auto'),
    style: z.enum(['vivid', 'natural']).optional(),
    output_format: z.enum(['png', 'jpeg', 'webp']).default('png'),
    output_compression: z.number().min(0).max(100).default(100),
    moderation: z.enum(['low', 'auto']).default('auto'),
    partial_images: z.number().min(0).max(3).default(3).describe('Quantidade de imagens parciais em streaming antes da final. Padrão: 3.'),
  },
  createImage,
);

server.tool(
  'edit_image',
  'Edita ou estende imagens usando IA. Use para transformar estilo, adicionar elementos, remover objetos ou combinar imagens.',
  {
    prompt: z.string().describe('Descrição da edição desejada, preferencialmente em inglês.'),
    imageUrls: z.array(z.string()).describe('URLs das imagens para editar. Use URLs de anexos do Discord no histórico.'),
    caption: z.string().optional().describe('Texto opcional em português para acompanhar a imagem editada.'),
    model: z.enum(['gpt-image-1', 'dall-e-2']).default('gpt-image-1'),
    background: z.enum(['transparent', 'opaque', 'auto']).default('auto'),
    input_fidelity: z.enum(['high', 'low']).default('low'),
    quality: z.enum(['high', 'medium', 'low', 'standard', 'auto']).default('auto'),
    size: z.enum(['1024x1024', '1536x1024', '1024x1536', '256x256', '512x512', 'auto']).default('auto'),
    output_format: z.enum(['png', 'jpeg', 'webp']).default('png'),
    output_compression: z.number().min(0).max(100).default(100),
    partial_images: z.number().min(0).max(3).default(3).describe('Quantidade de imagens parciais em streaming antes da final. Padrão: 3.'),
  },
  editImage,
);

server.tool(
  'get_image_result',
  'Obtém o resultado de uma operação assíncrona criada por create_image ou edit_image.',
  {
    jobId: z.string().describe('ID do job retornado pela tool de imagem.'),
  },
  getImageResult,
);

server.tool(
  'sticker_emoji_creator',
  'Transforma uma imagem existente em emoji ou sticker estático otimizado para Discord. Use quando o usuário pedir sticker, figurinha, emoji, emote ou otimização para Discord.',
  {
    imageUrl: z.string().url().describe('URL pública da imagem de origem. Use anexos do Discord no histórico quando existirem.'),
    type: z.enum(['emoji', 'sticker']).default('emoji').describe('emoji gera PNG 128x128 até 256 KB; sticker gera PNG 320x320 até 500 KB.'),
    fit: z.enum(['contain', 'cover']).default('contain').describe('contain preserva a imagem inteira com fundo transparente; cover corta para preencher o quadrado.'),
    caption: z.string().optional().describe('Texto opcional para acompanhar o arquivo enviado no Discord.'),
  },
  stickerEmojiCreator,
);

server.tool(
  'create_sticker_emoji',
  'Cria do zero um emoji ou sticker estático com fundo transparente e otimizado para Discord. Use quando o usuário pedir para criar/gerar um sticker, figurinha, emoji ou emote sem fornecer imagem.',
  {
    prompt: z.string().min(2).describe('Descrição do sticker/emoji desejado. Pode estar em português; a ferramenta otimiza o prompt internamente.'),
    type: z.enum(['emoji', 'sticker']).default('sticker').describe('emoji gera PNG 128x128 até 256 KB; sticker gera PNG 320x320 até 500 KB.'),
    fit: z.enum(['contain', 'cover']).default('contain').describe('contain preserva a imagem inteira com fundo transparente; cover corta para preencher o quadrado.'),
    caption: z.string().optional().describe('Texto opcional para acompanhar o arquivo enviado no Discord.'),
    model: z.enum(['gpt-image-1']).default('gpt-image-1'),
    quality: z.enum(['high', 'medium', 'low', 'auto']).default('auto'),
  },
  createStickerEmoji,
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stdin.resume();
setInterval(() => undefined, 2147483647);
