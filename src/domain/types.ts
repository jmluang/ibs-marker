export type UUID = string;
export type ISODateTime = string;
export type Namespace = "local" | `user:${string}`;
export type MealSlot = "breakfast" | "lunch" | "dinner";
export type StoolForm = 1 | 2 | 3 | 4 | 5 | 6 | 7 | "unknown";
export type Severity = "mild" | "moderate" | "severe" | "unknown";
export type SymptomName = "pain" | "bloating" | "urgency" | "nausea" | "other";
export type Discomfort =
  | {
      status: "reported";
      symptoms: { name: SymptomName; severity: Severity }[];
    }
  | { status: "none" | "unknown"; symptoms: [] };
export interface CommonEntry {
  id: UUID;
  kind: "toilet" | "meal" | "symptom";
  occurredAt: ISODateTime;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  estimatedTime: boolean;
  deletedAt: ISODateTime | null;
  note: string;
}
export interface ToiletEntry extends CommonEntry {
  kind: "toilet";
  result: "passed" | "none" | "unsure";
  stoolForms: StoolForm[];
  discomfort: Discomfort;
  startedAt: ISODateTime | null;
  endedAt: ISODateTime | null;
  durationSource: "timer" | "estimated" | "unknown";
  estimatedDurationMinutes: number | null;
  relief: "yes" | "partial" | "no" | "unknown";
}
export interface MealEntry extends CommonEntry {
  kind: "meal";
  status: "eaten" | "skipped";
  slot: MealSlot | "snack";
  foods: string;
  tags: string[];
  portion: "small" | "medium" | "large" | "unknown";
}
export interface SymptomEntry extends CommonEntry {
  kind: "symptom";
  discomfort: Discomfort;
  context: string;
}
export type Entry = ToiletEntry | MealEntry | SymptomEntry;
export interface Settings {
  meals: Record<MealSlot, { time: string; enabled: boolean }>;
  foodTemplates: string[];
  snoozes: Record<string, ISODateTime>;
  remindersEnabled: boolean;
}
export const defaultSettings = (): Settings => ({
  meals: {
    breakfast: { time: "08:00", enabled: true },
    lunch: { time: "12:00", enabled: true },
    dinner: { time: "18:00", enabled: true },
  },
  foodTemplates: [],
  snoozes: {},
  remindersEnabled: false,
});
export interface ActiveTimer {
  id: UUID;
  startedAt: ISODateTime;
  endedAt: ISODateTime | null;
  draft: Partial<ToiletEntry> | null;
}
export interface IdentityToken {
  namespace: Namespace;
  generation: number;
}
export interface OutboxOperation {
  kind: "entry" | "settings";
  resourceId: string;
  changeId: UUID;
  baseVersion: number;
  snapshot: Entry | Settings;
  tombstone: boolean;
}
export interface RemoteResource {
  kind: "entry" | "settings";
  resourceId: string;
  version: number;
  snapshot: Entry | Settings;
  tombstone: boolean;
}
export interface SyncConflict {
  resourceId: string;
  local: OutboxOperation;
  remote: RemoteResource;
}
export type SyncStatus = {
  state: "idle" | "syncing" | "offline" | "auth" | "error" | "conflict";
  message?: string;
};
export interface NamespaceData {
  revision: number;
  editRevisions: Record<string, number>;
  records: Record<string, Entry>;
  settings: Settings;
  versions: Record<string, number>;
  outbox: OutboxOperation[];
  cursor: number;
  timer: ActiveTimer | null;
  drafts: Record<string, unknown>;
  conflicts: SyncConflict[];
}
export interface TrackerSnapshot extends NamespaceData {
  entries: Entry[];
  namespace: Namespace | null;
  generation: number;
  loading: boolean;
  error: string | null;
  syncStatus: SyncStatus;
}
export const emptyData = (): NamespaceData => ({
  revision: 0,
  editRevisions: {},
  records: {},
  settings: defaultSettings(),
  versions: {},
  outbox: [],
  cursor: 0,
  timer: null,
  drafts: {},
  conflicts: [],
});
