import {z} from 'zod';

const BaseUrlSchema = z.string().url().transform(value => value.replace(/\/+$/, '')).refine(value => {
  const url = new URL(value);
  return (url.protocol === 'http:' || url.protocol === 'https:')
    && url.username === ''
    && url.password === '';
}, 'API 地址必须是没有凭据的 HTTP(S) 地址');

const ProfileIdSchema = z.string().trim().min(1);
const AuthenticationHeaderName = /^(?:(?:proxy-)?authorization|(?:x-)?api[-_]?key)$/i;

const ProviderProfileSchema = z.object({
  id: ProfileIdSchema,
  name: z.string().trim().min(1),
  baseUrl: BaseUrlSchema,
  credentialRef: ProfileIdSchema,
  headers: z.record(z.string(), z.string()).default({}),
}).superRefine((provider, context) => {
  for (const header of Object.keys(provider.headers)) {
    if (AuthenticationHeaderName.test(header)) {
      context.addIssue({
        code: 'custom',
        path: ['headers', header],
        message: '认证 Header 不能保存到配置文件',
      });
    }
  }
});

const ModelProfileSchema = z.object({
  id: ProfileIdSchema,
  providerId: ProfileIdSchema,
  modelId: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  contextWindow: z.number().int().min(8_000).default(128_000),
});

const ConfigV2Schema = z.object({
  version: z.literal(2),
  providers: z.array(ProviderProfileSchema),
  models: z.array(ModelProfileSchema),
  activeModelId: ProfileIdSchema.optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).default(60_000),
}).superRefine((config, context) => {
  const providerIds = new Set<string>();
  for (const [index, provider] of config.providers.entries()) {
    if (providerIds.has(provider.id)) {
      context.addIssue({
        code: 'custom',
        path: ['providers', index, 'id'],
        message: '供应商 ID 不能重复',
      });
    }
    providerIds.add(provider.id);
  }

  const modelIds = new Set<string>();
  for (const [index, model] of config.models.entries()) {
    if (modelIds.has(model.id)) {
      context.addIssue({
        code: 'custom',
        path: ['models', index, 'id'],
        message: '模型 ID 不能重复',
      });
    }
    modelIds.add(model.id);

    if (!providerIds.has(model.providerId)) {
      context.addIssue({
        code: 'custom',
        path: ['models', index, 'providerId'],
        message: '模型引用了不存在的供应商',
      });
    }
  }

  if (
    config.activeModelId !== undefined
    && !modelIds.has(config.activeModelId)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['activeModelId'],
      message: '当前模型不存在',
    });
  }
});

const LegacyConfigSchema = z.object({
  baseUrl: BaseUrlSchema,
  model: z.string().trim().min(1),
  reviewModel: z.string().trim().min(1).optional(),
  headers: z.record(z.string(), z.string()).default({}),
  timeoutMs: z.number().int().min(1_000).max(300_000).default(60_000),
  contextWindow: z.number().int().min(8_000).default(128_000),
});

export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;
export type ModelProfile = z.infer<typeof ModelProfileSchema>;
export type HaochenConfig = z.infer<typeof ConfigV2Schema>;

function migrateLegacyConfig(
  legacy: z.infer<typeof LegacyConfigSchema>,
): HaochenConfig {
  const providerId = 'legacy-provider';
  const primaryModelId = 'legacy-primary-model';
  const models: ModelProfile[] = [{
    id: primaryModelId,
    providerId,
    modelId: legacy.model,
    displayName: legacy.model,
    contextWindow: legacy.contextWindow,
  }];

  if (
    legacy.reviewModel !== undefined
    && legacy.reviewModel !== legacy.model
  ) {
    models.push({
      id: 'legacy-review-model',
      providerId,
      modelId: legacy.reviewModel,
      displayName: legacy.reviewModel,
      contextWindow: legacy.contextWindow,
    });
  }

  return {
    version: 2,
    providers: [{
      id: providerId,
      name: new URL(legacy.baseUrl).hostname,
      baseUrl: legacy.baseUrl,
      credentialRef: 'legacy',
      headers: legacy.headers,
    }],
    models,
    activeModelId: primaryModelId,
    timeoutMs: legacy.timeoutMs,
  };
}

const ConfigSchema = z.union([
  ConfigV2Schema,
  LegacyConfigSchema.transform(migrateLegacyConfig).pipe(ConfigV2Schema),
]);

export const parseConfig = (input: unknown): HaochenConfig => ConfigSchema.parse(input);
