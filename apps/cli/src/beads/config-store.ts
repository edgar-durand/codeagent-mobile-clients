import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { restrictToOwner } from '../util/restrict-to-owner';

export function beadsConfigPath(): string {
  return path.join(os.homedir(), '.codeam', 'beads-config.json');
}

interface BeadsConfig { enabled: boolean }

export function readBeadsEnabled(): boolean {
  try {
    const raw = fs.readFileSync(beadsConfigPath(), 'utf8');
    const cfg = JSON.parse(raw) as Partial<BeadsConfig>;
    return cfg.enabled !== false; // absent/true => enabled (default-on)
  } catch {
    return true; // no file => enabled
  }
}

export function persistBeadsConfig(cfg: BeadsConfig): void {
  const file = beadsConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg), { mode: 0o600 });
  fs.renameSync(tmp, file);
  restrictToOwner(file);
}
