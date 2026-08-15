import { z } from 'zod';
import { popupDraftContextSchema } from './popupDraft';
import { popupFormValuesSchema } from './popupForm';
import { publicSettingsSchema, publicSettingsUpdateSchema } from './settings';
import { jobDraftSchema, scrapePayloadSchema } from './schemas';
import { siteTemplateSchema } from './templates/schema';

export const extensionErrorCodeSchema = z.enum([
  'MESSAGE_INVALID',
  'MESSAGE_UNHANDLED',
  'TAB_NOT_FOUND',
  'DOMAIN_NOT_SUPPORTED',
  'EXTRACT_EMPTY',
  'EXTRACT_FAILED',
  'PAYLOAD_INVALID',
  'SETTINGS_INVALID',
  'POPUP_CONTEXT_STALE',
  'STORAGE_FAILED',
]);

export const extensionErrorSchema = z.object({
  code: extensionErrorCodeSchema,
  message: z.string().min(1),
  details: z.string().optional(),
});

export const extractActiveTabRequestSchema = z.object({
  type: z.literal('EXTRACT_ACTIVE_TAB'),
});

export const saveJobRequestSchema = z.object({
  type: z.literal('SAVE_JOB_LOCAL'),
  draft: jobDraftSchema,
});

export const getSettingsRequestSchema = z.object({
  type: z.literal('GET_SETTINGS'),
});

export const saveSettingsRequestSchema = z.object({
  type: z.literal('SAVE_SETTINGS'),
  settings: publicSettingsUpdateSchema,
});

export const getPopupDraftRequestSchema = z.object({
  type: z.literal('GET_POPUP_DRAFT'),
  context: popupDraftContextSchema,
});

export const savePopupDraftRequestSchema = z.object({
  type: z.literal('SAVE_POPUP_DRAFT'),
  context: popupDraftContextSchema,
  values: popupFormValuesSchema,
});

export const clearPopupDraftRequestSchema = z.object({
  type: z.literal('CLEAR_POPUP_DRAFT'),
  context: popupDraftContextSchema,
});

export const startTemplatePickerRequestSchema = z.object({
  type: z.literal('START_TEMPLATE_PICKER'),
});

export const saveSiteTemplateRequestSchema = z.object({
  type: z.literal('SAVE_SITE_TEMPLATE'),
  template: siteTemplateSchema,
});

export const extractionCandidateSchema = z.object({
  value: z.unknown(),
  // 'description' marks taxonomy values derived from scanning the selected
  // job description against the canonical catalog (see jobDraftExtractor).
  source: z.enum([
    'jsonld',
    'dom',
    'meta',
    'visible-text',
    'url',
    'description',
    'template',
  ]),
  confidence: z.enum(['high', 'medium', 'low']),
});

export const extractionCandidatesSchema = z.record(
  z.string(),
  z.array(extractionCandidateSchema).max(20),
);

export const extractActiveTabResponseSchema = z.object({
  type: z.literal('EXTRACT_ACTIVE_TAB_RESULT'),
  ok: z.literal(true),
  draft: jobDraftSchema,
  candidates: extractionCandidatesSchema.optional(),
  applied_template: z
    .object({ id: z.string().uuid(), name: z.string().min(1).max(120) })
    .optional(),
});

export const saveJobResultSchema = z.object({
  action: z.enum(['created', 'updated', 'duplicate_skipped']),
  id: z.number(),
});

export const saveJobResponseSchema = z.object({
  type: z.literal('SAVE_JOB_LOCAL_RESULT'),
  ok: z.literal(true),
  payload: scrapePayloadSchema,
  result: saveJobResultSchema,
});

export const getSettingsResponseSchema = z.object({
  type: z.literal('GET_SETTINGS_RESULT'),
  ok: z.literal(true),
  settings: publicSettingsSchema,
});

export const saveSettingsResponseSchema = z.object({
  type: z.literal('SAVE_SETTINGS_RESULT'),
  ok: z.literal(true),
  settings: publicSettingsSchema,
});

export const getPopupDraftResponseSchema = z.object({
  type: z.literal('GET_POPUP_DRAFT_RESULT'),
  ok: z.literal(true),
  values: popupFormValuesSchema.optional(),
});

export const savePopupDraftResponseSchema = z.object({
  type: z.literal('SAVE_POPUP_DRAFT_RESULT'),
  ok: z.literal(true),
});

export const clearPopupDraftResponseSchema = z.object({
  type: z.literal('CLEAR_POPUP_DRAFT_RESULT'),
  ok: z.literal(true),
});

export const startTemplatePickerResponseSchema = z.object({
  type: z.literal('START_TEMPLATE_PICKER_RESULT'),
  ok: z.literal(true),
});

export const saveSiteTemplateResponseSchema = z.object({
  type: z.literal('SAVE_SITE_TEMPLATE_RESULT'),
  ok: z.literal(true),
  template: siteTemplateSchema,
});

export const extensionErrorResponseSchema = z.object({
  type: z.literal('ERROR'),
  ok: z.literal(false),
  error: extensionErrorSchema,
});

export const extensionMessageSchema = z.discriminatedUnion('type', [
  extractActiveTabRequestSchema,
  saveJobRequestSchema,
  getSettingsRequestSchema,
  saveSettingsRequestSchema,
  getPopupDraftRequestSchema,
  savePopupDraftRequestSchema,
  clearPopupDraftRequestSchema,
  startTemplatePickerRequestSchema,
  saveSiteTemplateRequestSchema,
]);

export const extensionResponseSchema = z.union([
  extractActiveTabResponseSchema,
  saveJobResponseSchema,
  getSettingsResponseSchema,
  saveSettingsResponseSchema,
  getPopupDraftResponseSchema,
  savePopupDraftResponseSchema,
  clearPopupDraftResponseSchema,
  startTemplatePickerResponseSchema,
  saveSiteTemplateResponseSchema,
  extensionErrorResponseSchema,
]);

export type ExtensionErrorCode = z.infer<typeof extensionErrorCodeSchema>;
export type ExtensionMessage = z.infer<typeof extensionMessageSchema>;
export type ExtensionResponse = z.infer<typeof extensionResponseSchema>;
export type SaveJobResult = z.infer<typeof saveJobResultSchema>;
export type ExtractionCandidate = z.infer<typeof extractionCandidateSchema>;
export type ExtractionCandidates = z.infer<typeof extractionCandidatesSchema>;
