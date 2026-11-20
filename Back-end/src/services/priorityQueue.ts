export interface PriorityRecalcJob {
  userId: string;
  taskId: string;
  enqueuedAt: number;
}

export type PriorityRecalcHandler = (job: PriorityRecalcJob) => void | Promise<void>;

/**
 * Non-blocking in-process queue for scheduling Phase 6.5A priority recalculations
 * after task mutations without delaying HTTP responses.
 */
export class PriorityRecalcQueue {
  private readonly pendingKeys = new Set<string>();
  private handler: PriorityRecalcHandler;

  constructor(handler?: PriorityRecalcHandler) {
    this.handler = handler ?? (() => {});
  }

  setHandler(handler: PriorityRecalcHandler): void {
    this.handler = handler;
  }

  enqueue(userId: string, taskId: string): boolean {
    const key = `${userId}:${taskId}`;
    if (this.pendingKeys.has(key)) {
      return false;
    }

    this.pendingKeys.add(key);
    const job: PriorityRecalcJob = {
      userId,
      taskId,
      enqueuedAt: Date.now(),
    };

    queueMicrotask(() => {
      this.pendingKeys.delete(key);
      Promise.resolve(this.handler(job)).catch((err) => {
        console.error('[priority-queue] recalculation error:', err);
      });
    });

    return true;
  }
}
