import OpenAI from 'openai';
import sharp from 'sharp';

type OutputKind = 'emoji' | 'sticker';
type FitMode = 'contain' | 'cover';

const OUTPUT_PRESETS = {
  emoji: {
    size: 128,
    maxBytes: 256 * 1024,
    fileName: 'discord-emoji.png',
    label: 'emoji',
  },
  sticker: {
    size: 320,
    maxBytes: 500 * 1024,
    fileName: 'discord-sticker.png',
    label: 'sticker',
  },
} satisfies Record<OutputKind, { size: number; maxBytes: number; fileName: string; label: string }>;

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

function buildStickerPrompt(prompt: string, type: OutputKind) {
  const target = type === 'emoji' ? 'Discord emoji' : 'Discord sticker';
  return [
    `Create a polished ${target} asset.`,
    'Transparent background.',
    'Centered subject, clean silhouette, readable at small size.',
    'High contrast, expressive, no border unless requested.',
    'Do not include text unless the user explicitly requested text.',
    `User request: ${prompt}`,
  ].join(' ');
}

async function fetchImageBuffer(imageUrl: string) {
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

  const contentType = response.headers.get('content-type') || '';
  if (contentType && !contentType.startsWith('image/')) {
    throw new Error(`URL não retornou uma imagem: ${contentType}`);
  }

  const maxInputBytes = 15 * 1024 * 1024;
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > maxInputBytes) {
    throw new Error('Imagem grande demais. Envie uma imagem de até 15 MB.');
  }

  return Buffer.from(arrayBuffer);
}

async function renderCandidate(input: Buffer, options: {
  kind: OutputKind;
  fit: FitMode;
  quality: number;
  compressionLevel: number;
}) {
  const preset = OUTPUT_PRESETS[options.kind];
  const fit = options.fit === 'cover' ? 'cover' : 'contain';

  return sharp(input, { animated: false, failOn: 'none' })
    .rotate()
    .resize(preset.size, preset.size, {
      fit,
      position: 'attention',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      withoutEnlargement: false,
    })
    .ensureAlpha()
    .png({
      palette: true,
      quality: options.quality,
      compressionLevel: options.compressionLevel,
      effort: 10,
      adaptiveFiltering: true,
    })
    .toBuffer();
}

async function optimizeForDiscord(input: Buffer, kind: OutputKind, fit: FitMode) {
  const preset = OUTPUT_PRESETS[kind];
  const attempts = [
    { quality: 100, compressionLevel: 9 },
    { quality: 92, compressionLevel: 9 },
    { quality: 84, compressionLevel: 9 },
    { quality: 76, compressionLevel: 9 },
    { quality: 68, compressionLevel: 9 },
    { quality: 60, compressionLevel: 9 },
  ];

  let best: Buffer | null = null;

  for (const attempt of attempts) {
    const candidate = await renderCandidate(input, { kind, fit, ...attempt });
    if (!best || candidate.byteLength < best.byteLength) best = candidate;
    if (candidate.byteLength <= preset.maxBytes) return candidate;
  }

  if (!best) {
    throw new Error('Não foi possível processar a imagem.');
  }

  if (best.byteLength > preset.maxBytes) {
    throw new Error(`A imagem otimizada ficou com ${best.byteLength} bytes, acima do limite de ${preset.maxBytes} bytes do Discord.`);
  }

  return best;
}

export async function stickerEmojiCreator(args: {
  imageUrl: string;
  type?: OutputKind;
  fit?: FitMode;
  caption?: string;
}) {
  const {
    imageUrl,
    type = 'emoji',
    fit = 'contain',
    caption,
  } = args;

  if (!imageUrl) {
    return jsonText({ error: 'imageUrl é obrigatório.' });
  }

  try {
    const preset = OUTPUT_PRESETS[type];
    const input = await fetchImageBuffer(imageUrl);
    const output = await optimizeForDiscord(input, type, fit);

    return jsonText({
      success: true,
      type,
      fileName: preset.fileName,
      contentType: 'image/png',
      sizeBytes: output.byteLength,
      maxBytes: preset.maxBytes,
      width: preset.size,
      height: preset.size,
      b64_json: output.toString('base64'),
      caption: caption || `${preset.label === 'emoji' ? 'Emoji' : 'Sticker'} otimizado para Discord.`,
      instruction: 'Envie este arquivo diretamente no Discord como anexo. Não envie markdown de imagem nem link duplicado.',
    });
  } catch (error) {
    return jsonText({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function createStickerEmoji(args: {
  prompt: string;
  type?: OutputKind;
  fit?: FitMode;
  caption?: string;
  model?: 'gpt-image-1';
  quality?: 'high' | 'medium' | 'low' | 'auto';
}) {
  const {
    prompt,
    type = 'sticker',
    fit = 'contain',
    caption,
    model = 'gpt-image-1',
    quality = 'auto',
  } = args;

  if (!prompt) {
    return jsonText({ error: 'prompt é obrigatório.' });
  }

  try {
    const preset = OUTPUT_PRESETS[type];
    const response = await getOpenAI().images.generate({
      model,
      prompt: buildStickerPrompt(prompt, type),
      n: 1,
      size: '1024x1024',
      background: 'transparent',
      output_format: 'png',
      ...(quality !== 'auto' ? { quality } : {}),
    } as never);

    const generatedBase64 = response.data?.[0]?.b64_json;
    if (!generatedBase64) {
      throw new Error('A API não retornou dados de imagem.');
    }

    const optimized = await optimizeForDiscord(Buffer.from(generatedBase64, 'base64'), type, fit);

    return jsonText({
      success: true,
      type,
      fileName: preset.fileName,
      contentType: 'image/png',
      sizeBytes: optimized.byteLength,
      maxBytes: preset.maxBytes,
      width: preset.size,
      height: preset.size,
      b64_json: optimized.toString('base64'),
      caption: caption || `${preset.label === 'emoji' ? 'Emoji' : 'Sticker'} criado e otimizado para Discord.`,
      metadata: {
        model,
        quality,
        fit,
        transparentBackground: true,
      },
      instruction: 'Envie este arquivo diretamente no Discord como anexo. Não envie markdown de imagem nem link duplicado.',
    });
  } catch (error) {
    return jsonText({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
