import { randomUUID } from 'node:crypto';
export class Snapshots {
  #shots = new WeakMap();
  constructor({ now = () => performance.now(), ttlMs = 30000 } = {}) { this.now = now; this.ttlMs = ttlMs; }
  save(owner, data) {
    const shot = { ...data, snapshotId: randomUUID(), created: this.now() };
    this.#shots.set(owner, shot); return shot;
  }
  read(owner, id, epoch) {
    const shot = this.#shots.get(owner);
    if (!shot || shot.snapshotId !== id || this.now() - shot.created > this.ttlMs)
      throw new Error('DESKTOP_SNAPSHOT_EXPIRED: capture again');
    if (shot.epoch !== epoch) throw new Error('DESKTOP_STATE_CHANGED: another desktop operation occurred; capture again');
    return shot;
  }
  consume(owner, id, epoch) { const shot = this.read(owner, id, epoch); this.#shots.delete(owner); return shot; }
}
export function imagePoint(shot, point) {
  if (!point || !Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y) || point.x < 0 || point.y < 0 || point.x >= shot.attachment.width || point.y >= shot.attachment.height)
    throw new Error('INVALID_DESKTOP_POINT');
  return { x: shot.desktop.left + Math.min(shot.desktop.width - 1, Math.floor(point.x * shot.desktop.width / shot.attachment.width)),
    y: shot.desktop.top + Math.min(shot.desktop.height - 1, Math.floor(point.y * shot.desktop.height / shot.attachment.height)) };
}
