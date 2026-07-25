import {z} from 'zod';

const ConfigSchema = z.object({
  baseUrl: z.string().url().transform(value => value.replace(/\/+$/, '')).refine(value => {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.username === ''
      && url.password === '';
  }, 'API 地址必须是没有凭据的 HTTP(S) 地址'),
  model: z.string().min(1),
  reviewModel: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).default({}),
  timeoutMs: z.number().int().min(1_000).max(300_000).default(60_000),
  contextWindow: z.number().int().min(8_000).default(128_000),
});

export type HaochenConfig = z.infer<typeof ConfigSchema>;

export const parseConfig = (input: unknown): HaochenConfig => ConfigSchema.parse(input);
