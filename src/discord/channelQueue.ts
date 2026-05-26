const queues = new Map<string, Promise<void>>();

export function enqueueChannelTask(channelId: string, task: () => Promise<void>) {
  const previous = queues.get(channelId) || Promise.resolve();

  // Keep later tasks running even if an earlier message fails.
  const next = previous
    .catch(() => {})
    .then(task)
    .finally(() => {
      if (queues.get(channelId) === next) {
        queues.delete(channelId);
      }
    });

  queues.set(channelId, next);
  return next;
}
