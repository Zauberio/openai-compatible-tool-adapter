import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Atomic file write: write to a temp file in the same directory, fsync,
 * then rename over the target. A crash or kill mid-write can never leave a
 * truncated/corrupt file at the target path (the previous content survives
 * until the rename).
 */
export function atomicWriteFileSync(abs: string, content: string): void {
  const directory = path.dirname(abs);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(abs)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    const fd = fs.openSync(temporaryPath, "wx", 0o600);
    try {
      fs.writeFileSync(fd, content, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporaryPath, abs);
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // best effort cleanup
    }
    throw error;
  }
}
