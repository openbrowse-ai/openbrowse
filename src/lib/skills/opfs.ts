/**
 * OPFS (Origin Private File System) helpers for skills storage.
 */

async function getOpfsRoot() {
  return await navigator.storage.getDirectory();
}

/**
 * Traverses or creates a directory path in OPFS.
 * @param path e.g., "skills/my-skill/references"
 * @param create If true, creates directories along the way if they don't exist
 */
async function getDirectoryHandle(path: string, create: boolean = false): Promise<FileSystemDirectoryHandle | null> {
  const parts = path.split('/').filter(p => p.length > 0);
  let currentHandle = await getOpfsRoot();

  for (const part of parts) {
    try {
      currentHandle = await currentHandle.getDirectoryHandle(part, { create });
    } catch (e) {
      if ((e as Error).name === 'NotFoundError' && !create) {
        return null;
      }
      throw e;
    }
  }

  return currentHandle;
}

/**
 * Writes content to a file in OPFS, creating intermediate directories if needed.
 * @param filePath e.g., "skills/my-skill/SKILL.md"
 * @param content String or Blob to write
 */
export async function writeOpfsFile(filePath: string, content: string | Blob): Promise<void> {
  const parts = filePath.split('/').filter(p => p.length > 0);
  if (parts.length === 0) throw new Error('Invalid file path');
  
  const fileName = parts.pop()!;
  const dirPath = parts.join('/');
  
  const dirHandle = await getDirectoryHandle(dirPath, true);
  if (!dirHandle) throw new Error(`Could not create directory for ${filePath}`);
  
  const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
  // Type assertion for TS compatibility since OPFS FileSystemWritableFileStream might not be fully typed everywhere
  const writable = await (fileHandle as any).createWritable();
  await writable.write(content);
  await writable.close();
}

/**
 * Reads a file from OPFS as text.
 * @param filePath e.g., "skills/my-skill/SKILL.md"
 */
export async function readOpfsFile(filePath: string): Promise<string> {
  const parts = filePath.split('/').filter(p => p.length > 0);
  if (parts.length === 0) throw new Error('Invalid file path');
  
  const fileName = parts.pop()!;
  const dirPath = parts.join('/');
  
  const dirHandle = await getDirectoryHandle(dirPath, false);
  if (!dirHandle) throw new Error(`File not found: ${filePath}`);
  
  try {
    const fileHandle = await dirHandle.getFileHandle(fileName, { create: false });
    const file = await fileHandle.getFile();
    return await file.text();
  } catch (e) {
    if ((e as Error).name === 'NotFoundError') {
      throw new Error(`File not found: ${filePath}`);
    }
    throw e;
  }
}

/**
 * Deletes a directory and all its contents from OPFS.
 * @param dirPath e.g., "skills/my-skill"
 */
export async function removeOpfsDirectory(dirPath: string): Promise<void> {
  const parts = dirPath.split('/').filter(p => p.length > 0);
  if (parts.length === 0) return; // Cannot delete root
  
  const dirName = parts.pop()!;
  const parentPath = parts.join('/');
  
  const parentHandle = await getDirectoryHandle(parentPath, false);
  if (!parentHandle) return; // Parent doesn't exist, nothing to delete
  
  try {
    // Type assertion for recursive delete which is supported in OPFS but might lack TS types
    await (parentHandle as any).removeEntry(dirName, { recursive: true });
  } catch (e) {
    if ((e as Error).name === 'NotFoundError') {
      return; // Already deleted or never existed
    }
    throw e;
  }
}

/**
 * Checks if a file exists in OPFS.
 */
export async function opfsFileExists(filePath: string): Promise<boolean> {
  try {
    const parts = filePath.split('/').filter(p => p.length > 0);
    if (parts.length === 0) return false;
    
    const fileName = parts.pop()!;
    const dirPath = parts.join('/');
    
    const dirHandle = await getDirectoryHandle(dirPath, false);
    if (!dirHandle) return false;
    
    await dirHandle.getFileHandle(fileName, { create: false });
    return true;
  } catch (e) {
    return false;
  }
}
