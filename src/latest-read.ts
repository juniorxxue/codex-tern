/** Coalesce identical reads and discard results (including errors) from older queries. */
export class LatestRead {
  private current?: { key: string; promise: Promise<void> };

  run<T>(key: string, read: () => Promise<T>, commit: (value: T) => void): Promise<void> {
    if (this.current?.key === key) return this.current.promise;
    const request = { key, promise: Promise.resolve() };
    this.current = request;
    request.promise = Promise.resolve().then(read).then(value => {
      if (this.current === request) commit(value);
    }, error => {
      if (this.current === request) throw error;
    }).finally(() => {
      if (this.current === request) this.current = undefined;
    });
    return request.promise;
  }
}
