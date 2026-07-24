import {constants} from 'node:fs';
import {open} from 'node:fs/promises';

const NO_FOLLOW = constants.O_NOFOLLOW;

export async function appendUtf8(path: string, contents: string): Promise<void> {
  const file = await open(
    path,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | NO_FOLLOW,
    0o600,
  );
  try {
    await file.writeFile(contents, 'utf8');
  } finally {
    await file.close();
  }
}

export async function readUtf8(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | NO_FOLLOW);
  try {
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}

export async function truncateUtf8(path: string, length: number): Promise<void> {
  const file = await open(path, constants.O_WRONLY | NO_FOLLOW);
  try {
    await file.truncate(length);
  } finally {
    await file.close();
  }
}
