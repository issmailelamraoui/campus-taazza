// Coalesce live signals without delaying them indefinitely or overlapping slow
// snapshots. A signal received during a request queues one following refresh.
export class RefreshQueue {
  constructor(refresh, delay = 150) {
    this.refresh = refresh;
    this.delay = delay;
    this.timer = null;
    this.running = null;
    this.dirty = false;
    this.generation = 0;
  }
  schedule() {
    this.dirty = true;
    if (this.running || this.timer !== null) return;
    this.timer = setTimeout(() => this.run(), this.delay);
  }
  run() {
    this.timer = null;
    this.dirty = false;
    const generation = this.generation;
    const running = Promise.resolve().then(this.refresh).catch(() => {}).finally(() => {
      if (generation !== this.generation || this.running !== running) return;
      this.running = null;
      if (this.dirty) this.schedule();
    });
    this.running = running;
  }
  cancel() {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = null;
    this.running = null;
    this.dirty = false;
  }
}
