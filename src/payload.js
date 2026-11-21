import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';

/** Check every shipped DLL as well as the executable; corruption fails before launch. */
export async function verifyPayload(root, { platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'win32' || arch !== 'x64') throw new Error('COMPUTER_PRO_PLATFORM: This release supports native Windows x64 only.');
  const manifest = JSON.parse(await readFile(resolve(root, 'payload-manifest.json'), 'utf8'));
  if (manifest.format !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0)
    throw new Error('COMPUTER_PRO_MANIFEST: Missing native payload manifest.');
  const nativeRoot = await realpath(resolve(root, 'native/win-x64'));
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)
        || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || seen.has(entry.path))
      throw new Error('COMPUTER_PRO_MANIFEST: Invalid file entry.');
    seen.add(entry.path);
    const path = await realpath(resolve(nativeRoot, entry.path));
    const local = relative(nativeRoot, path);
    if (!local || local === '..' || local.startsWith('..' + sep) || isAbsolute(local))
      throw new Error('COMPUTER_PRO_MANIFEST: Payload path escapes its directory.');
    const details = await stat(path);
    if (!details.isFile() || details.size !== entry.bytes) throw new Error(`COMPUTER_PRO_INTEGRITY: File size mismatch: ${entry.path}`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest('hex') !== entry.sha256) throw new Error(`COMPUTER_PRO_INTEGRITY: SHA256 mismatch: ${entry.path}`);
  }
  if (!seen.has('dsh-computer-pro-0.2.0.exe')) throw new Error('COMPUTER_PRO_MANIFEST: Executable is missing.');
  return { executable: resolve(nativeRoot, 'dsh-computer-pro-0.2.0.exe'), files: seen.size, upstreamCommit: manifest.upstreamCommit };
}

