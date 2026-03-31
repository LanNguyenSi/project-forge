// Input from the project creation form
export interface ProjectInput {
  projectName: string;
  summary: string;
  features: string[];
  constraints: string[];
  targetUsers?: string[];
}

// A single task from planforge output
export interface Task {
  id: string;
  title: string;
  wave: string;
  category: string;
  priority: string;
  summary?: string;
  dependsOn?: string[];
}

export interface ScaffoldPreview {
  status: "full" | "planning-baseline";
  label: string;
  summary: string;
}

export interface ScaffoldFitPreview {
  status: "ok" | "review-recommended" | "mismatch";
  summary: string;
  blueprint: string | null;
  confidence: string | null;
  agentMustCreateStructure: boolean;
  mustReviewBeforeImplementation: boolean;
  followUpTaskPath?: string;
}

// Preview data returned after planforge + scaffoldkit run
export interface GenerationPreview {
  sessionId: string; // UUID for the temp directory
  projectName: string;
  scaffold?: ScaffoldPreview;
  scaffoldFit?: ScaffoldFitPreview;
  tasks: Task[];
  architectureOverview: string; // markdown content
  fileTree: FileTreeNode[];
  taskCount: number;
  waveCount: number;
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
  content?: string; // loaded on demand
}

// Result after GitHub repo creation + push
export interface PublishResult {
  repoUrl: string;
  cloneUrl: string;
  defaultBranch: string;
}

// API response types
export interface GenerateResponse {
  ok: true;
  preview: GenerationPreview;
}

export interface PublishResponse {
  ok: true;
  result: PublishResult;
}

export interface ErrorResponse {
  ok: false;
  error: string;
  details?: string;
}
