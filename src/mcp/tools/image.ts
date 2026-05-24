/**
 * Runs image create/edit requests as process-local jobs so Discord can poll
 * progress and send the final image as an attachment.
 */
import OpenAI from 'openai';
import { toFile } from 'openai/uploads.js';
import sharp from 'sharp';

type ImageJobStatus = 'processing' | 'completed' | 'failed';

interface ImageJob {
  jobId: string;
  status: ImageJobStatus;
  total: number;
  completed: number;
  partialImages: string[];
  preview?: string;
  caption?: string;
  result?: Record<string, unknown>;
  error?: string;
}

const imageJobs = new Map<string, ImageJob>();

let openai: OpenAI | null = null;

function getOpenAI() {
  openai ??= new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  return openai;
}

function generateJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function jsonText(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  };
}

export async function createImage(args: {
  prompt: string;
  caption?: string;
  model?: 'gpt-image-1' | 'dall-e-3' | 'dall-e-2';
  quality?: 'high' | 'medium' | 'low' | 'hd' | 'standard' | 'auto';
  size?: '1024x1024' | '1536x1024' | '1024x1536' | '1792x1024' | '1024x1792' | '256x256' | '512x512' | 'auto';
  background?: 'transparent' | 'opaque' | 'auto';
  style?: 'vivid' | 'natural';
  output_format?: 'png' | 'jpeg' | 'webp';
  output_compression?: number;
  moderation?: 'low' | 'auto';
  partial_images?: number;
}) {
  const {
    prompt,
    caption,
    model = 'gpt-image-1',
    quality = 'auto',
    size = 'auto',
    background = 'auto',
    style,
    output_format = 'png',
    output_compression = 100,
    moderation = 'auto',
    partial_images = 3,
  } = args;

  const jobId = generateJobId();
  const total = model === 'gpt-image-1' ? Math.max(1, Math.min(4, partial_images + 1)) : 1;
  imageJobs.set(jobId, { jobId, status: 'processing', total, completed: 0, partialImages: [], caption });

  // Return a job ID quickly; Discord polls progress separately.
  void (async () => {
    try {
      const params: Record<string, unknown> = { model, prompt, n: 1 };

      if (model === 'gpt-image-1') {
        if (quality !== 'auto') params.quality = quality;
        if (size !== 'auto') params.size = size;
        if (background !== 'auto') params.background = background;
        params.output_format = output_format;
        if (output_compression !== 100) params.output_compression = output_compression;
        if (moderation !== 'auto') params.moderation = moderation;
      }

      if (model === 'dall-e-3') {
        params.size = size === 'auto' ? '1024x1024' : size;
        if (quality === 'hd' || quality === 'standard') params.quality = quality;
        if (style) params.style = style;
        params.response_format = 'b64_json';
      }

      if (model === 'dall-e-2') {
        params.size = ['256x256', '512x512', '1024x1024'].includes(size) ? size : '1024x1024';
        params.response_format = 'b64_json';
      }

      if (model === 'gpt-image-1') {
        const stream = await getOpenAI().images.generate({
          ...params,
          stream: true,
          partial_images: Math.max(0, Math.min(3, partial_images)),
        } as never) as unknown as AsyncIterable<{ type: string; b64_json?: string; partial_image_index?: number }>;

        let finalImage: string | undefined;

        for await (const event of stream) {
          if (event.type === 'image_generation.partial_image' && event.b64_json) {
            const job = imageJobs.get(jobId);
            if (job) {
              job.partialImages[event.partial_image_index ?? job.partialImages.length] = event.b64_json;
              job.preview = event.b64_json;
              job.completed = Math.max(job.completed, job.partialImages.filter(Boolean).length);
            }
          }

          if (event.type === 'image_generation.completed' && event.b64_json) {
            finalImage = event.b64_json;
          }
        }

        if (!finalImage) {
          throw new Error('A API não retornou a imagem final.');
        }

        imageJobs.set(jobId, {
          jobId,
          status: 'completed',
          total,
          completed: total,
          partialImages: imageJobs.get(jobId)?.partialImages ?? [],
          preview: finalImage,
          caption,
          result: {
            success: true,
            b64_json: finalImage,
            caption,
            metadata: { model, quality, size, partialImages: Math.max(0, Math.min(3, partial_images)) },
          },
        });
        return;
      }

      const response = await getOpenAI().images.generate(params as never);
      const b64_json = response.data?.[0]?.b64_json;

      if (!b64_json) {
        throw new Error('A API não retornou dados de imagem.');
      }

      imageJobs.set(jobId, {
        jobId,
        status: 'completed',
        total: 1,
        completed: 1,
        partialImages: [],
        preview: b64_json,
        caption,
        result: {
          success: true,
          b64_json,
          caption,
          metadata: { model, quality, size },
        },
      });
    } catch (error) {
      const job = imageJobs.get(jobId);
      imageJobs.set(jobId, {
        jobId,
        status: 'failed',
        total: job?.total ?? total,
        completed: job?.completed ?? 0,
        partialImages: job?.partialImages ?? [],
        preview: job?.preview,
        caption,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return jsonText({
    jobId,
    status: 'processing',
    total,
    completed: 0,
    message: 'Imagem sendo gerada em streaming. Use get_image_result para acompanhar o progresso.',
  });
}

export async function editImage(args: {
  prompt: string;
  imageUrls: string[];
  caption?: string;
  model?: 'gpt-image-1' | 'dall-e-2';
  background?: 'transparent' | 'opaque' | 'auto';
  input_fidelity?: 'high' | 'low';
  quality?: 'high' | 'medium' | 'low' | 'standard' | 'auto';
  size?: '1024x1024' | '1536x1024' | '1024x1536' | '256x256' | '512x512' | 'auto';
  output_format?: 'png' | 'jpeg' | 'webp';
  output_compression?: number;
  partial_images?: number;
}) {
  const {
    prompt,
    imageUrls,
    caption,
    model = 'gpt-image-1',
    background = 'auto',
    input_fidelity = 'low',
    quality = 'auto',
    size = 'auto',
    output_format = 'png',
    output_compression = 100,
    partial_images = 3,
  } = args;

  if (!imageUrls?.length) {
    return jsonText({ error: 'imageUrls é obrigatório.' });
  }

  if (model === 'dall-e-2' && imageUrls.length > 1) {
    return jsonText({ error: 'dall-e-2 suporta apenas 1 imagem. Use gpt-image-1 para múltiplas imagens.' });
  }

  if (model === 'gpt-image-1' && imageUrls.length > 16) {
    return jsonText({ error: 'Máximo de 16 imagens suportadas.' });
  }

  const jobId = generateJobId();
  const total = model === 'gpt-image-1' ? Math.max(1, Math.min(4, partial_images + 1)) : 1;
  imageJobs.set(jobId, { jobId, status: 'processing', total, completed: 0, partialImages: [], caption });

  // Normalize remote inputs before upload to avoid provider-specific image quirks.
  void (async () => {
    try {
      const sourceBuffers = await Promise.all(
        imageUrls.map(async (url) => {
          if (!url.startsWith('http')) {
            throw new Error(`URL inválida: ${url}`);
          }

          const imageResponse = await fetch(url);
          if (!imageResponse.ok) {
            throw new Error(`Falha ao baixar a imagem de ${url}: ${imageResponse.statusText}`);
          }

          const imageArrayBuffer = await imageResponse.arrayBuffer();
          return sharp(Buffer.from(imageArrayBuffer)).png().toBuffer();
        }),
      );

      const imageFiles = await Promise.all(
        sourceBuffers.map((buffer, sourceIndex) => toFile(buffer, `source_image_${sourceIndex}.png`, { type: 'image/png' })),
      );

      const params: Record<string, unknown> = {
        model,
        image: model === 'dall-e-2' ? imageFiles[0] : imageFiles,
        prompt,
      };

      if (model === 'gpt-image-1') {
        if (background !== 'auto') params.background = background;
        if (input_fidelity !== 'low') params.input_fidelity = input_fidelity;
        if (quality !== 'auto') params.quality = quality;
        if (size !== 'auto') params.size = size;
        params.output_format = output_format;
        if (output_compression !== 100) params.output_compression = output_compression;
      }

      if (model === 'dall-e-2') {
        params.size = ['256x256', '512x512', '1024x1024'].includes(size) ? size : '1024x1024';
        params.response_format = 'b64_json';
      }

      if (model === 'gpt-image-1') {
        const stream = await getOpenAI().images.edit({
          ...params,
          stream: true,
          partial_images: Math.max(0, Math.min(3, partial_images)),
        } as never) as unknown as AsyncIterable<{ type: string; b64_json?: string; partial_image_index?: number }>;

        let finalImage: string | undefined;

        for await (const event of stream) {
          if (event.type === 'image_edit.partial_image' && event.b64_json) {
            const job = imageJobs.get(jobId);
            if (job) {
              job.partialImages[event.partial_image_index ?? job.partialImages.length] = event.b64_json;
              job.preview = event.b64_json;
              job.completed = Math.max(job.completed, job.partialImages.filter(Boolean).length);
            }
          }

          if (event.type === 'image_edit.completed' && event.b64_json) {
            finalImage = event.b64_json;
          }
        }

        if (!finalImage) {
          throw new Error('A API não retornou a imagem final.');
        }

        imageJobs.set(jobId, {
          jobId,
          status: 'completed',
          total,
          completed: total,
          partialImages: imageJobs.get(jobId)?.partialImages ?? [],
          preview: finalImage,
          caption,
          result: {
            success: true,
            b64_json: finalImage,
            caption,
            metadata: { model, imagesUsed: imageUrls.length, quality, size, partialImages: Math.max(0, Math.min(3, partial_images)) },
          },
        });
        return;
      }

      const response = await getOpenAI().images.edit(params as never);
      const b64_json = response.data?.[0]?.b64_json;

      if (!b64_json) {
        throw new Error('A API não retornou dados de imagem.');
      }

      imageJobs.set(jobId, {
        jobId,
        status: 'completed',
        total: 1,
        completed: 1,
        partialImages: [],
        preview: b64_json,
        caption,
        result: {
          success: true,
          b64_json,
          caption,
          metadata: { model, imagesUsed: imageUrls.length, quality, size },
        },
      });
    } catch (error) {
      const job = imageJobs.get(jobId);
      imageJobs.set(jobId, {
        jobId,
        status: 'failed',
        total: job?.total ?? total,
        completed: job?.completed ?? 0,
        partialImages: job?.partialImages ?? [],
        preview: job?.preview,
        caption,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return jsonText({
    jobId,
    status: 'processing',
    total,
    completed: 0,
    message: 'Imagem sendo editada em streaming. Use get_image_result para acompanhar o progresso.',
  });
}

export async function getImageResult({ jobId }: { jobId: string }) {
  const job = imageJobs.get(jobId);

  if (!job) {
    return jsonText({ error: `Job ${jobId} não encontrado. Pode ter expirado.` });
  }

  if (job.status === 'processing') {
    return jsonText({
      jobId,
      status: 'processing',
      completed: job.completed,
      total: job.total,
      progress: job.total > 0 ? Math.round((job.completed / job.total) * 100) : 0,
      preview_b64_json: job.preview,
      partialImages: job.partialImages.filter(Boolean).length,
      message: 'Imagem ainda está sendo processada. Tente novamente em alguns segundos.',
    });
  }

  if (job.status === 'failed') {
    return jsonText({ jobId, status: 'failed', error: job.error });
  }

  imageJobs.delete(jobId);
  return jsonText({ jobId, status: 'completed', completed: job.completed, total: job.total, preview_b64_json: job.preview, ...job.result });
}
