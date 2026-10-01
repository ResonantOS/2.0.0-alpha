import { mkdir, open, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export function defaultHarnessStateRoot({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'ResonantOS');
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'ResonantOS');
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'resonantos');
}

// A single bridge owns this store. Each journal phase is a complete atomic file;
// a pending phase survives crashes and cannot be mistaken for committed consent.
export function createHarnessRegistryStore({ userRoot, stateRoot = defaultHarnessStateRoot(), fs = { mkdir, open, rename, rm } } = {}) {
  const repository = resolve(import.meta.dirname, '../..');
  if (typeof userRoot !== 'string' || !isAbsolute(userRoot)) throw new TypeError('External user root required.');
  const fromRepository = relative(repository, resolve(userRoot));
  if (!fromRepository || (fromRepository !== '..' && !fromRepository.startsWith('..' + sep) && !isAbsolute(fromRepository))) {
    throw new TypeError('Governance state must be outside the repository.');
  }
  const directory = join(userRoot, 'harness-governance');
  const path = join(directory, 'registry.json');
  const watermarkDirectory = join(stateRoot, 'harness-governance');
  const key = createHash('sha256').update(resolve(userRoot)).digest('hex').slice(0, 32);
  const watermarkPath = join(watermarkDirectory, `${key}.watermark.json`);
  async function read(path, validate = document => document) {
    try {
      const handle = await fs.open(path, 'r');
      try {
        if ((await handle.stat()).size > 8 * 1024 * 1024) throw new Error('Registry exceeds storage bound.');
        return validate(JSON.parse(await handle.readFile('utf8')));
      } finally { await handle.close(); }
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function watermark() {
    return read(watermarkPath, document => {
      if (document?.version !== 1 || !Number.isSafeInteger(document.revision) || document.revision < 0 || document.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid registry watermark.');
      return document.revision;
    });
  }
  async function write(directory, path, document) {
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
  }
  async function raise(revision) {
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw new TypeError('Watermark revision required.');
    if (revision > (await watermark() ?? -1)) await write(watermarkDirectory, watermarkPath, { version: 1, revision });
  }
  return {
    path,
    watermarkPath,
    read: () => read(path),
    watermark,
    raise,
    async write(document) {
      await write(directory, path, document);
      if (document.phase === 'committed') await raise(document.state.revision);
    },
  };
}
