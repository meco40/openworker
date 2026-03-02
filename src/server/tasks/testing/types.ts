export interface CssValidationError {
  message: string;
  line?: number;
  column?: number;
}

export interface ResourceError {
  type: 'image' | 'script' | 'stylesheet' | 'link' | 'other';
  url: string;
  error: string;
}

export interface TestResult {
  passed: boolean;
  deliverable: {
    id: string;
    title: string;
    path: string;
    type: 'file' | 'url';
  };
  httpStatus: number | null;
  consoleErrors: string[];
  consoleWarnings: string[];
  cssErrors: CssValidationError[];
  resourceErrors: ResourceError[];
  screenshotPath: string | null;
  duration: number;
  error?: string;
}

export interface TestResponse {
  taskId: string;
  taskTitle: string;
  passed: boolean;
  results: TestResult[];
  summary: string;
  testedAt: string;
  newStatus?: string;
}

export type TaskTestJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface TaskTestJob {
  id: string;
  taskId: string;
  status: TaskTestJobStatus;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  httpStatus: number | null;
  errorMessage: string | null;
  result: TestResponse | { error: string } | null;
}
