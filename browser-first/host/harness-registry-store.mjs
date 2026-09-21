import { mkdir, open, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

// A single bridge owns this store. Each journal phase is a complete atomic file;
// a pending phase survives crashes and cannot be mistaken for committed consent.
export function createHarnessRegistryStore({ userRoot, fs = { mkdir, open, rename, rm } } = {}) {
  const repository = resolve(import.meta.dirname, '../..');
  if (typeof userRoot !== 'string' || !isAbsolute(userRoot)) throw new TypeError('External user root required.');
  const fromRepository = relative(repository, resolve(userRoot));
  if (!fromRepository || (fromRepository !== '..' && !fromRepository.startsWith('..' + sep) && !isAbsolute(fromRepository))) {
    throw new TypeError('Governance state must be outside the repository.');
  }
  const directory = join(userRoot, 'harness-governance');
  const path = join(directory, 'registry.json');
  return {
    path,
    async read() {
      try {
        const handle = await fs.open(path, 'r');
        try {
          if ((await handle.stat()).size > 8 * 1024 * 1024) throw new Error('Registry exceeds storage bound.');
          return JSON.parse(await handle.readFile('utf8'));
        } finally { await handle.close(); }
      } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async write(document) {
      const serialized = JSON.stringify(document);
      if (Buffer.byteLength(serialized) > 8 * 1024 * 1024) throw new Error('Registry exceeds storage bound.');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = join(directory, `.registry-${randomUUID()}.tmp`);
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(serialized, 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(temporary, path);
        // Harden rename durability where supported; the data file is already
        // synced. Other directory I/O errors still prevent acknowledgement.
        let parent;
        try {
          parent = await fs.open(directory, 'r');
          await parent.sync();
        } catch (error) {
          if (!['EISDIR', 'EPERM', 'ENOTSUP', 'EINVAL', 'EBADF'].includes(error.code)) throw error;
        } finally { await parent?.close(); }
      } finally { await fs.rm(temporary, { force: true }); }
    },
  };
}
