import { AttachmentBuilder, Message } from 'discord.js';
import { callMcpTool } from '../mcp/client.js';
import type { WritableTextChannel } from './types.js';
import { editImagePreview, renderImageProgress, sendBase64Image, truncateDiscordContent } from './messageSender.js';
import { logInteraction } from '../utils/logger.js';

type MediaToolResult = {
  imageSent: boolean;
  toolResponse: string;
};

async function waitForImageJob(channel: WritableTextChannel, jobId: string, initialCompleted: number, initialTotal: number) {
  let attempts = 0;
  const maxAttempts = 60;
  const total = initialTotal || 4;
  const loadingMessage: Message | null = await channel.send(renderImageProgress(initialCompleted || 0, total));

  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    attempts++;

    const resultStr = await callMcpTool('get_image_result', { jobId });
    const result = JSON.parse(resultStr);

    if (result.status === 'processing') {
      const progressText = renderImageProgress(result.completed || 0, result.total || total);
      if (loadingMessage) {
        await editImagePreview(loadingMessage, progressText, result.preview_b64_json, 'preview.png');
      }
      continue;
    }

    if (result.status === 'completed' && (result.images?.length || result.b64_json)) {
      return { result, loadingMessage };
    }

    if (result.status === 'failed') {
      throw new Error(`Falha na geração de imagem: ${result.error}`);
    }
  }

  throw new Error(`Timeout ao aguardar resultado do job ${jobId}`);
}

async function handleGeneratedImageResult(args: {
  functionName: string;
  parsed: any;
  channel: WritableTextChannel;
  message: Message;
  toolDetails: string[];
}) {
  const { functionName, parsed, channel, message, toolDetails } = args;

  if (parsed.jobId && parsed.status === 'processing') {
    const { result: jobResult, loadingMessage } = await waitForImageJob(
      channel,
      parsed.jobId,
      parsed.completed || 0,
      parsed.total || 4,
    );

    const attachment = new AttachmentBuilder(Buffer.from(jobResult.b64_json, 'base64'), { name: 'image.png' });
    const payload = {
      content: truncateDiscordContent(jobResult.caption || ''),
      files: [attachment],
      attachments: [],
    };

    await loadingMessage.edit(payload).catch(async () => {
      await channel.send(payload);
    });

    await logInteraction(message, jobResult.caption || `[Imagem ${functionName}]`, [functionName], toolDetails);
    return 'A imagem foi enviada diretamente no Discord. Não envie outra mensagem com link, markdown de imagem ou resumo.';
  }

  if (parsed.success && parsed.b64_json) {
    await sendBase64Image(channel, parsed.b64_json, {
      fileName: parsed.fileName || 'image.png',
      caption: parsed.caption,
    });
    await logInteraction(message, parsed.caption || `[Imagem ${functionName}]`, [functionName], toolDetails);
    return 'A imagem foi enviada diretamente no Discord. Não envie outra mensagem com link, markdown de imagem ou resumo.';
  }

  return null;
}

async function handleStickerEmojiResult(args: {
  functionName: string;
  parsed: any;
  channel: WritableTextChannel;
  message: Message;
  toolDetails: string[];
}) {
  const { functionName, parsed, channel, message, toolDetails } = args;

  if (!parsed.success || !parsed.b64_json) {
    return null;
  }

  await sendBase64Image(channel, parsed.b64_json, {
    fileName: parsed.fileName || (parsed.type === 'sticker' ? 'discord-sticker.png' : 'discord-emoji.png'),
    caption: parsed.caption,
  });

  await logInteraction(message, parsed.caption || `[${parsed.type === 'sticker' ? 'Sticker' : 'Emoji'} pronto]`, [functionName], toolDetails);
  return 'O emoji/sticker foi enviado diretamente no Discord. Não envie outra mensagem com link, markdown de imagem ou resumo.';
}

export async function handleDirectMediaToolResult(args: {
  functionName: string;
  mcpResult: string;
  channel: WritableTextChannel;
  message: Message;
  toolDetails: string[];
}): Promise<MediaToolResult | null> {
  const { functionName, mcpResult, channel, message, toolDetails } = args;

  if (!['create_image', 'edit_image', 'sticker_emoji_creator', 'create_sticker_emoji'].includes(functionName)) {
    return null;
  }

  try {
    const parsed = JSON.parse(mcpResult);
    const toolResponse = functionName === 'create_image' || functionName === 'edit_image'
      ? await handleGeneratedImageResult({ functionName, parsed, channel, message, toolDetails })
      : await handleStickerEmojiResult({ functionName, parsed, channel, message, toolDetails });

    if (!toolResponse) {
      return {
        imageSent: false,
        toolResponse: functionName === 'create_image' || functionName === 'edit_image'
          ? `[Falha ao processar a imagem: ${mcpResult}]`
          : `[Falha ao criar emoji/sticker: ${mcpResult}]`,
      };
    }

    return { imageSent: true, toolResponse };
  } catch {
    return {
      imageSent: false,
      toolResponse: functionName === 'create_image' || functionName === 'edit_image'
        ? `[Erro ao processar resposta de imagem: ${mcpResult}]`
        : `[Erro ao processar resposta de emoji/sticker: ${mcpResult}]`,
    };
  }
}
