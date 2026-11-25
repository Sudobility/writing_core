import { z } from 'zod/v4';
import { HexColor, JsonValue, Timestamp, idSchema } from './primitives.js';
import { TextJSON } from './text.js';
import { ENTITY_KINDS, type EntityKind } from './vocab.js';

export const ATTRIBUTE_KEY_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/;
export const EntityAttributes = z.record(z.string(), JsonValue).superRefine((attrs, ctx) => {
  for (const key of Object.keys(attrs)) {
    if (!ATTRIBUTE_KEY_RE.test(key)) ctx.addIssue({ code: 'custom', path: [key], message: 'invalid attribute key' });
  }
});

const Voice = z.object({
  platformVoiceId: z.string().nullable(), rate: z.number(), pitch: z.number(), volume: z.number(),
  voiceProfileAssetId: idSchema('asset').nullable(),
});

export const CharacterFields = z.strictObject({
  role: z.enum(['lead', 'supporting', 'featured', 'dayPlayer', 'background']).optional(),
  age: z.string().optional(),
  ageMin: z.number().optional(),
  ageMax: z.number().optional(),
  gender: z.string().optional(),
  pronouns: z.string().optional(),
  traits: z.record(idSchema('trt'), z.union([z.string(), z.number()])).optional(),
  voice: Voice.optional(),
  highlightColor: HexColor.nullable().optional(),
  bio: TextJSON.optional(),
  physicalDescription: TextJSON.optional(),
  personality: TextJSON.optional(),
  arc: TextJSON.optional(),
  firstAppearanceOverride: idSchema('el').nullable().optional(),
  castMember: z.string().optional(),
});

export const LocationFields = z.strictObject({
  setting: z.enum(['int', 'ext', 'intExt']).nullable().optional(),
  parentId: idSchema('ent').nullable().optional(),
  period: z.string().optional(),
  region: z.string().optional(),
  setDescription: TextJSON.optional(),
  practicalOrStage: z.enum(['practical', 'stage', 'virtual', 'unknown']).optional(),
  address: z.string().optional(),
  geo: z.object({ lat: z.number(), lng: z.number() }).nullable().optional(),
});

export const ProductionItemFields = z.strictObject({
  characterIds: z.array(idSchema('ent')).optional(),
  quantity: z.number().optional(),
  hero: z.boolean().optional(),
  continuityNotes: z.string().optional(),
});
export const WardrobeFields = z.strictObject({ characterId: idSchema('ent').nullable().optional(), changeNumber: z.number().nullable().optional() });
export const VehicleFields = z.strictObject({
  make: z.string().optional(), model: z.string().optional(), year: z.string().optional(), plate: z.string().optional(),
  characterIds: z.array(idSchema('ent')).optional(),
});
export const AnimalFields = z.strictObject({ species: z.string().optional(), breed: z.string().optional(), handler: z.string().optional() });
export const BackgroundActorFields = z.strictObject({ count: z.number().optional(), description: z.string().optional() });
export const SoundMusicFields = z.strictObject({ cueType: z.enum(['diegetic', 'score', 'source', 'effect']).optional(), licensed: z.boolean().optional() });
const NoFields = z.strictObject({});
// `misc` is the generic escape-hatch kind (e.g. the reserved "Story" entity): it carries app-defined bags such as
// `sceneStoryboards`, so its fields are an open record rather than strictly empty.
const MiscFields = z.record(z.string(), z.unknown());

export const ENTITY_FIELD_SCHEMAS: Record<EntityKind, z.ZodType> = {
  character: CharacterFields, location: LocationFields,
  prop: ProductionItemFields, specialEquipment: ProductionItemFields, setDressing: ProductionItemFields, greenery: ProductionItemFields,
  wardrobe: WardrobeFields, vehicle: VehicleFields, animal: AnimalFields, backgroundActor: BackgroundActorFields,
  sound: SoundMusicFields, music: SoundMusicFields,
  makeupHair: NoFields, specialEffect: NoFields, visualEffect: NoFields, mechanicalEffect: NoFields, stunt: NoFields,
  camera: NoFields, security: NoFields, additionalLabor: NoFields, animalHandler: NoFields, artDepartment: NoFields,
  unit: NoFields, scriptDay: NoFields, sequence: NoFields, misc: MiscFields,
};

export const EntityJSON = z
  .object({
    id: idSchema('ent'),
    kind: z.enum(ENTITY_KINDS),
    name: z.string().min(1),
    nameKey: z.string(),
    aliases: z.array(z.string()),
    color: HexColor.nullable(),
    description: TextJSON,
    fields: z.record(z.string(), z.unknown()),
    attributes: EntityAttributes,
    categoryId: idSchema('cat').nullable(),
    retain: z.boolean(),
    mergedInto: idSchema('ent').nullable(),
    createdBy: z.string(),
    createdAt: Timestamp,
    origin: z.enum(['harvested', 'manual', 'imported']),
  })
  .superRefine((e, ctx) => {
    const r = ENTITY_FIELD_SCHEMAS[e.kind].safeParse(e.fields);
    if (!r.success) for (const issue of r.error.issues) ctx.addIssue({ code: 'custom', path: ['fields', ...issue.path], message: issue.message });
  });
export type EntityJSON = z.infer<typeof EntityJSON>;
