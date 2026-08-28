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
  // Write through an existing symlink to its real target: WorkspaceGuard
  // permits symlinks whose target stays inside the workspace, and a plain
  // write follows the link. Without this, the rename would replace the
  // symlink itself with a regular file instead of updating its target.
  let target = abs;
  try {
    target = fs.realpathSync(abs);
  } catch {
    // Dangling symlink or absent target: keep the requested path.
  }
  const directory = path.dirname(target);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    const fd = fs.openSync(temporaryPath, "wx", 0o600);
    try {
      fs.writeFileSync(fd, content, "utf8");
      // The temp inode starts at 0600; copy the destination's mode so the
      // rename does not silently change permissions on existing files
      // (e.g. drop executable bits).
      if (fs.existsSync(target)) {
        fs.fchmodSync(fd, fs.statSync(target).mode & 0o7777);
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporaryPath, target);
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // best effort cleanup
    }
    throw error;
  }
}
