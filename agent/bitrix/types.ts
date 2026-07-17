// completed is the public compatibility name for all closed/terminal tasks.
export type BitrixTaskStatusFilter = "active" | "completed" | "all";

export type BitrixSyncOutcome = "created" | "updated" | "unchanged";

export interface BitrixTaskSummary {
  id: string;
  title: string;
  status: string;
  realStatus: number;
  closed: boolean;
  deadline: string | null;
  role: "responsible" | "accomplice";
  changedAt: string | null;
}

export interface BitrixChecklistItem {
  id: string;
  title: string;
  completed: boolean;
  parentId: string | null;
}

export interface BitrixPerson {
  id: string;
  name: string;
}

export interface BitrixTaskSnapshot {
  task: {
    id: string;
    title: string;
    description: string;
    groupId: string;
    url: string;
    status: string;
    realStatus: number;
    closed: boolean;
    creator: BitrixPerson;
    responsible: BitrixPerson;
    accomplices: BitrixPerson[];
    deadline: string | null;
    changedAt: string | null;
    closedAt: string | null;
    checklist: BitrixChecklistItem[];
  };
  discussion: {
    source: "chat" | "legacy_comments" | "none";
    messages: Array<{
      id: string;
      author: BitrixPerson;
      createdAt: string;
      updatedAt: string | null;
      text: string;
      attachmentCount: number;
    }>;
  };
}

export interface BitrixLocalSearchHit {
  taskId: string;
  snippet: string;
}
